import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryItem } from '../src/types.js'
import type { SearchResult } from './search-index.js'
import { canonicalLink } from './dedupe.js'
import { fetchLinkPreview } from './link-preview.js'

type HistoryTurn = { role: 'user' | 'assistant'; content: string }

type AnthropicBlock = {
  type: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  text?: string
  thinking?: string
  signature?: string
  citations?: Array<{ type?: string; url?: string; title?: string }>
  content?: Array<{ type?: string; url?: string; title?: string }>
  _inputJson?: string
}

interface AnthropicResponse {
  content: AnthropicBlock[]
  stop_reason?: string
}

export interface AssistantSource {
  title: string
  url: string
  image?: string
  domain?: string
}

export type AssistantCreateItem = Pick<MemoryItem, 'title' | 'description' | 'kind' | 'space' | 'tags' | 'palette' | 'searchTerms'> & {
  url?: string
  domain?: string
}

type AssistantActionBase = {
  id: string
  label: string
  description: string
  expiresAt: string
}

export type AssistantAction = AssistantActionBase & (
  | {
    kind: 'update'
    itemId: string
    itemTitle: string
    patch: Partial<Pick<MemoryItem, 'title' | 'description' | 'space' | 'tags' | 'favourite'>>
  }
  | {
    kind: 'create'
    items: AssistantCreateItem[]
  }
  | {
    kind: 'delete'
    itemIds: string[]
    itemTitles: string[]
  }
)

export interface AssistantReply {
  message: string
  itemIds: string[]
  sources: AssistantSource[]
  activities: string[]
  proposedAction?: AssistantAction
}

interface AssistantContext {
  userId: string
  message: string
  history: HistoryTurn[]
  attachmentItemIds: string[]
  attachment?: Express.Multer.File
  items: MemoryItem[]
  availableSpaces: string[]
  tasteProfile: TasteProfile
  tasteProfileStatus: 'recalled' | 'refreshed'
  tasteProfileItemCount: number
  search: (query: string, excludeIds?: string[]) => Promise<SearchResult[]>
  root: string
}

const pendingActions = new Map<string, { userId: string; action: AssistantAction }>()

function assistantTools(spaces: string[]) {
  const availableSpaces = spaces.length ? spaces : ['Inbox']
  return [
    {
      name: 'search_memory',
      description: 'Semantically search the user’s Kept library. Use for finding saved items or answering questions about their memory.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A concrete semantic retrieval query.' },
          limit: { type: 'integer', description: 'Return between 1 and 8 items.' },
        },
        required: ['query', 'limit'],
        additionalProperties: false,
      },
    },
    {
      name: 'find_similar_in_library',
      description: 'Find items in Kept that are visually or conceptually similar to an attached/specified item or description.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'An existing Kept item ID, when available.' },
          description: { type: 'string', description: 'A visual/conceptual description, especially for a device attachment.' },
          limit: { type: 'integer', description: 'Return between 1 and 8 items.' },
        },
        required: ['item_id', 'description', 'limit'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_item_details',
      description: 'Read complete metadata for a specific Kept item before discussing or proposing a change.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { item_id: { type: 'string' } },
        required: ['item_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_spaces',
      description: 'List the personal spaces that new items can be filed into.',
      strict: true,
      input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    {
      name: 'propose_item_update',
      description: 'Prepare, but DO NOT apply, a change to one saved item. This can rename, describe, retag, move, or favourite it. The UI asks the user to confirm.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          space: { type: 'string', enum: availableSpaces },
          tags: { type: 'array', items: { type: 'string' } },
          favourite: { type: 'boolean' },
          summary: { type: 'string', description: 'A short, plain-language summary of the proposed change.' },
        },
        required: ['item_id', 'title', 'description', 'space', 'tags', 'favourite', 'summary'],
        additionalProperties: false,
      },
    },
    {
      name: 'propose_create_items',
      description: 'Prepare 1–10 brand-new links or notes for the library, including a batch of web results. Nothing is saved until the user confirms. For web results, use exact official URLs returned by web search.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['link', 'note'] },
                title: { type: 'string' },
                description: { type: 'string' },
                url: { type: 'string', description: 'Exact public URL for a link, or an empty string for a note.' },
                space: { type: 'string', enum: availableSpaces },
                tags: { type: 'array', items: { type: 'string' } },
                palette: { type: 'array', items: { type: 'string' }, description: 'One to five six-digit hex colours.' },
                search_terms: { type: 'array', items: { type: 'string' } },
              },
              required: ['kind', 'title', 'description', 'url', 'space', 'tags', 'palette', 'search_terms'],
              additionalProperties: false,
            },
          },
          summary: { type: 'string', description: 'A short summary of what will be added and why.' },
        },
        required: ['items', 'summary'],
        additionalProperties: false,
      },
    },
    {
      name: 'propose_delete_items',
      description: 'Prepare deletion of 1–10 existing saved items. This is never applied without explicit UI confirmation.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          item_ids: { type: 'array', items: { type: 'string' }, description: 'One to ten exact Kept item IDs.' },
          summary: { type: 'string', description: 'A short summary of the requested deletion.' },
        },
        required: ['item_ids', 'summary'],
        additionalProperties: false,
      },
    },
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 6,
      allowed_callers: ['direct'],
    },
  ]
}

function compactItem(item: MemoryItem, relevance?: number) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    kind: item.kind,
    space: item.space,
    tags: item.tags,
    source: item.domain ?? item.source,
    url: item.url,
    relevance,
    colours: item.palette,
    location: item.location?.name,
    takenAt: item.capturedAt,
    keptAt: item.createdAt,
  }
}

export type TasteProfile = ReturnType<typeof preferenceSignals>

export function preferenceSignals(items: MemoryItem[]) {
  const weighted = <T extends string>(values: Array<{ value: T; weight: number }>, limit: number) => {
    const totals = new Map<T, number>()
    for (const { value, weight } of values) if (value) totals.set(value, (totals.get(value) ?? 0) + weight)
    return [...totals.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([value]) => value)
  }
  const now = Date.now()
  const itemWeight = (item: MemoryItem) => (item.favourite ? 4 : 1) + (now - new Date(item.createdAt).getTime() < 45 * 86_400_000 ? 1 : 0)
  return {
    recurringThemes: weighted(items.flatMap((item) => item.tags.map((value) => ({ value, weight: itemWeight(item) }))), 14),
    colours: weighted(items.flatMap((item) => item.palette.map((value) => ({ value, weight: itemWeight(item) }))), 8),
    spaces: weighted(items.map((item) => ({ value: item.space, weight: itemWeight(item) })), 8),
    sources: weighted(items.flatMap((item) => item.domain ? [{ value: item.domain, weight: itemWeight(item) }] : []), 8),
    favourites: items.filter(({ favourite }) => favourite).slice(0, 12).map(({ title, tags, space }) => ({ title, tags, space })),
  }
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function uniqueStrings(value: unknown, limit: number) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(asString).filter(Boolean))].slice(0, limit)
}

function actionBase(label: string, description: string): AssistantActionBase {
  return {
    id: randomUUID(),
    label,
    description,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }
}

function storeAction(action: AssistantAction, userId: string) {
  pendingActions.set(action.id, { userId, action })
  return { action, message: 'Prepared this library change for review. Nothing has changed yet.' }
}

function makeUpdateAction(input: Record<string, unknown>, context: AssistantContext) {
  const itemId = asString(input.item_id)
  const item = context.items.find(({ id }) => id === itemId)
  if (!item) return { error: 'That item no longer exists.' }
  const patch: Extract<AssistantAction, { kind: 'update' }>['patch'] = {}
  const title = asString(input.title)
  const description = asString(input.description)
  const space = asString(input.space)
  const tags = uniqueStrings(input.tags, 20)
  if (title && title !== item.title) patch.title = title.slice(0, 160)
  if (description && description !== item.description) patch.description = description.slice(0, 4_000)
  if (space && context.availableSpaces.includes(space) && space !== item.space) patch.space = space
  if (tags.length && JSON.stringify(tags) !== JSON.stringify(item.tags)) patch.tags = tags
  if (typeof input.favourite === 'boolean' && input.favourite !== item.favourite) patch.favourite = input.favourite
  if (!Object.keys(patch).length) return { error: 'No actual change was proposed.' }

  return storeAction({
    ...actionBase('Review item update', asString(input.summary) || `Update ${item.title}`),
    kind: 'update',
    itemId,
    itemTitle: item.title,
    patch,
  }, context.userId)
}

function comparableUrl(value?: string) {
  if (!value) return ''
  try { return canonicalLink(value) } catch { return '' }
}

function makeCreateAction(input: Record<string, unknown>, context: AssistantContext) {
  const requested = Array.isArray(input.items) ? input.items.slice(0, 10) : []
  const knownUrls = new Set(context.items.map(({ url }) => comparableUrl(url)).filter(Boolean))
  const proposedUrls = new Set<string>()
  const items: AssistantCreateItem[] = []

  for (const raw of requested) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Record<string, unknown>
    const kind = candidate.kind === 'note' ? 'note' : 'link'
    const title = asString(candidate.title).slice(0, 160)
    const description = asString(candidate.description).slice(0, 4_000)
    const space = asString(candidate.space)
    if (!title || !description || !context.availableSpaces.includes(space)) continue
    let url: string | undefined
    let domain: string | undefined
    if (kind === 'link') {
      const comparable = comparableUrl(asString(candidate.url))
      if (!comparable || knownUrls.has(comparable) || proposedUrls.has(comparable)) continue
      url = new URL(asString(candidate.url)).href
      if (!/^https?:$/i.test(new URL(url).protocol)) continue
      domain = new URL(url).hostname.replace(/^www\./, '')
      proposedUrls.add(comparable)
    }
    const palette = uniqueStrings(candidate.palette, 5).filter((colour) => /^#[0-9a-f]{6}$/i.test(colour))
    items.push({
      kind,
      title,
      description,
      url,
      domain,
      space,
      tags: uniqueStrings(candidate.tags, 20),
      palette: palette.length ? palette : ['#e7e4dc', '#a9aa9f', '#606258'],
      searchTerms: uniqueStrings(candidate.search_terms, 20),
    })
  }
  if (!items.length) return { error: 'No valid new items remained after checking links, duplicates, and spaces.' }
  const count = items.length
  return storeAction({
    ...actionBase(count === 1 ? 'Review new item' : `Review ${count} new items`, asString(input.summary) || `Add ${count} ${count === 1 ? 'item' : 'items'} to your library`),
    kind: 'create',
    items,
  }, context.userId)
}

function makeDeleteAction(input: Record<string, unknown>, context: AssistantContext) {
  const ids = uniqueStrings(input.item_ids, 10)
  const items = ids.map((id) => context.items.find((item) => item.id === id)).filter((item): item is MemoryItem => Boolean(item))
  if (!items.length) return { error: 'None of those items still exist.' }
  const count = items.length
  return storeAction({
    ...actionBase(count === 1 ? 'Review item removal' : `Review ${count} removals`, asString(input.summary) || `Remove ${count} ${count === 1 ? 'item' : 'items'} from your library`),
    kind: 'delete',
    itemIds: items.map(({ id }) => id),
    itemTitles: items.map(({ title }) => title),
  }, context.userId)
}

async function imageBlockForItem(item: MemoryItem, root: string): Promise<Record<string, unknown> | undefined> {
  if (!item.image) return undefined
  if (/^https?:\/\//i.test(item.image)) return { type: 'image', source: { type: 'url', url: item.image } }
  const relative = item.image.replace(/^\//, '')
  if (!relative.startsWith('uploads/') && !relative.startsWith('images/') && !relative.startsWith('public/')) return undefined
  const localPath = relative.startsWith('public/') ? join(root, relative) : relative.startsWith('uploads/') ? join(root, relative) : join(root, 'public', relative)
  try {
    const bytes = await readFile(localPath)
    const extension = localPath.split('.').pop()?.toLowerCase()
    const mediaType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/jpeg'
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } }
  } catch {
    return undefined
  }
}

async function executeTool(
  block: AnthropicBlock,
  context: AssistantContext,
  foundIds: Set<string>,
  activities: Set<string>,
): Promise<{ output: unknown; action?: AssistantAction }> {
  const input = block.input ?? {}
  if (block.name === 'search_memory') {
    const query = asString(input.query) || context.message
    const limit = Math.max(1, Math.min(8, Number(input.limit) || 5))
    const matches = (await context.search(query)).slice(0, limit)
    matches.forEach(({ id }) => foundIds.add(id))
    activities.add('Searched your memory')
    return { output: matches.map((match) => {
      const item = context.items.find(({ id }) => id === match.id)
      return item ? compactItem(item, match.relevance) : undefined
    }).filter(Boolean) }
  }
  if (block.name === 'find_similar_in_library') {
    const itemId = asString(input.item_id)
    const source = context.items.find(({ id }) => id === itemId)
    const description = asString(input.description)
    const query = source
      ? [description, source.title, source.description, source.tags.join(' '), source.searchTerms.join(' ')].filter(Boolean).join('. ')
      : description || context.message
    const limit = Math.max(1, Math.min(8, Number(input.limit) || 5))
    const matches = (await context.search(query, itemId ? [itemId] : [])).slice(0, limit)
    matches.forEach(({ id }) => foundIds.add(id))
    activities.add('Compared with your library')
    return { output: matches.map((match) => {
      const item = context.items.find(({ id }) => id === match.id)
      return item ? compactItem(item, match.relevance) : undefined
    }).filter(Boolean) }
  }
  if (block.name === 'get_item_details') {
    const item = context.items.find(({ id }) => id === asString(input.item_id))
    if (item) foundIds.add(item.id)
    activities.add('Read item details')
    return { output: item ? compactItem(item) : { error: 'Item not found.' } }
  }
  if (block.name === 'list_spaces') {
    activities.add('Checked your spaces')
    return { output: context.availableSpaces }
  }
  if (block.name === 'propose_item_update') {
    const result = makeUpdateAction(input, context)
    activities.add('Prepared a change for review')
    return { output: result, action: 'action' in result ? result.action : undefined }
  }
  if (block.name === 'propose_create_items') {
    const result = makeCreateAction(input, context)
    activities.add('Prepared new items for review')
    return { output: result, action: 'action' in result ? result.action : undefined }
  }
  if (block.name === 'propose_delete_items') {
    const result = makeDeleteAction(input, context)
    activities.add('Prepared removals for review')
    return { output: result, action: 'action' in result ? result.action : undefined }
  }
  return { output: { error: 'Unknown tool.' } }
}

function extractSources(blocks: AnthropicBlock[]) {
  const sources = new Map<string, AssistantSource>()
  const add = (url: string, title?: string) => {
    try {
      const parsed = new URL(url.replace(/[),.;!?]+$/, ''))
      if (!/^https?:$/.test(parsed.protocol)) return
      const clean = parsed.toString()
      if (!sources.has(clean)) sources.set(clean, {
        url: clean,
        title: title || parsed.hostname.replace(/^www\./, ''),
      })
    } catch {
      // Ignore malformed model output; cited and tool sources are still collected.
    }
  }
  for (const block of blocks) {
    // Recommendation URLs written into the answer are the most useful visual
    // companions, so keep them ahead of broad search-result pages.
    for (const match of block.text?.matchAll(/https?:\/\/[^\s<>"']+/g) ?? []) add(match[0])
    for (const citation of block.citations ?? []) {
      if (citation.url) add(citation.url, citation.title)
    }
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) if (result.url) add(result.url, result.title)
    }
  }
  return [...sources.values()].slice(0, 8)
}

async function enrichSources(sources: AssistantSource[]) {
  return Promise.all(sources.slice(0, 6).map(async (source) => {
    try {
      const preview = await fetchLinkPreview(source.url, { titleHint: source.title, useReader: true, useWebSearch: true })
      return { ...source, title: preview.title || source.title, image: preview.image, domain: preview.domain }
    } catch {
      try { return { ...source, domain: new URL(source.url).hostname.replace(/^www\./, '') } } catch { return source }
    }
  }))
}

async function parseAnthropicStream(response: Response, onTextDelta: (delta: string) => void): Promise<AnthropicResponse> {
  if (!response.body) throw new Error('The assistant received an empty stream. Please try again.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const blocks = new Map<number, AnthropicBlock>()
  let buffer = ''
  let stopReason: string | undefined
  let messageStopped = false

  const accept = (packet: string) => {
    const data = packet.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    if (event.type === 'error') throw new Error('The assistant stream was interrupted. Please try again.')
    if (event.type === 'message_stop') {
      messageStopped = true
      return
    }
    const index = typeof event.index === 'number' ? event.index : -1
    if (event.type === 'content_block_start' && index >= 0 && event.content_block && typeof event.content_block === 'object') {
      const block = { ...(event.content_block as AnthropicBlock) }
      if (block.type === 'tool_use' || block.type === 'server_tool_use') block._inputJson = ''
      blocks.set(index, block)
      return
    }
    if (event.type === 'content_block_delta' && index >= 0 && event.delta && typeof event.delta === 'object') {
      const block = blocks.get(index)
      if (!block) return
      const delta = event.delta as Record<string, unknown>
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        block.text = `${block.text ?? ''}${delta.text}`
        onTextDelta(delta.text)
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        block.thinking = `${block.thinking ?? ''}${delta.thinking}`
      } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        block.signature = `${block.signature ?? ''}${delta.signature}`
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        block._inputJson = `${block._inputJson ?? ''}${delta.partial_json}`
      } else if (delta.type === 'citations_delta' && delta.citation && typeof delta.citation === 'object') {
        block.citations = [...(block.citations ?? []), delta.citation as { type?: string; url?: string; title?: string }]
      }
      return
    }
    if (event.type === 'content_block_stop' && index >= 0) {
      const block = blocks.get(index)
      if (block?._inputJson) {
        try { block.input = JSON.parse(block._inputJson) as Record<string, unknown> } catch { block.input = {} }
      }
      return
    }
    if (event.type === 'message_delta' && event.delta && typeof event.delta === 'object') {
      const reason = (event.delta as Record<string, unknown>).stop_reason
      if (typeof reason === 'string') stopReason = reason
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const packets = buffer.split(/\r?\n\r?\n/)
    buffer = packets.pop() ?? ''
    for (const packet of packets) accept(packet)
    if (messageStopped) {
      await reader.cancel()
      break
    }
    if (done) break
  }
  if (buffer.trim()) accept(buffer)
  return { content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => {
    const { _inputJson: _discard, ...clean } = block
    return clean
  }), stop_reason: stopReason }
}

export async function runAssistant(context: AssistantContext, onTextDelta?: (delta: string, reset?: boolean) => void): Promise<AssistantReply> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('The assistant is not configured yet.')

  const attachedItems = context.attachmentItemIds
    .map((id) => context.items.find((item) => item.id === id))
    .filter((item): item is MemoryItem => Boolean(item))
  const userContent: Array<Record<string, unknown>> = []
  if (context.attachment) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: context.attachment.mimetype, data: context.attachment.buffer.toString('base64') },
    })
  }
  for (const item of attachedItems.slice(0, 4)) {
    const image = await imageBlockForItem(item, context.root)
    if (image) userContent.push(image)
  }
  userContent.push({
    type: 'text',
    text: [
      context.message,
      attachedItems.length ? `\nAttached Kept items:\n${JSON.stringify(attachedItems.map(compactItem))}` : '',
      context.attachment ? `\nA device image named “${context.attachment.originalname}” is attached. Analyze it visually when relevant.` : '',
    ].join(''),
  })

  const messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] | Array<Record<string, unknown>> }> = [
    ...context.history.slice(-8).map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2_000) })),
    { role: 'user', content: userContent },
  ]
  const foundIds = new Set<string>()
  const activities = new Set<string>()
  if (/similar|like this|for my taste|personal/i.test(context.message) && context.tasteProfileItemCount > 0) {
    activities.add(context.tasteProfileStatus === 'recalled' ? 'Used your saved taste' : 'Refreshed your taste profile')
  }
  const allBlocks: AnthropicBlock[] = []
  const textParts: string[] = []
  let proposedAction: AssistantAction | undefined
  let streamedText = false

  for (let turn = 0; turn < 6; turn += 1) {
    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
        max_tokens: 3_200,
        stream: Boolean(onTextDelta),
        system: `You are Kept’s personal visual-memory assistant. Be concise, observant, and useful. Use memory tools for any claim about the user’s saved library. Kept has already recalled the user’s persistent taste profile from ${context.tasteProfileItemCount} personal saves: ${JSON.stringify(context.tasteProfile)}. Do not claim you are learning it again. For personalised web discovery or “find similar online”, search the web and rank only genuinely strong matches against both the anchor and this saved profile. Explain the specific fit—not generic praise—and mention meaningful divergences such as price, era, material, colour, or availability. Include the exact absolute URL for every recommended web item so Kept can embed a visual preview beside your answer. Use web search when the user asks to search/find something online, requests current information, or asks for web alternatives similar to an attachment. When showing library findings, mention their exact titles. You can create new links or notes, update existing items, and delete items, but every mutation must be proposed with the matching propose_* tool and confirmed by the user in the UI. If the user asks to add multiple web results, batch all exact official URLs into one propose_create_items call. Canonicalise mentally and never propose the same link twice; Kept also enforces duplicate protection. Never say you lack a creation tool. Never claim a mutation already happened. Do not propose more than one write action per response. Personal spaces available for new items are: ${context.availableSpaces.join(', ')}. Device attachments are temporary context unless the user explicitly asks to save one; direct device-image saving is not yet supported. Prefer 2–5 exceptional results over long lists.`,
        messages,
        tools: assistantTools(context.availableSpaces),
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      }),
    })
    if (!apiResponse.ok) {
      const rawResponse = await apiResponse.text()
      const details = rawResponse.replace(/\s+/g, ' ').slice(0, 350)
      console.warn(`Anthropic assistant failed (${apiResponse.status}): ${details}`)
      throw new Error(apiResponse.status === 429 ? 'The assistant is busy. Please try again in a moment.' : 'The assistant could not complete that request.')
    }

    let startedThisTurn = false
    let result: AnthropicResponse
    if (onTextDelta) {
      result = await parseAnthropicStream(apiResponse, (delta) => {
        if (!startedThisTurn) {
          const reset = streamedText
          startedThisTurn = true
          streamedText = true
          onTextDelta(delta, reset)
          return
        }
        onTextDelta(delta)
      })
    } else {
      const rawResponse = await apiResponse.text()
      try {
        result = JSON.parse(rawResponse) as AnthropicResponse
      } catch {
        const contentType = apiResponse.headers.get('content-type') ?? 'unknown content type'
        const preview = rawResponse.replace(/\s+/g, ' ').slice(0, 160)
        console.warn(`Anthropic returned an unreadable response (${contentType}): ${preview}`)
        throw new Error('The assistant received an unreadable response. Please try again.')
      }
    }
    if (!Array.isArray(result.content)) {
      console.warn('Anthropic assistant response was missing its content array.')
      throw new Error('The assistant received an incomplete response. Please try again.')
    }
    allBlocks.push(...result.content)
    for (const block of result.content) if (block.type === 'server_tool_use' && block.name === 'web_search') activities.add('Searched the web')
    const toolCalls = result.content.filter((block) => block.type === 'tool_use' && block.id && block.name)
    const text = result.content.filter((block) => block.type === 'text' && block.text).map((block) => block.text).join('').trim()
    if (text) textParts.push(text)

    if (!toolCalls.length && result.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: result.content })
    if (toolCalls.length) {
      const toolResults: Array<Record<string, unknown>> = []
      for (const call of toolCalls) {
        const executed = await executeTool(call, context, foundIds, activities)
        if (executed.action) proposedAction = executed.action
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(executed.output) })
      }
      messages.push({ role: 'user', content: toolResults })
    }
  }

  const finalText = textParts.at(-1) || (proposedAction ? 'I prepared that change for your review.' : 'I couldn’t find a confident answer yet. Try describing what you remember in another way.')
  return {
    message: finalText,
    itemIds: [...foundIds].filter((id) => !context.attachmentItemIds.includes(id)).slice(0, 6),
    sources: await enrichSources(extractSources(allBlocks)),
    activities: [...activities],
    proposedAction,
  }
}

export function takeAssistantAction(id: string, userId: string) {
  const pending = pendingActions.get(id)
  if (!pending || pending.userId !== userId) return undefined
  pendingActions.delete(id)
  const { action } = pending
  if (new Date(action.expiresAt).getTime() < Date.now()) return undefined
  return action
}

export function dismissAssistantAction(id: string, userId: string) {
  const pending = pendingActions.get(id)
  if (!pending || pending.userId !== userId) return false
  return pendingActions.delete(id)
}
