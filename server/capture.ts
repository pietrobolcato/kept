import type { SupabaseClient } from '@supabase/supabase-js'
import sharp from 'sharp'
import { classify } from './classifier.js'
import { canonicalLink, fileFingerprint, imageVisualFingerprint, linkFingerprint } from './dedupe.js'
import { fetchLinkPreview, normaliseWebUrl } from './link-preview.js'
import { imageExifDate, imageExifLocation, locationWithName } from './location.js'
import { ensureSearchIndex } from './search-index.js'
import { listSpaces } from './spaces.js'
import { DuplicateMemoryItemError, findDuplicateMemoryItem, insertMemoryItem, removePrivateImage, uploadPrivateImage } from './supabase.js'
import type { ItemKind } from '../src/types.js'

async function genericVideoPoster() {
  return sharp({
    create: { width: 1280, height: 720, channels: 3, background: '#34362f' },
  }).composite([{ input: Buffer.from('<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><circle cx="640" cy="360" r="72" fill="#d6ef65"/><path d="M620 316l78 44-78 44z" fill="#34362f"/></svg>') }]).jpeg({ quality: 86 }).toBuffer()
}

export async function archiveLinkPreview(client: SupabaseClient, ownerUserId: string, preview: { imageBuffer?: Buffer }) {
  if (!preview.imageBuffer) return undefined
  const durableCover = await sharp(preview.imageBuffer, { animated: false, limitInputPixels: 80_000_000 })
    .rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80, effort: 4, smartSubsample: true }).toBuffer()
  return uploadPrivateImage(client, ownerUserId, {
    originalname: 'link-preview.webp', mimetype: 'image/webp', buffer: durableCover,
  })
}

export async function captureTextItem({
  client,
  userId,
  type,
  value,
  context,
  ownerUserId = userId,
  spaceName = '',
}: {
  client: SupabaseClient
  userId: string
  type: Extract<ItemKind, 'link' | 'note'>
  value: string
  context?: string
  ownerUserId?: string
  spaceName?: string
}) {
  const cleanValue = value.trim()
  if (!cleanValue) throw new Error('A link or note is required.')
  let savedUrl: string | undefined
  let domain: string | undefined
  let image: string | undefined
  let imageBuffer: Buffer | undefined
  let classificationInput = cleanValue
  let pageLocation: Awaited<ReturnType<typeof fetchLinkPreview>>['location']
  let contentFingerprint: string | undefined
  let canonicalUrl: string | undefined

  if (type === 'link') {
    const normalized = normaliseWebUrl(cleanValue)
    canonicalUrl = canonicalLink(normalized.href)
    contentFingerprint = linkFingerprint(normalized.href)
    const existing = await findDuplicateMemoryItem(client, ownerUserId, { contentFingerprint, canonicalUrl })
    if (existing) return { ...existing, duplicate: true }
    savedUrl = normalized.href
    domain = normalized.hostname.replace(/^www\./, '')
    try {
      const preview = await fetchLinkPreview(normalized.href)
      savedUrl = preview.url
      domain = preview.domain
      image = preview.image
      imageBuffer = preview.imageBuffer
      pageLocation = preview.location
      const resolvedCanonical = canonicalLink(preview.url)
      const resolvedFingerprint = linkFingerprint(preview.url)
      if (resolvedFingerprint !== contentFingerprint) {
        const resolvedExisting = await findDuplicateMemoryItem(client, ownerUserId, { contentFingerprint: resolvedFingerprint, canonicalUrl: resolvedCanonical })
        if (resolvedExisting) return { ...resolvedExisting, duplicate: true }
        contentFingerprint = resolvedFingerprint
        canonicalUrl = resolvedCanonical
      }
      classificationInput = [
        `URL: ${preview.url}`,
        preview.title ? `Page title: ${preview.title}` : '',
        preview.description ? `Page description: ${preview.description}` : '',
        context?.trim() ? `Saved context: ${context.trim().slice(0, 500)}` : '',
      ].filter(Boolean).join('\n')
    } catch (error) {
      console.warn(`Link preview unavailable for ${domain}:`, error instanceof Error ? error.message : 'Unknown error')
    }
  } else if (context?.trim()) {
    classificationInput = `${classificationInput}\nSaved context: ${context.trim().slice(0, 500)}`
  }

  const spaces = await listSpaces(client, ownerUserId)
  const requestedSpace = spaceName.trim().slice(0, 80)
  if (requestedSpace && !spaces.some((space) => space.name === requestedSpace)) throw new Error('That shared space is no longer available.')
  const metadata = await classify(
    classificationInput,
    type,
    undefined,
    image,
    undefined,
    undefined,
    spaces.map(({ name, description }) => ({ name, description })),
  )
  let storagePath: string | undefined
  if (type === 'link' && imageBuffer) {
    try {
      storagePath = await archiveLinkPreview(client, ownerUserId, { imageBuffer })
    } catch (error) {
      console.warn('Link preview could not be archived; keeping the remote preview:', error instanceof Error ? error.message : 'Unknown error')
    }
  }
  let item: Awaited<ReturnType<typeof insertMemoryItem>>
  try {
    item = await insertMemoryItem(client, {
      ...metadata,
      location: locationWithName(pageLocation, metadata.locationName),
      space: requestedSpace || metadata.space,
      kind: type,
      image,
      url: savedUrl,
      domain,
      createdAt: new Date().toISOString(),
      favourite: false,
      source: type === 'link' ? 'Browser' : 'Quick note',
      contentFingerprint,
    }, storagePath, ownerUserId)
  } catch (error) {
    if (storagePath) await removePrivateImage(client, storagePath)
    if (error instanceof DuplicateMemoryItemError && type === 'link') {
      const existing = await findDuplicateMemoryItem(client, ownerUserId, { contentFingerprint, canonicalUrl })
      if (existing) return { ...existing, duplicate: true }
    }
    throw error
  }
  void ensureSearchIndex([item], client, ownerUserId).catch((error) => {
    console.warn('New item indexing delayed:', error instanceof Error ? error.message : 'Unknown error')
  })
  return item
}

export async function captureImageItem({
  client,
  userId,
  buffer,
  mimeType,
  filename,
  hint = '',
  ownerUserId = userId,
  spaceName = '',
  capturedAt,
  capturedAtSource,
  sourceUrl,
}: {
  client: SupabaseClient
  userId: string
  buffer: Buffer
  mimeType: string
  filename: string
  hint?: string
  ownerUserId?: string
  spaceName?: string
  capturedAt?: string
  capturedAtSource?: 'apple_photos' | 'manual'
  sourceUrl?: string
}) {
  const requestedSpace = spaceName.trim().slice(0, 80)
  let storagePath: string | undefined
  try {
    const [exifLocation, exifDate, visualFingerprint] = await Promise.all([imageExifLocation(buffer), imageExifDate(buffer), imageVisualFingerprint(buffer)])
    const contentFingerprint = fileFingerprint(buffer)
    const existing = await findDuplicateMemoryItem(client, ownerUserId, { contentFingerprint, visualFingerprint })
    if (existing) return { ...existing, duplicate: true }
    const optimized = await sharp(buffer, { animated: false, limitInputPixels: 80_000_000 })
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76, effort: 4, smartSubsample: true })
      .toBuffer()
    const spaces = await listSpaces(client, ownerUserId)
    if (requestedSpace && !spaces.some((space) => space.name === requestedSpace)) throw new Error('That shared space is no longer available.')
    const filenameHint = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
    const metadata = await classify(
      hint.trim() || filenameHint || 'Photo shared from Telegram',
      'image',
      undefined,
      undefined,
      optimized,
      'image/webp',
      spaces.map(({ name, description }) => ({ name, description })),
    )
    storagePath = await uploadPrivateImage(client, ownerUserId, {
      originalname: filename.replace(/\.[^.]+$/, '') + '.webp',
      mimetype: 'image/webp',
      buffer: optimized,
    })
    const item = await insertMemoryItem(client, {
      ...metadata,
      location: locationWithName(exifLocation, metadata.locationName),
      space: requestedSpace || metadata.space,
      kind: 'image',
      capturedAt: capturedAt ?? exifDate,
      capturedAtSource: capturedAt ? (capturedAtSource ?? 'manual') : exifDate ? 'exif' : undefined,
      createdAt: new Date().toISOString(),
      favourite: false,
      source: 'Upload',
      url: sourceUrl,
      domain: sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, '') : undefined,
      contentFingerprint,
      visualFingerprint,
    }, storagePath, ownerUserId)
    void ensureSearchIndex([item], client, ownerUserId).catch((error) => {
      console.warn('New image indexing delayed:', error instanceof Error ? error.message : 'Unknown error')
    })
    return item
  } catch (error) {
    if (storagePath) await removePrivateImage(client, storagePath)
    if (error instanceof DuplicateMemoryItemError) {
      const existing = await findDuplicateMemoryItem(client, ownerUserId, {
        contentFingerprint: fileFingerprint(buffer),
        visualFingerprint: await imageVisualFingerprint(buffer),
      })
      if (existing) return { ...existing, duplicate: true }
    }
    if (error instanceof Error && /unsupported image|Input buffer contains unsupported image format/i.test(error.message)) {
      throw new Error(`That ${mimeType || 'image'} format is not supported yet. Send it as a regular Telegram photo instead.`, { cause: error })
    }
    throw error
  }
}

export async function captureVideoItem({
  client,
  userId,
  posterBuffer,
  videoBuffer,
  videoStoragePath: suppliedVideoPath,
  videoMimeType,
  filename,
  hint = '',
  contentFingerprint: suppliedFingerprint,
  ownerUserId = userId,
  spaceName = '',
  capturedAt,
  capturedAtSource,
}: {
  client: SupabaseClient
  userId: string
  posterBuffer?: Buffer
  videoBuffer?: Buffer
  videoStoragePath?: string
  videoMimeType: string
  filename: string
  hint?: string
  contentFingerprint?: string
  ownerUserId?: string
  spaceName?: string
  capturedAt?: string
  capturedAtSource?: 'apple_photos' | 'manual'
}) {
  if (!videoBuffer && !suppliedVideoPath) throw new Error('A video file is required.')
  if (suppliedVideoPath && !suppliedVideoPath.startsWith(`${ownerUserId}/`)) throw new Error('That uploaded video does not belong to the selected library.')
  const requestedSpace = spaceName.trim().slice(0, 80)
  const contentFingerprint = videoBuffer ? fileFingerprint(videoBuffer) : suppliedFingerprint
  if (!contentFingerprint || !/^[0-9a-f]{64}$/i.test(contentFingerprint)) throw new Error('That video fingerprint is invalid.')
  let videoStoragePath = suppliedVideoPath
  let posterStoragePath: string | undefined
  try {
    const existing = await findDuplicateMemoryItem(client, ownerUserId, { contentFingerprint })
    if (existing) {
      if (suppliedVideoPath) await removePrivateImage(client, suppliedVideoPath)
      return { ...existing, duplicate: true }
    }
    if (!videoStoragePath && videoBuffer) {
      videoStoragePath = await uploadPrivateImage(client, ownerUserId, { originalname: filename, mimetype: videoMimeType, buffer: videoBuffer })
    }
    const poster = posterBuffer?.length ? posterBuffer : await genericVideoPoster()
    const optimizedPoster = await sharp(poster, { animated: false, limitInputPixels: 80_000_000 })
      .rotate().resize({ width: 1600, height: 1000, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 4, smartSubsample: true }).toBuffer()
    const visualFingerprint = await imageVisualFingerprint(optimizedPoster)
    const spaces = await listSpaces(client, ownerUserId)
    if (requestedSpace && !spaces.some((space) => space.name === requestedSpace)) throw new Error('That shared space is no longer available.')
    const filenameHint = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
    const metadata = await classify(
      hint.trim() || filenameHint || 'Saved video',
      'video', undefined, undefined, optimizedPoster, 'image/webp',
      spaces.map(({ name, description }) => ({ name, description })),
    )
    posterStoragePath = await uploadPrivateImage(client, ownerUserId, { originalname: `${filename.replace(/\.[^.]+$/, '')}-poster.webp`, mimetype: 'image/webp', buffer: optimizedPoster })
    const item = await insertMemoryItem(client, {
      ...metadata,
      space: requestedSpace || metadata.space,
      kind: 'video',
      videoMimeType,
      videoStoragePath,
      capturedAt,
      capturedAtSource: capturedAt ? (capturedAtSource ?? 'manual') : undefined,
      createdAt: new Date().toISOString(),
      favourite: false,
      source: 'Upload',
      contentFingerprint,
      visualFingerprint,
    }, posterStoragePath, ownerUserId)
    void ensureSearchIndex([item], client, ownerUserId).catch((error) => console.warn('New video indexing delayed:', error instanceof Error ? error.message : 'Unknown error'))
    return item
  } catch (error) {
    if (posterStoragePath) await removePrivateImage(client, posterStoragePath)
    if (videoStoragePath) await removePrivateImage(client, videoStoragePath)
    if (error instanceof DuplicateMemoryItemError) {
      const existing = await findDuplicateMemoryItem(client, ownerUserId, { contentFingerprint })
      if (existing) return { ...existing, duplicate: true }
    }
    throw error
  }
}
