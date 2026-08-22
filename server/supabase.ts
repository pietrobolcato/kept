import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { MemoryItem } from '../src/types.js'
import { canonicalLink, fingerprintDistance } from './dedupe.js'

const itemColumns = 'id,user_id,title,description,kind,image_url,storage_path,video_storage_path,video_mime_type,source_url,domain,space,tags,palette,created_at,captured_at,captured_at_source,favourite,source,ai_confidence,search_terms,location_name,location_latitude,location_longitude,location_source,content_fingerprint,visual_fingerprint'
const imageBucket = 'kept-images'

interface MemoryRow {
  id: string
  user_id: string
  title: string
  description: string
  kind: MemoryItem['kind']
  image_url: string | null
  storage_path: string | null
  video_storage_path: string | null
  video_mime_type: string | null
  source_url: string | null
  domain: string | null
  space: string
  tags: string[] | null
  palette: string[] | null
  created_at: string
  captured_at: string | null
  captured_at_source: MemoryItem['capturedAtSource'] | null
  favourite: boolean
  source: MemoryItem['source']
  ai_confidence: number
  search_terms: string[] | null
  location_name: string | null
  location_latitude: number | null
  location_longitude: number | null
  location_source: NonNullable<MemoryItem['location']>['source'] | null
  content_fingerprint: string | null
  visual_fingerprint: string | null
}

type NewMemoryItem = Omit<MemoryItem, 'id' | 'duplicate'> & {
  contentFingerprint?: string
  visualFingerprint?: string
  videoStoragePath?: string
}

export class DuplicateMemoryItemError extends Error {
  constructor() { super('That item is already in this library.') }
}

export interface AuthContext {
  client: SupabaseClient
  user: User
  accessToken: string
}

function configuration() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY.')
  return { url, key }
}

export function createServiceClient() {
  const { url } = configuration()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('Supabase service access is not configured.')
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
}

export function createUserClient(accessToken: string) {
  const { url, key } = configuration()
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
}

export async function authenticate(accessToken: string): Promise<AuthContext> {
  const client = createUserClient(accessToken)
  const { data, error } = await client.auth.getUser(accessToken)
  if (error || !data.user) throw new Error('Your session has expired. Sign in again.')
  return { client, user: data.user, accessToken }
}

function fromRow(row: MemoryRow, signedUrl?: string, signedVideoUrl?: string): MemoryItem {
  return {
    id: row.id,
    ownerId: row.user_id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    image: signedUrl ?? row.image_url ?? undefined,
    video: signedVideoUrl,
    videoMimeType: row.video_mime_type ?? undefined,
    url: row.source_url ?? undefined,
    domain: row.domain ?? undefined,
    space: row.space,
    tags: row.tags ?? [],
    palette: row.palette ?? [],
    createdAt: row.created_at,
    capturedAt: row.captured_at ?? undefined,
    capturedAtSource: row.captured_at_source ?? undefined,
    favourite: row.favourite,
    source: row.source,
    aiConfidence: row.ai_confidence,
    searchTerms: row.search_terms ?? [],
    location: (row.location_name || (row.location_latitude != null && row.location_longitude != null)) ? {
      name: row.location_name ?? undefined,
      latitude: row.location_latitude ?? undefined,
      longitude: row.location_longitude ?? undefined,
      source: row.location_source ?? 'inferred',
    } : undefined,
  }
}

async function materializeRows(client: SupabaseClient, rows: MemoryRow[]) {
  const paths = [...new Set(rows.flatMap((row) => [row.storage_path, row.video_storage_path]).filter((path): path is string => Boolean(path)))]
  const signedByPath = new Map<string, string>()
  if (paths.length) {
    const { data, error } = await client.storage.from(imageBucket).createSignedUrls(paths, 24 * 60 * 60)
    if (error) console.warn('Private image URLs could not be signed:', error.message)
    for (const result of data ?? []) if (result.path && result.signedUrl) signedByPath.set(result.path, result.signedUrl)
  }
  return rows.map((row) => fromRow(row, row.storage_path ? signedByPath.get(row.storage_path) : undefined, row.video_storage_path ? signedByPath.get(row.video_storage_path) : undefined))
}

export async function listMemoryItems(client: SupabaseClient): Promise<MemoryItem[]> {
  const { data, error } = await client.from('memory_items').select(itemColumns).order('created_at', { ascending: false })
  if (error) throw new Error(`Could not load your library: ${error.message}`)
  return materializeRows(client, (data ?? []) as MemoryRow[])
}

function toRow(item: NewMemoryItem, storagePath?: string, ownerUserId?: string) {
  return {
    ...(ownerUserId ? { user_id: ownerUserId } : {}),
    title: item.title,
    description: item.description,
    kind: item.kind,
    image_url: storagePath ? null : item.image ?? null,
    storage_path: storagePath ?? null,
    video_storage_path: item.videoStoragePath ?? null,
    video_mime_type: item.videoMimeType ?? null,
    source_url: item.url ?? null,
    domain: item.domain ?? null,
    space: item.space,
    tags: item.tags,
    palette: item.palette,
    created_at: item.createdAt,
    captured_at: item.capturedAt ?? null,
    captured_at_source: item.capturedAtSource ?? null,
    favourite: item.favourite,
    source: item.source,
    ai_confidence: item.aiConfidence,
    search_terms: item.searchTerms,
    location_name: item.location?.name?.slice(0, 240) ?? null,
    location_latitude: item.location?.latitude ?? null,
    location_longitude: item.location?.longitude ?? null,
    location_source: item.location?.source ?? null,
    content_fingerprint: item.contentFingerprint ?? null,
    visual_fingerprint: item.visualFingerprint ?? null,
  }
}

export async function insertMemoryItem(client: SupabaseClient, item: NewMemoryItem, storagePath?: string, ownerUserId?: string) {
  const { data, error } = await client.from('memory_items').insert(toRow(item, storagePath, ownerUserId)).select(itemColumns).single()
  if (error?.code === '23505' && /content_fingerprint/i.test(`${error.message} ${error.details ?? ''}`)) throw new DuplicateMemoryItemError()
  if (error) throw new Error(`Could not save that item: ${error.message}`)
  return (await materializeRows(client, [data as MemoryRow]))[0]
}

export async function insertMemoryItems(client: SupabaseClient, items: NewMemoryItem[]) {
  if (!items.length) return []
  const { data, error } = await client.from('memory_items').insert(items.map((item) => toRow(item))).select(itemColumns)
  if (error) throw new Error(`Could not save those items: ${error.message}`)
  return materializeRows(client, (data ?? []) as MemoryRow[])
}

export async function findDuplicateMemoryItem(client: SupabaseClient, ownerUserId: string, {
  contentFingerprint,
  visualFingerprint,
  canonicalUrl,
}: {
  contentFingerprint?: string
  visualFingerprint?: string
  canonicalUrl?: string
}) {
  if (contentFingerprint) {
    const { data, error } = await client.from('memory_items').select(itemColumns)
      .eq('user_id', ownerUserId).eq('content_fingerprint', contentFingerprint).maybeSingle()
    if (error) throw new Error(`Could not check for an existing item: ${error.message}`)
    if (data) return (await materializeRows(client, [data as MemoryRow]))[0]
  }

  if (canonicalUrl) {
    const { data, error } = await client.from('memory_items').select(itemColumns)
      .eq('user_id', ownerUserId).eq('kind', 'link').not('source_url', 'is', null)
    if (error) throw new Error(`Could not check existing links: ${error.message}`)
    const matching = ((data ?? []) as MemoryRow[]).find((row) => {
      try { return Boolean(row.source_url) && canonicalLink(row.source_url!) === canonicalUrl } catch { return false }
    })
    if (matching) {
      if (!matching.content_fingerprint && contentFingerprint) {
        void client.from('memory_items').update({ content_fingerprint: contentFingerprint }).eq('id', matching.id)
      }
      return (await materializeRows(client, [matching]))[0]
    }
  }

  if (visualFingerprint) {
    const { data, error } = await client.from('memory_items').select(itemColumns)
      .eq('user_id', ownerUserId).eq('kind', 'image').not('visual_fingerprint', 'is', null).limit(2_000)
    if (error) throw new Error(`Could not check existing photos: ${error.message}`)
    const matching = ((data ?? []) as MemoryRow[])
      .map((row) => ({ row, distance: fingerprintDistance(visualFingerprint, row.visual_fingerprint ?? '') }))
      .filter(({ distance }) => distance <= 6)
      .sort((left, right) => left.distance - right.distance)[0]?.row
    if (matching) return (await materializeRows(client, [matching]))[0]
  }
  return undefined
}

export type MemoryPatch = Partial<Pick<MemoryItem, 'title' | 'description' | 'space' | 'tags' | 'palette' | 'favourite' | 'searchTerms'>> & { location?: MemoryItem['location'] | null }

export async function updateMemoryItem(client: SupabaseClient, id: string, patch: MemoryPatch) {
  const row: Record<string, unknown> = {}
  if (typeof patch.title === 'string') row.title = patch.title.slice(0, 160)
  if (typeof patch.description === 'string') row.description = patch.description.slice(0, 4000)
  if (typeof patch.space === 'string') row.space = patch.space.slice(0, 80)
  if (Array.isArray(patch.tags)) row.tags = patch.tags.filter((value) => typeof value === 'string').slice(0, 20)
  if (Array.isArray(patch.palette)) row.palette = patch.palette.filter((value) => typeof value === 'string').slice(0, 8)
  if (typeof patch.favourite === 'boolean') row.favourite = patch.favourite
  if (Array.isArray(patch.searchTerms)) row.search_terms = patch.searchTerms.filter((value) => typeof value === 'string').slice(0, 20)
  if (patch.location === null) {
    row.location_name = null; row.location_latitude = null; row.location_longitude = null; row.location_source = null
  } else if (patch.location && typeof patch.location === 'object') {
    const latitude = typeof patch.location.latitude === 'number' && Number.isFinite(patch.location.latitude) && Math.abs(patch.location.latitude) <= 90 ? patch.location.latitude : null
    const longitude = typeof patch.location.longitude === 'number' && Number.isFinite(patch.location.longitude) && Math.abs(patch.location.longitude) <= 180 ? patch.location.longitude : null
    row.location_name = typeof patch.location.name === 'string' ? patch.location.name.trim().slice(0, 240) || null : null
    row.location_latitude = latitude != null && longitude != null ? latitude : null
    row.location_longitude = latitude != null && longitude != null ? longitude : null
    row.location_source = ['exif', 'page', 'inferred', 'manual'].includes(patch.location.source) ? patch.location.source : 'manual'
  }
  if (!Object.keys(row).length) throw new Error('There is nothing to update.')

  const { data, error } = await client.from('memory_items').update(row).eq('id', id).select(itemColumns).maybeSingle()
  if (error) throw new Error(`Could not update that item: ${error.message}`)
  if (!data) return undefined
  return (await materializeRows(client, [data as MemoryRow]))[0]
}

export async function updateMemoryItemPreview(client: SupabaseClient, id: string, { image, storagePath }: { image?: string; storagePath?: string }) {
  const { data: existing, error: inspectError } = await client.from('memory_items').select('storage_path').eq('id', id).maybeSingle()
  if (inspectError) throw new Error(`Could not inspect that preview: ${inspectError.message}`)
  const { data, error } = await client.from('memory_items').update({
    image_url: storagePath ? null : image?.slice(0, 4_000) ?? null,
    storage_path: storagePath ?? null,
  }).eq('id', id).select(itemColumns).maybeSingle()
  if (error) throw new Error(`Could not update that preview: ${error.message}`)
  if (!data) return undefined
  if (existing?.storage_path && existing.storage_path !== storagePath) await removePrivateImage(client, existing.storage_path)
  return (await materializeRows(client, [data as MemoryRow]))[0]
}

export async function deleteMemoryItem(client: SupabaseClient, id: string) {
  const { data: existing, error: inspectError } = await client.from('memory_items').select('id,storage_path,video_storage_path').eq('id', id).maybeSingle()
  if (inspectError) throw new Error(`Could not inspect that item: ${inspectError.message}`)
  if (!existing) return false
  // Storage collaboration policies resolve permission through the memory row, so
  // remove the private object while that relationship is still available.
  if (existing.storage_path) await removePrivateImage(client, existing.storage_path)
  if (existing.video_storage_path) await removePrivateImage(client, existing.video_storage_path)
  const { data, error } = await client.from('memory_items').delete().eq('id', id).select('id').maybeSingle()
  if (error) throw new Error(`Could not delete that item: ${error.message}`)
  if (!data) return false
  return true
}

export async function uploadPrivateImage(client: SupabaseClient, userId: string, file: Pick<Express.Multer.File, 'originalname' | 'mimetype' | 'buffer'>) {
  const safeExtension = file.originalname.match(/\.(jpe?g|png|gif|webp|mp4|mov|webm)$/i)?.[0].toLowerCase()
    ?? (file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : file.mimetype === 'image/gif' ? '.gif' : file.mimetype === 'video/mp4' ? '.mp4' : file.mimetype === 'video/quicktime' ? '.mov' : file.mimetype === 'video/webm' ? '.webm' : '.jpg')
  const path = `${userId}/${crypto.randomUUID()}${safeExtension}`
  const { error } = await client.storage.from(imageBucket).upload(path, file.buffer, {
    contentType: file.mimetype,
    cacheControl: '31536000',
    upsert: false,
  })
  if (error) throw new Error(`Could not store that file: ${error.message}`)
  return path
}

export async function removePrivateImage(client: SupabaseClient, path: string) {
  const { error } = await client.storage.from(imageBucket).remove([path])
  if (error) console.warn('Unused private image could not be removed:', error.message)
}

export { imageBucket }
