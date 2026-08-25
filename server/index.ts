import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import sharp from 'sharp'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveLinkPreview, captureImageItem, captureTextItem, captureVideoItem } from './capture.js'
import { extractDateIntent, filterItemsByDate, type DateField } from '../src/date-search.js'
import { canonicalLink, linkFingerprint } from './dedupe.js'
import { dismissAssistantAction, runAssistant, takeAssistantAction } from './assistant.js'
import { deleteConversation, getConversation, listConversations, saveExchange } from './conversations.js'
import { fetchLinkPreview, fetchValidatedImage, normaliseWebUrl } from './link-preview.js'
import { ensureSearchIndex, searchItems, searchItemsByColour } from './search-index.js'
import { createSharingRouter } from './sharing.js'
import { createSpace, deleteSpace, listSpaces, reorderSpaces, updateSpace } from './spaces.js'
import { createTelegramPrivateRouter, createTelegramPublicRouter } from './telegram.js'
import { createAppleShortcutPrivateRouter, createAppleShortcutPublicRouter } from './apple-shortcut.js'
import { recallTasteProfile } from './taste-profile.js'
import {
  authenticate,
  deleteMemoryItem,
  DuplicateMemoryItemError,
  findDuplicateMemoryItem,
  insertMemoryItem,
  listMemoryItems,
  removePrivateImage,
  updateMemoryItem,
  updateMemoryItemPreview,
  type AuthContext,
  type MemoryPatch,
} from './supabase.js'
import type { MemoryItem } from '../src/types.js'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 8 },
  fileFilter: (_request, file, callback) => callback(null, supportedImageTypes.has(file.mimetype)),
})

const assistantUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 8 },
  fileFilter: (_request, file, callback) => callback(null, supportedImageTypes.has(file.mimetype)),
})

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    auth: Boolean((process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL) && (process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY)),
    database: 'supabase',
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
    provider: 'anthropic',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    semanticSearch: Boolean(process.env.VOYAGE_API_KEY),
    searchProvider: 'voyage',
    searchModel: process.env.VOYAGE_MODEL ?? 'voyage-4',
  })
})

app.use('/api', createTelegramPublicRouter())
app.use('/api', createAppleShortcutPublicRouter())

app.get('/api/extension/config', (_request, response) => {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) return response.status(503).json({ error: 'Kept authentication is unavailable.' })
  response.json({ supabaseUrl, supabaseAnonKey })
})

app.use('/api', async (request, response, next) => {
  const authorization = request.header('authorization') ?? ''
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!accessToken) return response.status(401).json({ error: 'Sign in to access your Kept library.' })
  try {
    response.locals.auth = await authenticate(accessToken)
    next()
  } catch (error) {
    response.status(401).json({ error: error instanceof Error ? error.message : 'Your session is invalid.' })
  }
})

app.use('/api', createSharingRouter())
app.use('/api', createTelegramPrivateRouter())
app.use('/api', createAppleShortcutPrivateRouter())

function auth(response: express.Response) {
  return response.locals.auth as AuthContext
}

function reportFailure(response: express.Response, error: unknown, fallback: string, status = 503) {
  console.warn(`${fallback}:`, error instanceof Error ? error.message : 'Unknown error')
  response.status(status).json({ error: error instanceof Error ? error.message : fallback })
}

const matchStopWords = new Set(['and', 'are', 'for', 'from', 'into', 'that', 'the', 'this', 'those', 'with', 'worth', 'later', 'future', 'could'])

function matchTerms(value: string) {
  return new Set((value.toLowerCase().normalize('NFKD').match(/[a-z0-9]{3,}/g) ?? []).flatMap((word) => {
    if (matchStopWords.has(word)) return []
    if (word.length > 5 && word.endsWith('ies')) return [`${word.slice(0, -3)}y`]
    if (word.length > 4 && word.endsWith('s')) return [word.slice(0, -1)]
    return [word]
  }))
}

function fallbackSpaceMatches(space: { name: string; description: string }, items: MemoryItem[]) {
  const nameTerms = matchTerms(space.name)
  const descriptionTerms = matchTerms(space.description)
  return items.flatMap((item) => {
    const itemTerms = matchTerms([item.title, item.description, ...item.tags, ...item.searchTerms, item.domain ?? ''].join(' '))
    const nameHits = [...nameTerms].filter((term) => itemTerms.has(term)).length
    const descriptionHits = [...descriptionTerms].filter((term) => itemTerms.has(term)).length
    if (!nameHits && descriptionHits < 2) return []
    return [{ id: item.id, relevance: Math.min(92, 42 + nameHits * 18 + descriptionHits * 6) }]
  }).sort((left, right) => right.relevance - left.relevance)
}

function parseAssistantRequest(request: express.Request) {
  const parseArray = (value: unknown) => {
    if (typeof value !== 'string') return []
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  const message = typeof request.body.message === 'string' ? request.body.message.trim().slice(0, 4_000) : ''
  const history = parseArray(request.body.history).slice(-8).flatMap((turn) => {
    if (!turn || typeof turn !== 'object') return []
    const role = 'role' in turn && (turn.role === 'user' || turn.role === 'assistant') ? turn.role : undefined
    const content = 'content' in turn && typeof turn.content === 'string' ? turn.content.trim().slice(0, 2_000) : ''
    return role && content ? [{ role, content }] : []
  })
  const attachmentItemIds = parseArray(request.body.attachmentItemIds).filter((id): id is string => typeof id === 'string').slice(0, 4)
  const conversationId = typeof request.body.conversationId === 'string' && /^[0-9a-f-]{36}$/i.test(request.body.conversationId)
    ? request.body.conversationId
    : undefined
  return { message, history, attachmentItemIds, conversationId }
}

function assistantFailure(error: unknown) {
  console.warn('The assistant is temporarily unavailable.:', error instanceof Error ? error.message : 'Unknown error')
  return error instanceof Error && /^(The assistant|That conversation)/.test(error.message)
    ? error.message
    : 'The assistant is temporarily unavailable. Please try again.'
}

app.get('/api/items', async (_request, response) => {
  try {
    response.json(await listMemoryItems(auth(response).client))
  } catch (error) {
    reportFailure(response, error, 'The library is temporarily unavailable.')
  }
})

app.get('/api/search', async (request, response) => {
  const query = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 240) : ''
  const colour = typeof request.query.color === 'string' && /^#[0-9a-f]{6}$/i.test(request.query.color) ? request.query.color : ''
  const today = typeof request.query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(request.query.today) ? request.query.today : undefined
  const offsetMinutes = typeof request.query.offset === 'string' && Number.isFinite(Number(request.query.offset)) ? Math.max(-840, Math.min(840, Number(request.query.offset))) : 0
  const dateField: DateField = request.query.dateField === 'captured' || request.query.dateField === 'kept' ? request.query.dateField : 'relevant'
  const explicitFrom = typeof request.query.from === 'string' ? new Date(request.query.from) : undefined
  const explicitTo = typeof request.query.to === 'string' ? new Date(request.query.to) : undefined
  const explicitRange = explicitFrom && explicitTo && Number.isFinite(explicitFrom.getTime()) && Number.isFinite(explicitTo.getTime()) && explicitFrom < explicitTo
    ? { from: explicitFrom.toISOString(), to: explicitTo.toISOString(), label: typeof request.query.dateLabel === 'string' ? request.query.dateLabel.slice(0, 80) : 'Selected dates' }
    : undefined
  const parsedDateIntent = extractDateIntent(query, today, offsetMinutes)
  const dateIntent = explicitRange ? undefined : parsedDateIntent
  const range = explicitRange ?? parsedDateIntent
  const semanticQuery = parsedDateIntent?.residualQuery ?? query
  if (!query && !colour && !range) return response.json({ query, colour, results: [], ranked: false })
  try {
    const { client, user } = auth(response)
    const allItems = await listMemoryItems(client)
    const items = range ? filterItemsByDate(allItems, range, dateField) : allItems
    const semanticResults = semanticQuery ? await searchItems(semanticQuery, items, client, user.id) : []
    const colourResults = colour ? searchItemsByColour(colour, items) : []
    let results = semanticQuery ? semanticResults : colour ? colourResults : items.map(({ id }) => ({ id, relevance: 100 }))
    if (semanticQuery && colour) {
      const semantic = new Map(semanticResults.map((result) => [result.id, result.relevance]))
      const visual = new Map(colourResults.map((result) => [result.id, result.relevance]))
      results = items.flatMap(({ id }) => {
        const meaning = semantic.get(id)
        const colourMatch = visual.get(id)
        if (meaning === undefined || colourMatch === undefined) return []
        return [{ id, relevance: Math.round(meaning * 0.62 + colourMatch * 0.38) }]
      }).sort((left, right) => right.relevance - left.relevance)
    }
    response.json({ query, colour, results, ranked: Boolean(semanticQuery || colour), dateIntent: dateIntent ? { from: dateIntent.from, to: dateIntent.to, label: dateIntent.label, residualQuery: dateIntent.residualQuery } : undefined, dateRange: explicitRange })
  } catch (error) {
    reportFailure(response, error, 'Semantic search is temporarily unavailable.')
  }
})

app.get('/api/spaces', async (_request, response) => {
  try {
    response.json(await listSpaces(auth(response).client))
  } catch (error) {
    reportFailure(response, error, 'Spaces are temporarily unavailable.')
  }
})

app.post('/api/spaces', async (request, response) => {
  try {
    const { client, user } = auth(response)
    response.status(201).json(await createSpace(client, request.body as { name?: unknown; color?: unknown; description?: unknown }, user.id))
  } catch (error) {
    reportFailure(response, error, 'That space could not be created.', 400)
  }
})

app.patch('/api/spaces/reorder', async (request, response) => {
  try {
    const ids = Array.isArray(request.body.ids) ? request.body.ids.filter((id: unknown): id is string => typeof id === 'string') : []
    const { client, user } = auth(response)
    response.json(await reorderSpaces(client, ids, user.id))
  } catch (error) {
    reportFailure(response, error, 'Spaces could not be reordered.', 400)
  }
})

app.get('/api/spaces/:id/matches', async (request, response) => {
  try {
    const { client, user } = auth(response)
    const [spaces, allItems] = await Promise.all([listSpaces(client, user.id), listMemoryItems(client)])
    const space = spaces.find((entry) => entry.id === request.params.id)
    if (!space) return response.status(404).json({ error: 'That space no longer exists.' })
    const candidates = allItems.filter((item) => item.ownerId === user.id && item.space !== space.name)
    if (!candidates.length) return response.json({ space, matches: [] })
    const intent = space.description
      ? `${space.name}. This space is for: ${space.description}`
      : `Items that naturally belong in a collection called ${space.name}`
    const semantic = await searchItems(intent, candidates, client, user.id)
    const combinedScores = new Map(fallbackSpaceMatches(space, candidates).map((match) => [match.id, match.relevance]))
    for (const match of semantic) combinedScores.set(match.id, Math.max(match.relevance, combinedScores.get(match.id) ?? 0))
    const ranked = [...combinedScores].map(([id, relevance]) => ({ id, relevance })).sort((left, right) => right.relevance - left.relevance)
    const byId = new Map(candidates.map((item) => [item.id, item]))
    const matches = ranked.slice(0, 12).flatMap((match) => {
      const item = byId.get(match.id)
      return item ? [{ item, relevance: match.relevance }] : []
    })
    response.json({ space, matches })
  } catch (error) {
    reportFailure(response, error, 'Matching items are temporarily unavailable.')
  }
})

app.post('/api/spaces/:id/matches', async (request, response) => {
  try {
    const { client, user } = auth(response)
    const ids = Array.isArray(request.body?.itemIds)
      ? [...new Set(request.body.itemIds.filter((id: unknown): id is string => typeof id === 'string'))].slice(0, 50)
      : []
    if (!ids.length) return response.status(400).json({ error: 'Choose at least one matching item.' })
    const [spaces, allItems] = await Promise.all([listSpaces(client, user.id), listMemoryItems(client)])
    const space = spaces.find((entry) => entry.id === request.params.id)
    if (!space) return response.status(404).json({ error: 'That space no longer exists.' })
    const movableIds = new Set(allItems.filter((item) => ids.includes(item.id) && item.ownerId === user.id && item.space !== space.name).map(({ id }) => id))
    if (!movableIds.size) return response.status(400).json({ error: 'Those items are already filed there or no longer available.' })
    const moved = (await Promise.all([...movableIds].map((id) => updateMemoryItem(client, id, { space: space.name })))).filter((item): item is MemoryItem => Boolean(item))
    void ensureSearchIndex(moved, client, user.id).catch((error) => {
      console.warn('Moved item indexing delayed:', error instanceof Error ? error.message : 'Unknown error')
    })
    response.json({ items: moved, receipt: `Added ${moved.length} ${moved.length === 1 ? 'item' : 'items'} to ${space.name}` })
  } catch (error) {
    reportFailure(response, error, 'Those items could not be added to the space.', 400)
  }
})

app.patch('/api/spaces/:id', async (request, response) => {
  try {
    const { client, user } = auth(response)
    const space = await updateSpace(client, request.params.id, request.body as { name?: unknown; color?: unknown; description?: unknown }, user.id)
    if (!space) return response.status(404).json({ error: 'That space no longer exists.' })
    response.json(space)
  } catch (error) {
    reportFailure(response, error, 'That space could not be updated.', 400)
  }
})

app.delete('/api/spaces/:id', async (request, response) => {
  try {
    const moveToId = typeof request.query.moveTo === 'string' ? request.query.moveTo : undefined
    const { client, user } = auth(response)
    const deleted = await deleteSpace(client, request.params.id, moveToId, user.id)
    if (!deleted) return response.status(404).json({ error: 'That space no longer exists.' })
    response.status(204).end()
  } catch (error) {
    reportFailure(response, error, 'That space could not be deleted.', 400)
  }
})

app.get('/api/assistant/conversations', async (_request, response) => {
  try {
    response.json({ conversations: await listConversations(auth(response).client) })
  } catch (error) {
    reportFailure(response, error, 'Chat history is temporarily unavailable.')
  }
})

app.get('/api/assistant/conversations/:id', async (request, response) => {
  try {
    const result = await getConversation(auth(response).client, request.params.id)
    if (!result) return response.status(404).json({ error: 'That conversation no longer exists.' })
    response.json(result)
  } catch (error) {
    reportFailure(response, error, 'That conversation could not be loaded.')
  }
})

app.delete('/api/assistant/conversations/:id', async (request, response) => {
  try {
    const deleted = await deleteConversation(auth(response).client, request.params.id)
    if (!deleted) return response.status(404).json({ error: 'That conversation no longer exists.' })
    response.status(204).end()
  } catch (error) {
    reportFailure(response, error, 'That conversation could not be deleted.')
  }
})

app.get('/api/assistant/source-image', async (request, response) => {
  const url = typeof request.query.url === 'string' ? request.query.url.trim().slice(0, 3_000) : ''
  if (!url) return response.status(400).json({ error: 'An image URL is required.' })
  try {
    const source = await fetchValidatedImage(url)
    if (!source) return response.status(404).json({ error: 'That preview is no longer available.' })
    const display = await sharp(source, { animated: false, limitInputPixels: 80_000_000 })
      .rotate()
      .resize({ width: 1_000, height: 800, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer()
    response.setHeader('Content-Type', 'image/webp')
    response.setHeader('Cache-Control', 'private, max-age=86400')
    response.send(display)
  } catch (error) {
    reportFailure(response, error, 'That result image could not be loaded.', 404)
  }
})

app.post('/api/assistant/chat/stream', assistantUpload.single('attachment'), async (request, response) => {
  let streamStarted = false
  try {
    const { client, user } = auth(response)
    const { message, history, attachmentItemIds, conversationId } = parseAssistantRequest(request)
    if (!message) return response.status(400).json({ error: 'Write a message for the assistant.' })
    const [items, spaces] = await Promise.all([listMemoryItems(client), listSpaces(client, user.id)])
    const taste = await recallTasteProfile(client, user.id, items)
    const attachmentLabels = [
      ...attachmentItemIds.map((id) => items.find((item) => item.id === id)?.title).filter((label): label is string => Boolean(label)),
      ...(request.file?.originalname ? [request.file.originalname] : []),
    ]

    response.status(200)
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders()
    streamStarted = true
    const emit = (event: Record<string, unknown>) => response.write(`${JSON.stringify(event)}\n`)
    emit({ type: 'ready' })

    const reply = await runAssistant({
      userId: user.id,
      message,
      history,
      attachmentItemIds,
      attachment: request.file,
      items,
      availableSpaces: spaces.map(({ name }) => name),
      tasteProfile: taste.profile,
      tasteProfileStatus: taste.status,
      tasteProfileItemCount: taste.sourceItemCount,
      search: (searchQuery, excludeIds) => searchItems(searchQuery, items, client, user.id, excludeIds),
      root,
    }, (delta, reset) => {
      if (reset) emit({ type: 'reset' })
      emit({ type: 'delta', delta })
    })
    const conversation = await saveExchange(client, { conversationId, userMessage: message, attachmentLabels, reply })
    emit({ type: 'done', data: { ...reply, conversation } })
    response.end()
  } catch (error) {
    const friendly = assistantFailure(error)
    if (streamStarted) {
      response.write(`${JSON.stringify({ type: 'error', error: friendly })}\n`)
      response.end()
    } else {
      response.status(503).json({ error: friendly })
    }
  }
})

app.post('/api/assistant/chat', assistantUpload.single('attachment'), async (request, response) => {
  try {
    const { client, user } = auth(response)
    const { message, history, attachmentItemIds, conversationId } = parseAssistantRequest(request)
    if (!message) return response.status(400).json({ error: 'Write a message for the assistant.' })
    const [items, spaces] = await Promise.all([listMemoryItems(client), listSpaces(client, user.id)])
    const taste = await recallTasteProfile(client, user.id, items)
    const reply = await runAssistant({
      userId: user.id,
      message,
      history,
      attachmentItemIds,
      attachment: request.file,
      items,
      availableSpaces: spaces.map(({ name }) => name),
      tasteProfile: taste.profile,
      tasteProfileStatus: taste.status,
      tasteProfileItemCount: taste.sourceItemCount,
      search: (searchQuery, excludeIds) => searchItems(searchQuery, items, client, user.id, excludeIds),
      root,
    })
    const attachmentLabels = [
      ...attachmentItemIds.map((id) => items.find((item) => item.id === id)?.title).filter((label): label is string => Boolean(label)),
      ...(request.file?.originalname ? [request.file.originalname] : []),
    ]
    const conversation = await saveExchange(client, { conversationId, userMessage: message, attachmentLabels, reply })
    response.json({ ...reply, conversation })
  } catch (error) {
    response.status(503).json({ error: assistantFailure(error) })
  }
})

app.post('/api/assistant/actions/:id/confirm', async (request, response) => {
  try {
    const { client, user } = auth(response)
    const action = takeAssistantAction(request.params.id, user.id)
    if (!action) return response.status(410).json({ error: 'That proposed change has expired. Ask Kept to prepare it again.' })
    if (action.kind === 'update') {
      const item = await updateMemoryItem(client, action.itemId, action.patch)
      if (!item) return response.status(404).json({ error: 'The item no longer exists.' })
      void ensureSearchIndex([item], client, user.id).catch((error) => {
        console.warn('Confirmed item indexing delayed:', error instanceof Error ? error.message : 'Unknown error')
      })
      return response.json({ item, items: [item], receipt: `Updated ${item.title}` })
    }
    if (action.kind === 'create') {
      const items: MemoryItem[] = []
      const created: MemoryItem[] = []
      const seen = new Set<string>()
      for (const [index, proposed] of action.items.entries()) {
        let url = proposed.url
        let domain = proposed.domain
        let image: string | undefined
        let storagePath: string | undefined
        let contentFingerprint: string | undefined
        let canonicalUrl: string | undefined
        if (proposed.kind === 'link' && url) {
          const normalized = normaliseWebUrl(url)
          url = normalized.href
          domain = normalized.hostname.replace(/^www\./, '')
          canonicalUrl = canonicalLink(url)
          contentFingerprint = linkFingerprint(url)
          if (seen.has(contentFingerprint)) continue
          seen.add(contentFingerprint)
          const existing = await findDuplicateMemoryItem(client, user.id, { contentFingerprint, canonicalUrl })
          if (existing) { items.push({ ...existing, duplicate: true }); continue }
          try {
            const preview = await fetchLinkPreview(url)
            url = preview.url
            domain = preview.domain
            image = preview.image
            canonicalUrl = canonicalLink(url)
            contentFingerprint = linkFingerprint(url)
            const resolvedExisting = await findDuplicateMemoryItem(client, user.id, { contentFingerprint, canonicalUrl })
            if (resolvedExisting) { items.push({ ...resolvedExisting, duplicate: true }); continue }
            try { storagePath = await archiveLinkPreview(client, user.id, preview) } catch (archiveError) {
              console.warn('Assistant preview could not be archived:', archiveError instanceof Error ? archiveError.message : 'Unknown error')
            }
          } catch (error) {
            console.warn(`Assistant link preview unavailable for ${domain}:`, error instanceof Error ? error.message : 'Unknown error')
          }
        }
        try {
          const inserted = await insertMemoryItem(client, {
            ...proposed, url, domain, image,
            createdAt: new Date(Date.now() + index).toISOString(), favourite: false,
            source: proposed.kind === 'link' ? 'Browser' as const : 'Quick note' as const,
            aiConfidence: 0.9, contentFingerprint,
          }, storagePath, user.id)
          items.push(inserted); created.push(inserted)
        } catch (error) {
          if (storagePath) await removePrivateImage(client, storagePath)
          if (error instanceof DuplicateMemoryItemError && contentFingerprint) {
            const existing = await findDuplicateMemoryItem(client, user.id, { contentFingerprint, canonicalUrl })
            if (existing) { items.push({ ...existing, duplicate: true }); continue }
          }
          throw error
        }
      }
      if (!items.length) return response.status(409).json({ error: 'Those links are already in your library.' })
      void ensureSearchIndex(created, client, user.id).catch((error) => {
        console.warn('Confirmed items indexing delayed:', error instanceof Error ? error.message : 'Unknown error')
      })
      const duplicateCount = items.length - created.length
      const receipt = created.length
        ? `Added ${created.length} ${created.length === 1 ? 'item' : 'items'}${duplicateCount ? ` · ${duplicateCount} already kept` : ''}`
        : `${duplicateCount} ${duplicateCount === 1 ? 'item was' : 'items were'} already kept`
      return response.status(created.length ? 201 : 200).json({ items, receipt })
    }
    const deletedItemIds = (await Promise.all(action.itemIds.map(async (id) => ({ id, deleted: await deleteMemoryItem(client, id) }))))
      .filter(({ deleted }) => deleted)
      .map(({ id }) => id)
    if (!deletedItemIds.length) return response.status(404).json({ error: 'Those items no longer exist or cannot be removed.' })
    return response.json({ deletedItemIds, receipt: `Removed ${deletedItemIds.length} ${deletedItemIds.length === 1 ? 'item' : 'items'} from your library` })
  } catch (error) {
    reportFailure(response, error, 'That change could not be applied.')
  }
})

app.delete('/api/assistant/actions/:id', (request, response) => {
  const { user } = auth(response)
  dismissAssistantAction(request.params.id, user.id)
  response.status(204).end()
})

app.post('/api/items/:id/refresh-preview', async (request, response) => {
  try {
    const { client } = auth(response)
    const item = (await listMemoryItems(client)).find(({ id }) => id === request.params.id)
    if (!item) return response.status(404).json({ error: 'That item no longer exists.' })
    if (item.kind !== 'link' || !item.url) return response.status(400).json({ error: 'Only saved links can refresh a web preview.' })
    const preview = await fetchLinkPreview(item.url, {
      titleHint: item.title,
      useReader: true,
      useWebSearch: request.query.search === '1',
    })
    if (!preview.image) return response.status(404).json({ error: request.query.search === '1' ? 'No reliable preview image was found on the page or the web.' : 'The page did not expose a reliable preview image.' })
    let storagePath: string | undefined
    try { storagePath = await archiveLinkPreview(client, item.ownerId ?? auth(response).user.id, preview) } catch (error) {
      console.warn('Refreshed preview could not be archived:', error instanceof Error ? error.message : 'Unknown error')
    }
    let updated
    try {
      updated = await updateMemoryItemPreview(client, item.id, { image: preview.image, storagePath })
    } catch (updateError) {
      if (storagePath) await removePrivateImage(client, storagePath)
      throw updateError
    }
    if (!updated) return response.status(403).json({ error: 'You do not have permission to update that preview.' })
    response.json({ item: updated, source: preview.imageSource ?? 'page' })
  } catch (error) {
    reportFailure(response, error, 'That preview could not be refreshed.')
  }
})

app.post('/api/capture', async (request, response) => {
  const { type, value, context, ownerUserId, spaceName } = request.body as { type?: 'link' | 'note'; value?: string; context?: string; ownerUserId?: string; spaceName?: string }
  if (!type || !value?.trim()) return response.status(400).json({ error: 'A link or note is required.' })
  try {
    const { client, user } = auth(response)
    const requestedOwner = typeof ownerUserId === 'string' && /^[0-9a-f-]{36}$/i.test(ownerUserId) ? ownerUserId : user.id
    const item = await captureTextItem({
      client,
      userId: user.id,
      type,
      value,
      context,
      ownerUserId: requestedOwner,
      spaceName: typeof spaceName === 'string' ? spaceName : '',
    })
    response.status(item.duplicate ? 200 : 201).json(item)
  } catch (error) {
    reportFailure(response, error, 'That item could not be saved.')
  }
})

app.post('/api/upload', upload.single('image'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Choose an image to save.' })
  const { client, user } = auth(response)
  try {
    const typedHint = typeof request.body.hint === 'string' ? request.body.hint.trim() : ''
    const filenameHint = request.file.originalname.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
    const hint = typedHint || filenameHint
    const requestedOwner = typeof request.body.ownerUserId === 'string' && /^[0-9a-f-]{36}$/i.test(request.body.ownerUserId) ? request.body.ownerUserId : user.id
    const requestedSpace = typeof request.body.spaceName === 'string' ? request.body.spaceName.trim().slice(0, 80) : ''
    const suppliedDate = typeof request.body.capturedAt === 'string' ? new Date(request.body.capturedAt) : undefined
    const capturedAt = suppliedDate && Number.isFinite(suppliedDate.getTime()) && suppliedDate.getUTCFullYear() >= 1900 && suppliedDate.getTime() <= Date.now() + 86_400_000 ? suppliedDate.toISOString() : undefined
    const capturedAtSource = request.body.capturedAtSource === 'apple_photos' ? 'apple_photos' as const : request.body.capturedAtSource === 'manual' ? 'manual' as const : undefined
    const sourceUrl = typeof request.body.sourceUrl === 'string' ? (() => { try { return normaliseWebUrl(request.body.sourceUrl).href } catch { return undefined } })() : undefined
    const item = await captureImageItem({ client, userId: user.id, buffer: request.file.buffer, mimeType: request.file.mimetype, filename: request.file.originalname, hint, ownerUserId: requestedOwner, spaceName: requestedSpace, capturedAt, capturedAtSource, sourceUrl })
    response.status(item.duplicate ? 200 : 201).json(item)
  } catch (error) {
    reportFailure(response, error, 'That image could not be saved.')
  }
})

app.post('/api/upload-video', assistantUpload.single('poster'), async (request, response) => {
  const { client, user } = auth(response)
  try {
    const requestedOwner = typeof request.body.ownerUserId === 'string' && /^[0-9a-f-]{36}$/i.test(request.body.ownerUserId) ? request.body.ownerUserId : user.id
    const requestedSpace = typeof request.body.spaceName === 'string' ? request.body.spaceName.trim().slice(0, 80) : ''
    const videoStoragePath = typeof request.body.videoStoragePath === 'string' ? request.body.videoStoragePath.trim() : ''
    const videoMimeType = typeof request.body.videoMimeType === 'string' && ['video/mp4', 'video/quicktime', 'video/webm'].includes(request.body.videoMimeType) ? request.body.videoMimeType : 'video/mp4'
    const filename = typeof request.body.filename === 'string' ? request.body.filename.trim().slice(0, 240) : 'saved-video.mp4'
    const hint = typeof request.body.hint === 'string' ? request.body.hint.trim() : ''
    const contentFingerprint = typeof request.body.contentFingerprint === 'string' ? request.body.contentFingerprint.toLowerCase() : ''
    const suppliedDate = typeof request.body.capturedAt === 'string' ? new Date(request.body.capturedAt) : undefined
    const capturedAt = suppliedDate && Number.isFinite(suppliedDate.getTime()) && suppliedDate.getUTCFullYear() >= 1900 && suppliedDate.getTime() <= Date.now() + 86_400_000 ? suppliedDate.toISOString() : undefined
    const capturedAtSource = request.body.capturedAtSource === 'apple_photos' ? 'apple_photos' as const : request.body.capturedAtSource === 'manual' ? 'manual' as const : undefined
    const item = await captureVideoItem({ client, userId: user.id, posterBuffer: request.file?.buffer, videoStoragePath, videoMimeType, filename, hint, contentFingerprint, ownerUserId: requestedOwner, spaceName: requestedSpace, capturedAt, capturedAtSource })
    response.status(item.duplicate ? 200 : 201).json(item)
  } catch (error) {
    reportFailure(response, error, 'That video could not be saved.')
  }
})

app.patch('/api/items/:id', async (request, response) => {
  try {
    const { client, user } = auth(response)
    const patch = request.body as MemoryPatch
    const item = await updateMemoryItem(client, request.params.id, patch)
    if (!item) return response.status(404).json({ error: 'Item not found.' })
    void ensureSearchIndex([item], client, user.id).catch((error) => {
      console.warn('Updated item indexing delayed:', error instanceof Error ? error.message : 'Unknown error')
    })
    response.json(item)
  } catch (error) {
    reportFailure(response, error, 'That item could not be updated.')
  }
})

app.delete('/api/items/:id', async (request, response) => {
  try {
    const deleted = await deleteMemoryItem(auth(response).client, request.params.id)
    if (!deleted) return response.status(404).json({ error: 'Item not found or you do not have permission to delete it.' })
    response.status(204).end()
  } catch (error) {
    reportFailure(response, error, 'That item could not be deleted.')
  }
})

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    return response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Please choose an image under 12 MB.' : error.message })
  }
  console.warn('Unexpected Kept API error:', error instanceof Error ? error.message : 'Unknown error')
  response.status(500).json({ error: 'Kept could not complete that request.' })
})

const production = process.argv.includes('--production') || Boolean(process.env.VERCEL)
if (production) {
  const dist = join(root, 'dist')
  app.use(express.static(dist, {
    setHeaders: (response, path) => {
      response.setHeader('Cache-Control', path.endsWith('index.html') ? 'no-store' : 'no-cache, must-revalidate')
    },
  }))
  app.get('/assets/{*splat}', (_request, response) => response.status(404).type('text/plain').send('Asset not found. Refresh Kept to load the current version.'))
  app.get('/{*splat}', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.sendFile(join(dist, 'index.html'))
  })
}

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1')
if (!process.env.VERCEL) app.listen(port, host, () => console.log(`Kept API listening on http://${host}:${port}`))

export default app
