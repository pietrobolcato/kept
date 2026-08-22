import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemoryItem } from '../src/types.js'
import { extractDateIntent, filterItemsByDate, type DateField, type DateRange } from '../src/date-search.js'

interface StoredEmbedding {
  id: string
  embedding_fingerprint: string | null
}

interface VectorMatch {
  id: string
  similarity: number
}

interface WritableShare {
  owner_user_id: string
  space_name: string
  can_add: boolean
  can_edit: boolean
}

export interface SearchResult {
  id: string
  relevance: number
}

const model = process.env.VOYAGE_MODEL ?? 'voyage-4'
const dimension = 512
const indexQueues = new Map<string, Promise<void>>()
const paletteProminence = [1, 0.48, 0.3] as const
const colourDistanceLimit = 70
const minimumColourRelevance = 34

const namedColours = [
  ['black', '#171717'], ['charcoal', '#353535'], ['white', '#f5f3ed'], ['cream', '#eee5ce'],
  ['beige', '#d7c5a8'], ['taupe', '#9f8c79'], ['grey', '#8b8d88'], ['brown', '#79553d'],
  ['red', '#c7433d'], ['rust', '#b85d3e'], ['orange', '#df843f'], ['mustard', '#c49a32'],
  ['yellow', '#e5d34b'], ['lime', '#bddb4f'], ['green', '#4f7a4e'], ['sage', '#8a9b78'],
  ['teal', '#3d7f79'], ['turquoise', '#55aaa7'], ['blue', '#4374a7'], ['navy', '#2f405c'],
  ['lavender', '#ad9ac9'], ['purple', '#765a91'], ['pink', '#d890a4'],
] as const

function hexRgb(hex: string) {
  const match = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  return match ? [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)] as const : undefined
}

function rgbLab(rgb: readonly number[]) {
  const linear = rgb.map((value) => {
    const channel = value / 255
    return channel > 0.04045 ? ((channel + 0.055) / 1.055) ** 2.4 : channel / 12.92
  })
  const x = (linear[0] * 0.4124 + linear[1] * 0.3576 + linear[2] * 0.1805) / 0.95047
  const y = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  const z = (linear[0] * 0.0193 + linear[1] * 0.1192 + linear[2] * 0.9505) / 1.08883
  const curve = (value: number) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116
  const fx = curve(x); const fy = curve(y); const fz = curve(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)] as const
}

function colourDistance(left: readonly number[], right: readonly number[]) {
  return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0))
}

function colourNames(palette: string[]) {
  const names = new Set<string>()
  const references = namedColours.map(([name, hex]) => [name, rgbLab(hexRgb(hex)!)] as const)
  for (const hex of palette) {
    const rgb = hexRgb(hex)
    if (!rgb) continue
    const lab = rgbLab(rgb)
    const closest = references.toSorted((left, right) => colourDistance(lab, left[1]) - colourDistance(lab, right[1]))[0]
    if (closest) names.add(closest[0])
  }
  return [...names]
}

function searchableText(item: MemoryItem) {
  return [
    `Title: ${item.title}`,
    `Description: ${item.description}`,
    `Type: ${item.kind}`,
    `Space: ${item.space}`,
    `Tags: ${item.tags.join(', ')}`,
    `Visual colours: ${colourNames(item.palette).join(', ')} (${item.palette.join(', ')})`,
    `Likely searches: ${item.searchTerms.join(', ')}`,
    item.domain ? `Source: ${item.domain}` : '',
    item.location?.name ? `Location: ${item.location.name}` : '',
    item.location?.latitude != null && item.location?.longitude != null ? `Coordinates: ${item.location.latitude.toFixed(5)}, ${item.location.longitude.toFixed(5)}` : '',
    item.capturedAt ? `Photo taken: ${new Date(item.capturedAt).toISOString()}` : '',
    `Kept on: ${new Date(item.createdAt).toISOString()}`,
  ].filter(Boolean).join('\n')
}

function lexicalText(item: MemoryItem) {
  return [item.title, item.description, item.kind, item.space, item.tags.join(' '), item.searchTerms.join(' '), colourNames(item.palette).join(' '), item.domain ?? '', item.location?.name ?? '', item.capturedAt ?? '', item.createdAt].join(' ')
}

function fingerprint(item: MemoryItem) {
  return createHash('sha256').update(`${model}:${dimension}:${searchableText(item)}`).digest('hex')
}

async function embed(input: string[], inputType: 'document' | 'query') {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) throw new Error('Voyage search is not configured.')
  const request = () => fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input,
      model,
      input_type: inputType,
      output_dimension: dimension,
      output_dtype: 'float',
      truncation: true,
    }),
  })
  let response = await request()
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') ?? 1)
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter * 1_000, 1_000), 4_000)))
    response = await request()
  }
  if (!response.ok) {
    console.warn(`Voyage embedding failed (${response.status}).`)
    throw new Error('Semantic search is temporarily unavailable.')
  }
  const result = await response.json() as { data?: Array<{ index: number; embedding: number[] }> }
  if (!result.data || result.data.length !== input.length) throw new Error('Voyage returned an incomplete embedding response.')
  return result.data.sort((left, right) => left.index - right.index).map(({ embedding }) => embedding)
}

async function ensureIndexedNow(items: MemoryItem[], client: SupabaseClient, userId: string) {
  if (!items.length) return
  const [{ data, error }, memberships] = await Promise.all([
    client.from('memory_items').select('id,embedding_fingerprint'),
    client.from('space_members').select('owner_user_id,space_name,can_add,can_edit').eq('member_user_id', userId),
  ])
  if (error) throw new Error(`Could not inspect the search index: ${error.message}`)
  if (memberships.error) throw new Error(`Could not inspect shared search access: ${memberships.error.message}`)
  const fingerprints = new Map(((data ?? []) as StoredEmbedding[]).map((row) => [row.id, row.embedding_fingerprint]))
  const writableShares = new Set(((memberships.data ?? []) as WritableShare[])
    .filter((membership) => membership.can_add || membership.can_edit)
    .map((membership) => `${membership.owner_user_id}\u0000${membership.space_name}`))
  const missing = items.filter((item) => (
    item.ownerId === userId || (item.ownerId && writableShares.has(`${item.ownerId}\u0000${item.space}`))
  ) && fingerprints.get(item.id) !== fingerprint(item))
  for (let offset = 0; offset < missing.length; offset += 128) {
    const batch = missing.slice(offset, offset + 128)
    const vectors = await embed(batch.map(searchableText), 'document')
    const updates = await Promise.all(batch.map((item, index) => client.rpc('set_memory_item_embedding', {
      p_id: item.id,
      p_embedding: vectors[index],
      p_fingerprint: fingerprint(item),
    })))
    const failed = updates.find(({ error: updateError }) => updateError)
    if (failed?.error) throw new Error(`Could not persist the search index: ${failed.error.message}`)
  }
}

export function ensureSearchIndex(items: MemoryItem[], client: SupabaseClient, userId: string) {
  const previous = indexQueues.get(userId) ?? Promise.resolve()
  const work = previous.catch(() => undefined).then(() => ensureIndexedNow(items, client, userId))
  indexQueues.set(userId, work)
  const cleanup = () => {
    if (indexQueues.get(userId) === work) indexQueues.delete(userId)
  }
  // Do not use an ignored `finally()` promise here: it mirrors a rejected
  // indexing job and becomes an unhandled rejection even when the caller
  // catches `work`, which can terminate the API process on modern Node.
  void work.then(cleanup, cleanup)
  return work
}

function editDistance(left: string, right: string) {
  if (left === right) return 0
  const matrix = Array.from({ length: left.length + 1 }, (_, row) => Array.from({ length: right.length + 1 }, (_, column) => row === 0 ? column : column === 0 ? row : 0))
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      matrix[row][column] = Math.min(
        matrix[row][column - 1] + 1,
        matrix[row - 1][column] + 1,
        matrix[row - 1][column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + 1)
      }
    }
  }
  return matrix[left.length][right.length]
}

function fuzzyScore(query: string, item: MemoryItem) {
  const normalize = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
  const normalizedQuery = normalize(query)
  const document = normalize(lexicalText(item))
  if (!normalizedQuery) return 0
  if (document.includes(normalizedQuery)) return 1
  const words = document.split(' ').filter(Boolean)
  const queryWords = normalizedQuery.split(' ').filter(Boolean)
  const matches = queryWords.map((queryWord) => {
    let best = 0
    for (const word of words) {
      if (word === queryWord) return 1
      if (Math.min(word.length, queryWord.length) < 5) continue
      const similarity = 1 - editDistance(queryWord, word) / Math.max(queryWord.length, word.length)
      best = Math.max(best, similarity)
    }
    return best >= 0.7 ? best : 0
  })
  const coverage = matches.filter((value) => value > 0).length / queryWords.length
  if (queryWords.length > 1 && coverage < 0.66) return 0
  return matches.reduce((sum, value) => sum + value, 0) / queryWords.length
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}

export async function searchItems(query: string, items: MemoryItem[], client: SupabaseClient, userId: string, excludeIds: string[] = [], dateOptions?: { today?: string; offsetMinutes?: number; range?: DateRange; field?: DateField }): Promise<SearchResult[]> {
  const intent = dateOptions?.range ? undefined : extractDateIntent(query, dateOptions?.today, dateOptions?.offsetMinutes)
  const range = dateOptions?.range ?? intent
  const searchableItems = range ? filterItemsByDate(items, range, dateOptions?.field ?? 'relevant') : items
  const semanticQuery = intent?.residualQuery ?? query
  const excluded = new Set(excludeIds)
  if (!semanticQuery.trim()) return searchableItems.filter((item) => !excluded.has(item.id)).map(({ id }) => ({ id, relevance: 100 }))
  let semanticById = new Map<string, number>()
  try {
    await ensureSearchIndex(searchableItems, client, userId)
    const retrievalQuery = `Find saved personal-library items relevant to the complete meaning of: ${semanticQuery}. Treat a multi-word query as one combined intent and require all major concepts to apply. Include direct matches and genuinely related objects, products, brands, shops, references, or inspiration.`
    const queryVector = (await embed([retrievalQuery], 'query'))[0]
    const { data, error } = await client.rpc('match_memory_items', {
      query_embedding: queryVector,
      match_count: Math.min(Math.max(searchableItems.length, 1), 100),
      match_threshold: 0,
    })
    if (error) throw error
    semanticById = new Map(((data ?? []) as VectorMatch[]).map((match) => [match.id, match.similarity]))
  } catch (error) {
    console.warn('Semantic search fallback:', error instanceof Error ? error.message : 'Unknown error')
  }

  const ranked = searchableItems.filter((item) => !excluded.has(item.id)).map((item) => {
    const lexical = fuzzyScore(semanticQuery, item)
    const cosine = semanticById.get(item.id) ?? 0
    const semantic = clamp((cosine - 0.14) / 0.56)
    const blended = Math.max(lexical, semantic * 0.94, semantic * 0.72 + lexical * 0.28)
    return { id: item.id, relevance: Math.round(clamp(blended) * 100) }
  }).sort((left, right) => right.relevance - left.relevance)
  const cutoff = Math.max(24, (ranked[0]?.relevance ?? 0) - 20)
  return ranked.filter(({ relevance }) => relevance >= cutoff)
}

export function searchItemsByColour(hex: string, items: MemoryItem[], excludeIds: string[] = []): SearchResult[] {
  const targetRgb = hexRgb(hex)
  if (!targetRgb) return []
  const target = rgbLab(targetRgb)
  const excluded = new Set(excludeIds)
  const ranked = items.filter((item) => !excluded.has(item.id)).map((item) => {
    const similarities = item.palette.flatMap((hex, index) => {
      const rgb = hexRgb(hex)
      if (!rgb) return []
      // Classifier palettes are ordered by visual dominance. A secondary
      // colour may support a result, but a logo, stitch, or other tiny third
      // accent must never make an otherwise unrelated item look like a match.
      const prominence = paletteProminence[index] ?? 0.18
      const similarity = clamp(1 - colourDistance(target, rgbLab(rgb)) / colourDistanceLimit) * prominence
      return [similarity]
    })
    const similarity = similarities.length ? Math.max(...similarities) : 0
    return { id: item.id, relevance: Math.round(similarity * 100) }
  }).sort((left, right) => right.relevance - left.relevance)
  const cutoff = Math.max(minimumColourRelevance, (ranked[0]?.relevance ?? 0) - 25)
  return ranked.filter(({ relevance }) => relevance >= cutoff)
}
