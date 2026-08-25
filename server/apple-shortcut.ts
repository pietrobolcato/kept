import crypto from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { captureImageItem, captureTextItem, captureVideoItem } from './capture.js'
import { createServiceClient, type AuthContext } from './supabase.js'

type ShortcutConnection = { id: string; userId: string; deviceName: string }
type ShortcutDestination = { id: string; label: string; ownerUserId: string; spaceName: string }

const pairLifetimeMs = 10 * 60 * 1000
const supportedImages = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'])
const supportedVideos = new Set(['video/mp4', 'video/quicktime', 'video/webm'])
const imageBucket = 'kept-images'

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function auth(response: Response) {
  return response.locals.auth as AuthContext
}

function configured() {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function cleanDeviceName(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Apple device' : 'Apple device'
}

function cleanFilename(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback
  const printable = [...value].filter((character) => character.charCodeAt(0) >= 32).join('')
  const cleaned = printable.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180)
  return cleaned || fallback
}

function fileExtension(contentType: string, kind: 'image' | 'video') {
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  if (contentType === 'image/heic' || contentType === 'image/heif') return 'heic'
  if (contentType === 'video/quicktime') return 'mov'
  if (contentType === 'video/webm') return 'webm'
  return kind === 'video' ? 'mp4' : 'jpg'
}

function appOrigin(request: Request) {
  const configuredOrigin = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, '')
  if (configuredOrigin) return configuredOrigin
  const forwardedProtocol = request.header('x-forwarded-proto')?.split(',')[0]?.trim()
  const protocol = forwardedProtocol || request.protocol
  return `${protocol}://${request.get('host')}`
}

function encodeDestination(ownerUserId: string, spaceName: string) {
  return Buffer.from(JSON.stringify({ ownerUserId, spaceName }), 'utf8').toString('base64url')
}

function ownerDisplayName(user: { email?: string | null; user_metadata?: Record<string, unknown> } | null) {
  const metadata = user?.user_metadata
  const explicit = typeof metadata?.full_name === 'string' ? metadata.full_name : typeof metadata?.name === 'string' ? metadata.name : ''
  const value = explicit.trim() || user?.email?.split('@')[0] || 'Shared'
  return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

async function shortcutDestinations(client: SupabaseClient, userId: string): Promise<ShortcutDestination[]> {
  const [libraryResult, directResult] = await Promise.all([
    client.from('library_members').select('owner_user_id').eq('member_user_id', userId).eq('can_add', true),
    client.from('space_members').select('owner_user_id,space_name').eq('member_user_id', userId).eq('can_add', true),
  ])
  if (libraryResult.error) throw new Error(`Shortcut libraries could not be loaded: ${libraryResult.error.message}`)
  if (directResult.error) throw new Error(`Shortcut shared spaces could not be loaded: ${directResult.error.message}`)

  const libraryOwnerIds = new Set((libraryResult.data ?? []).map((row) => row.owner_user_id as string))
  const relevantOwnerIds = new Set([userId, ...libraryOwnerIds, ...(directResult.data ?? []).map((row) => row.owner_user_id as string)])
  const labels = new Map<string, string>([[userId, 'My library']])
  await Promise.all([...relevantOwnerIds].filter((id) => id !== userId).map(async (id) => {
    const { data } = await client.auth.admin.getUserById(id)
    labels.set(id, `${ownerDisplayName(data.user)}’s library`)
  }))

  const destinations: ShortcutDestination[] = [{
    id: encodeDestination(userId, ''), label: 'My library', ownerUserId: userId, spaceName: '',
  }]
  for (const ownerUserId of libraryOwnerIds) destinations.push({
    id: encodeDestination(ownerUserId, ''), label: labels.get(ownerUserId) ?? 'Shared library', ownerUserId, spaceName: '',
  })
  const directSpaces = (directResult.data ?? []).filter((row) => !libraryOwnerIds.has(row.owner_user_id as string))
    .sort((left, right) => {
      const leftLabel = `${labels.get(left.owner_user_id as string) ?? ''} ${left.space_name}`
      const rightLabel = `${labels.get(right.owner_user_id as string) ?? ''} ${right.space_name}`
      return leftLabel.localeCompare(rightLabel)
  })
  for (const row of directSpaces) {
    const ownerUserId = row.owner_user_id as string
    const spaceName = row.space_name as string
    const ownerLabel = labels.get(ownerUserId) ?? 'Shared library'
    destinations.push({ id: encodeDestination(ownerUserId, spaceName), label: `${ownerLabel} · ${spaceName}`, ownerUserId, spaceName })
  }
  return destinations
}

function shortcutToken(request: Request) {
  const authorization = request.header('authorization') ?? ''
  return authorization.match(/^(?:Bearer|Shortcut)\s+([A-Za-z0-9_-]{32,180})$/i)?.[1]
}

async function authenticateShortcut(request: Request): Promise<{ client: SupabaseClient; connection: ShortcutConnection }> {
  const token = shortcutToken(request)
  if (!token) throw new Error('This Shortcut is not connected to Kept.')
  const client = createServiceClient()
  const { data, error } = await client.from('apple_shortcut_connections')
    .select('id,user_id,device_name').eq('token_hash', digest(token)).maybeSingle()
  if (error) throw new Error(`Shortcut connection could not be checked: ${error.message}`)
  if (!data) throw new Error('This Shortcut connection was revoked. Reconnect it from Kept.')
  return { client, connection: { id: data.id, userId: data.user_id, deviceName: data.device_name } }
}

async function captureDestination(client: SupabaseClient, userId: string, destinationId: unknown) {
  if (typeof destinationId !== 'string') throw new Error('Choose where this item should be kept.')
  const destination = (await shortcutDestinations(client, userId)).find(({ id }) => id === destinationId)
  if (!destination) throw new Error('That destination is no longer available.')
  return destination
}

function captureReceipt(item: { title: string; space: string; duplicate?: boolean }, destination: ShortcutDestination) {
  return {
    ok: true,
    duplicate: Boolean(item.duplicate),
    title: item.title,
    space: item.space,
    destination: destination.label.split(' · ')[0],
    receipt: item.duplicate ? `Already kept · ${item.title}` : `Saved · ${item.title}`,
  }
}

export function createAppleShortcutPublicRouter() {
  const router = Router()

  router.post('/apple-shortcut/pair', async (request, response) => {
    if (!configured()) return response.status(503).json({ error: 'Apple Shortcut capture is not configured on this Kept server.' })
    const code = typeof request.body?.code === 'string' ? request.body.code : ''
    if (!/^[A-Za-z0-9_-]{24,180}$/.test(code)) return response.status(400).json({ error: 'That pairing code is invalid.' })
    try {
      const client = createServiceClient()
      const { data: pairing, error } = await client.from('apple_shortcut_pairing_codes')
        .select('id,user_id,expires_at,used_at').eq('code_hash', digest(code)).maybeSingle()
      if (error) throw new Error(`Shortcut pairing could not be checked: ${error.message}`)
      if (!pairing || pairing.used_at || new Date(pairing.expires_at).getTime() <= Date.now()) {
        return response.status(410).json({ error: 'That pairing link expired. Create a new one in Kept.' })
      }
      const token = crypto.randomBytes(32).toString('base64url')
      const { error: revokeError } = await client.from('apple_shortcut_connections').delete().eq('user_id', pairing.user_id)
      if (revokeError) throw new Error(`The previous Shortcut connection could not be replaced: ${revokeError.message}`)
      const { data: connection, error: connectionError } = await client.from('apple_shortcut_connections').insert({
        user_id: pairing.user_id,
        token_hash: digest(token),
        device_name: cleanDeviceName(request.body?.deviceName),
        last_used_at: new Date().toISOString(),
      }).select('id').single()
      if (connectionError) throw new Error(`Shortcut connection could not be created: ${connectionError.message}`)
      const { data: used, error: usedError } = await client.from('apple_shortcut_pairing_codes')
        .update({ used_at: new Date().toISOString() }).eq('id', pairing.id).is('used_at', null).select('id').maybeSingle()
      if (usedError || !used) {
        await client.from('apple_shortcut_connections').delete().eq('id', connection.id)
        throw new Error(usedError ? `Shortcut pairing could not be finalised: ${usedError.message}` : 'That pairing code was already used.')
      }
      response.status(201).json({ token, baseUrl: appOrigin(request), connected: true })
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : 'The Shortcut could not be connected.' })
    }
  })

  router.get('/apple-shortcut/destinations', async (request, response) => {
    try {
      const { client, connection } = await authenticateShortcut(request)
      const destinations = await shortcutDestinations(client, connection.userId)
      const choices = Object.fromEntries(destinations.map(({ label, id }) => [label, id]))
      await client.from('apple_shortcut_connections').update({ last_used_at: new Date().toISOString() }).eq('id', connection.id)
      response.json({ choices, defaultDestination: destinations.length === 1 ? destinations[0].id : '' })
    } catch (error) {
      response.status(401).json({ error: error instanceof Error ? error.message : 'The Shortcut is not connected.' })
    }
  })

  router.post('/apple-shortcut/capture', async (request, response) => {
    try {
      const { client, connection } = await authenticateShortcut(request)
      const destination = await captureDestination(client, connection.userId, request.body?.destination)
      const type = request.body?.type === 'link' ? 'link' : 'note'
      const value = typeof request.body?.value === 'string' ? request.body.value.trim() : ''
      if (!value) return response.status(400).json({ error: 'Share a link or some text to Kept.' })
      const item = await captureTextItem({
        client, userId: connection.userId, type, value,
        ownerUserId: destination.ownerUserId, spaceName: destination.spaceName,
      })
      await client.from('apple_shortcut_connections').update({ last_used_at: new Date().toISOString() }).eq('id', connection.id)
      response.status(item.duplicate ? 200 : 201).json(captureReceipt(item, destination))
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : 'That item could not be saved.' })
    }
  })

  router.post('/apple-shortcut/upload-ticket', async (request, response) => {
    try {
      const { client, connection } = await authenticateShortcut(request)
      const destination = await captureDestination(client, connection.userId, request.body?.destination)
      const kind = request.body?.kind === 'video' ? 'video' : 'image'
      const contentType = typeof request.body?.contentType === 'string' ? request.body.contentType.toLowerCase() : ''
      const fingerprint = typeof request.body?.contentFingerprint === 'string' ? request.body.contentFingerprint.toLowerCase() : ''
      if (kind === 'image' && !supportedImages.has(contentType)) return response.status(415).json({ error: 'Share that image as a photo or JPEG instead.' })
      if (kind === 'video' && !supportedVideos.has(contentType)) return response.status(415).json({ error: 'Kept currently supports MP4, MOV and WebM video.' })
      if (!/^[0-9a-f]{64}$/.test(fingerprint)) return response.status(400).json({ error: 'That shared file fingerprint is invalid.' })
      const filename = cleanFilename(request.body?.filename, kind === 'video' ? 'shared-video.mp4' : 'shared-image.jpg')
      const storagePath = `${destination.ownerUserId}/shortcut-staging/${connection.id}/${crypto.randomUUID()}.${fileExtension(contentType, kind)}`
      const { data, error } = await client.storage.from(imageBucket).createSignedUploadUrl(storagePath, { upsert: false })
      if (error || !data?.signedUrl) throw new Error(`Shortcut upload could not be prepared: ${error?.message ?? 'No signed URL was returned.'}`)
      response.status(201).json({ uploadUrl: data.signedUrl, storagePath, kind, contentType, filename, contentFingerprint: fingerprint })
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : 'That upload could not be prepared.' })
    }
  })

  router.post('/apple-shortcut/capture-staged', async (request, response) => {
    let stagedPath = ''
    try {
      const { client, connection } = await authenticateShortcut(request)
      const destination = await captureDestination(client, connection.userId, request.body?.destination)
      const kind = request.body?.kind === 'video' ? 'video' : 'image'
      const contentType = typeof request.body?.contentType === 'string' ? request.body.contentType.toLowerCase() : ''
      const fingerprint = typeof request.body?.contentFingerprint === 'string' ? request.body.contentFingerprint.toLowerCase() : ''
      const filename = cleanFilename(request.body?.filename, kind === 'video' ? 'shared-video.mp4' : 'shared-image.jpg')
      stagedPath = typeof request.body?.storagePath === 'string' ? request.body.storagePath : ''
      const requiredPrefix = `${destination.ownerUserId}/shortcut-staging/${connection.id}/`
      if (!stagedPath.startsWith(requiredPrefix) || stagedPath.includes('..')) return response.status(403).json({ error: 'That staged upload does not belong to this Shortcut connection.' })
      if (!/^[0-9a-f]{64}$/.test(fingerprint)) return response.status(400).json({ error: 'That shared file fingerprint is invalid.' })
      if (kind === 'image' && !supportedImages.has(contentType)) return response.status(415).json({ error: 'That staged image type is not supported.' })
      if (kind === 'video' && !supportedVideos.has(contentType)) return response.status(415).json({ error: 'That staged video type is not supported.' })

      let item
      if (kind === 'image') {
        const { data, error } = await client.storage.from(imageBucket).download(stagedPath)
        if (error || !data) throw new Error(`That staged photo could not be read: ${error?.message ?? 'No file was returned.'}`)
        const buffer = Buffer.from(await data.arrayBuffer())
        item = await captureImageItem({ client, userId: connection.userId, buffer, mimeType: contentType, filename, ownerUserId: destination.ownerUserId, spaceName: destination.spaceName })
        await client.storage.from(imageBucket).remove([stagedPath])
        stagedPath = ''
      } else {
        const finalPath = `${destination.ownerUserId}/${crypto.randomUUID()}.${fileExtension(contentType, kind)}`
        const { error: moveError } = await client.storage.from(imageBucket).move(stagedPath, finalPath)
        if (moveError) throw new Error(`That staged video could not be finalised: ${moveError.message}`)
        stagedPath = ''
        item = await captureVideoItem({
          client, userId: connection.userId, videoStoragePath: finalPath, videoMimeType: contentType,
          filename, contentFingerprint: fingerprint, ownerUserId: destination.ownerUserId, spaceName: destination.spaceName,
        })
      }
      await client.from('apple_shortcut_connections').update({ last_used_at: new Date().toISOString() }).eq('id', connection.id)
      response.status(item.duplicate ? 200 : 201).json(captureReceipt(item, destination))
    } catch (error) {
      if (stagedPath) {
        try { await createServiceClient().storage.from(imageBucket).remove([stagedPath]) } catch { /* Best-effort staging cleanup. */ }
      }
      response.status(503).json({ error: error instanceof Error ? error.message : 'That file could not be saved.' })
    }
  })

  return router
}

export function createAppleShortcutPrivateRouter() {
  const router = Router()

  router.get('/integrations/apple-shortcut', async (_request, response) => {
    const { client } = auth(response)
    const { data, error } = await client.from('apple_shortcut_connections')
      .select('id,device_name,created_at,last_used_at').order('created_at', { ascending: false })
    if (error) return response.status(503).json({ error: `Shortcut connections could not be loaded: ${error.message}` })
    response.json({ enabled: configured(), connected: Boolean(data?.length), connections: data ?? [] })
  })

  router.post('/integrations/apple-shortcut/pairing', async (request, response) => {
    if (!configured()) return response.status(503).json({ error: 'Apple Shortcut capture needs SUPABASE_SERVICE_ROLE_KEY on the server.' })
    const { client, user } = auth(response)
    const code = crypto.randomBytes(24).toString('base64url')
    const expiresAt = new Date(Date.now() + pairLifetimeMs).toISOString()
    await client.from('apple_shortcut_pairing_codes').delete().eq('user_id', user.id).is('used_at', null)
    const { error } = await client.from('apple_shortcut_pairing_codes').insert({ user_id: user.id, code_hash: digest(code), expires_at: expiresAt })
    if (error) return response.status(503).json({ error: `Shortcut pairing could not be created: ${error.message}` })
    const origin = appOrigin(request)
    const payload = JSON.stringify({ keptPair: code, baseUrl: origin })
    // iOS installs the signed artifact using its exported filename. Keep this
    // exact so the deep link resolves the Shortcut already visible on-device.
    const runUrl = `shortcuts://run-shortcut?name=${encodeURIComponent('Keep-in-Kept')}&input=text&text=${encodeURIComponent(payload)}`
    response.status(201).json({ runUrl, expiresAt, installUrl: `${origin}/downloads/Keep-in-Kept.shortcut` })
  })

  router.delete('/integrations/apple-shortcut/:id', async (request, response) => {
    const { client, user } = auth(response)
    const { data, error } = await client.from('apple_shortcut_connections').delete()
      .eq('id', request.params.id).eq('user_id', user.id).select('id').maybeSingle()
    if (error) return response.status(503).json({ error: `That Shortcut connection could not be revoked: ${error.message}` })
    if (!data) return response.status(404).json({ error: 'That Shortcut connection no longer exists.' })
    response.status(204).end()
  })

  return router
}
