import * as cheerio from 'cheerio'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import sharp from 'sharp'
import type { MemoryLocation } from '../src/types.js'

export interface LinkPreview {
  url: string
  domain: string
  title?: string
  description?: string
  image?: string
  /** Validated bytes for persisting the chosen cover rather than hotlinking it. */
  imageBuffer?: Buffer
  imageMimeType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  imageSource?: 'page' | 'reader' | 'web-search'
  location?: MemoryLocation
}

export interface LinkPreviewOptions {
  titleHint?: string
  useReader?: boolean
  useWebSearch?: boolean
}

type ImageCandidate = { url: string; score: number; context?: string }
type InspectedImage = ImageCandidate & { buffer: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; width: number; height: number; entropy: number; visualScore: number }

const MAX_BODY_BYTES = 2_000_000
const MAX_IMAGE_BYTES = 10_000_000
const MAX_REDIRECTS = 5
const browserHeaders = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control': 'no-cache',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

export function normaliseWebUrl(value: string) {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only public web links can be saved.')
  url.hash = ''
  return url
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  if (!isIP(normalized) || normalized.includes(':')) return false
  const [first, second] = normalized.split('.').map(Number)
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224
}

async function assertPublicUrl(url: URL) {
  if (url.username || url.password) throw new Error('Links with embedded credentials are not supported.')
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateAddress(hostname)) throw new Error('Only public web links can be saved.')
  const addresses = await lookup(hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('Only public web links can be saved.')
}

async function readLimitedBody(response: Response) {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_BODY_BYTES) throw new Error('That page is too large to preview.')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let output = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new Error('That page is too large to preview.')
    }
    output += decoder.decode(value, { stream: true })
  }
  return output + decoder.decode()
}

async function fetchHtml(start: URL) {
  let current = start
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicUrl(current)
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
      headers: browserHeaders,
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('The page redirected without a destination.')
      current = new URL(location, current)
      if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('The page redirected to an unsupported address.')
      continue
    }
    if (!response.ok) throw new Error(`The page returned ${response.status}.`)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new Error('That link is not an HTML page.')
    return { html: await readLimitedBody(response), url: current }
  }
  throw new Error('The page redirected too many times.')
}

function clean(value?: string | null) {
  return value?.replace(/\s+/g, ' ').trim() || undefined
}

function resolveImageUrl(value: unknown, base: URL) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const resolved = new URL(value.trim().replace(/&amp;/g, '&'), base)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined
    if (/\.(?:svg|ico)(?:$|\?)/i.test(resolved.href)) return undefined
    return resolved.href
  } catch {
    return undefined
  }
}

function isLikelyBrandAsset(url: string) {
  try {
    const resolved = new URL(url)
    const path = `${resolved.pathname} ${resolved.search}`.toLowerCase()
    return /(?:^|[\/_\-.])(logo|favicon|icon|wordmark|brandmark|logomark|sprite|badge|avatar|placeholder|colou?rswatch|swatch|play-button)(?:[\/_\-.]|$)/.test(path)
      || /[?&](?:width|w)=([1-9]\d?|1\d\d)(?:&|$)/.test(resolved.search.toLowerCase())
  } catch {
    return false
  }
}

function addCandidate(candidates: ImageCandidate[], value: unknown, base: URL, score: number, context?: string) {
  const url = resolveImageUrl(value, base)
  if (url && !isLikelyBrandAsset(url)) candidates.push({ url, score, context: clean(context) })
}

function largestSrcset(value?: string) {
  if (!value) return undefined
  return value.split(',').map((part) => {
    const [url, descriptor = '0'] = part.trim().split(/\s+/)
    const size = Number(descriptor.replace(/[^\d.]/g, '')) || 0
    return { url, size }
  }).sort((left, right) => right.size - left.size)[0]?.url
}

function collectStructuredImages(value: unknown, candidates: ImageCandidate[], base: URL, depth = 0) {
  if (depth > 7 || !value) return
  if (typeof value === 'string') {
    addCandidate(candidates, value, base, 760 - depth * 5)
    return
  }
  if (Array.isArray(value)) {
    value.slice(0, 30).forEach((entry) => collectStructuredImages(entry, candidates, base, depth + 1))
    return
  }
  if (typeof value !== 'object') return
  const object = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(object)) {
    if (/^logo$/i.test(key)) continue
    if (/^(image|thumbnailUrl|contentUrl|primaryImageOfPage)$/i.test(key)) collectStructuredImages(entry, candidates, base, depth + 1)
    else if (/^(url|@id)$/i.test(key) && ('width' in object || 'height' in object || object['@type'] === 'ImageObject')) addCandidate(candidates, entry, base, 745 - depth * 5)
    else if (typeof entry === 'object') collectStructuredImages(entry, candidates, base, depth + 1)
  }
}

function numberCoordinate(value: unknown, limit: number) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : undefined
}

function structuredLocation(value: unknown, depth = 0): MemoryLocation | undefined {
  if (!value || depth > 8) return undefined
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 30)) {
      const found = structuredLocation(entry, depth + 1)
      if (found) return found
    }
    return undefined
  }
  if (typeof value !== 'object') return undefined
  const object = value as Record<string, unknown>
  const geo = object.geo && typeof object.geo === 'object' ? object.geo as Record<string, unknown> : object
  const latitude = numberCoordinate(geo.latitude ?? geo.lat, 90)
  const longitude = numberCoordinate(geo.longitude ?? geo.lon ?? geo.lng, 180)
  const address = object.address && typeof object.address === 'object' ? object.address as Record<string, unknown> : object
  const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
    .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
    .map((part) => part.trim())
  const type = Array.isArray(object['@type']) ? object['@type'].join(' ') : String(object['@type'] ?? '')
  const placeName = /place|location|postaladdress|touristattraction|lodgingbusiness|localbusiness/i.test(type) && typeof object.name === 'string'
    ? object.name.trim()
    : undefined
  const name = [placeName, ...parts].filter(Boolean).filter((part, index, all) => all.indexOf(part) === index).join(', ').slice(0, 240) || undefined
  if (name || (latitude !== undefined && longitude !== undefined)) return { name, latitude, longitude, source: 'page' }
  for (const key of ['contentLocation', 'location', 'spatialCoverage', 'address', 'geo', '@graph']) {
    const found = structuredLocation(object[key], depth + 1)
    if (found) return found
  }
  return undefined
}

function extractHtmlPreview(html: string, url: URL) {
  const $ = cheerio.load(html)
  const candidates: ImageCandidate[] = []
  const meta = (...selectors: string[]) => {
    for (const selector of selectors) {
      const content = clean($(selector).first().attr('content'))
      if (content) return content
    }
    return undefined
  }
  ;[
    ['meta[property="og:image:secure_url"]', 1_000],
    ['meta[property="og:image"]', 980],
    ['meta[name="twitter:image"]', 960],
    ['meta[name="twitter:image:src"]', 950],
    ['meta[itemprop="image"]', 920],
  ].forEach(([selector, score]) => addCandidate(candidates, $(String(selector)).first().attr('content'), url, Number(score)))
  addCandidate(candidates, $('link[rel="image_src"]').first().attr('href'), url, 900)
  addCandidate(candidates, $('link[rel="preload"][as="image"]').first().attr('href'), url, 840)

  $('script[type="application/ld+json"]').slice(0, 20).each((_index, script) => {
    try { collectStructuredImages(JSON.parse($(script).text()) as unknown, candidates, url) } catch { /* Ignore malformed structured data. */ }
  })

  let location: MemoryLocation | undefined
  $('script[type="application/ld+json"]').slice(0, 20).each((_index, script) => {
    if (location) return
    try { location = structuredLocation(JSON.parse($(script).text()) as unknown) } catch { /* Ignore malformed structured data. */ }
  })
  const latitude = numberCoordinate(meta('meta[property="place:location:latitude"]', 'meta[name="geo.latitude"]', 'meta[itemprop="latitude"]'), 90)
  const longitude = numberCoordinate(meta('meta[property="place:location:longitude"]', 'meta[name="geo.longitude"]', 'meta[itemprop="longitude"]'), 180)
  const position = meta('meta[name="geo.position"]', 'meta[name="ICBM"]')?.split(/[;,]/).map((part) => part.trim())
  const positionLatitude = numberCoordinate(position?.[0], 90)
  const positionLongitude = numberCoordinate(position?.[1], 180)
  const placeName = meta('meta[name="geo.placename"]', 'meta[property="og:locality"]', 'meta[property="business:contact_data:locality"]')
  if (placeName || (latitude !== undefined && longitude !== undefined) || (positionLatitude !== undefined && positionLongitude !== undefined)) {
    location = {
      name: placeName ?? location?.name,
      latitude: latitude ?? positionLatitude ?? location?.latitude,
      longitude: longitude ?? positionLongitude ?? location?.longitude,
      source: 'page',
    }
  }

  $('img').slice(0, 160).each((_index, image) => {
    const element = $(image)
    const alt = `${element.attr('alt') ?? ''} ${element.attr('class') ?? ''} ${element.attr('id') ?? ''}`.toLowerCase()
    if (/logo|icon|avatar|spinner|flag|payment|badge|rating|tracking|pixel/.test(alt)) return
    const width = Number(element.attr('width') ?? element.attr('data-width') ?? 0)
    const height = Number(element.attr('height') ?? element.attr('data-height') ?? 0)
    if ((width > 0 && width < 180) || (height > 0 && height < 140)) return
    const pictureSource = element.closest('picture').find('source').toArray()
      .map((source) => largestSrcset($(source).attr('srcset') ?? $(source).attr('data-srcset')))
      .find(Boolean)
    const raw = pictureSource
      ?? largestSrcset(element.attr('srcset') ?? element.attr('data-srcset'))
      ?? element.attr('data-original')
      ?? element.attr('data-lazy-src')
      ?? element.attr('data-src')
      ?? element.attr('src')
    let score = 350
    if (/hero|product|project|main|feature|gallery|cover/.test(alt)) score += 180
    if (width >= 600 || height >= 500) score += 130
    if (width && height) score += Math.min(100, Math.round((width * height) / 20_000))
    score += Math.max(0, 80 - _index)
    addCandidate(candidates, raw, url, score, alt)
  })

  $('[style*="background"]').slice(0, 80).each((_index, node) => {
    const style = $(node).attr('style') ?? ''
    const match = style.match(/background(?:-image)?\s*:[^;]*url\(["']?([^"')]+)["']?\)/i)
    if (match) addCandidate(candidates, match[1], url, 430 - Math.min(_index, 100), `${$(node).attr('class') ?? ''} ${$(node).attr('aria-label') ?? ''}`)
  })

  return {
    title: meta('meta[property="og:title"]', 'meta[name="twitter:title"]') ?? clean($('title').first().text()),
    description: meta('meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[name="description"]'),
    candidates,
    location,
  }
}

async function fetchImage(value: string) {
  let current = normaliseWebUrl(value)
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    try {
      await assertPublicUrl(current)
      const response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
        headers: { ...browserHeaders, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) return undefined
        current = new URL(location, current)
        continue
      }
      const type = response.headers.get('content-type')?.toLowerCase() ?? ''
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (!response.ok || (!type.startsWith('image/') && type !== 'application/octet-stream') || declared > MAX_IMAGE_BYTES) {
        await response.body?.cancel()
        return undefined
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return undefined
      return bytes
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Download an already-selected preview through the same SSRF and size guards used by scraping. */
export async function fetchValidatedImage(value: string) {
  const buffer = await fetchImage(value)
  if (!buffer) return undefined
  try {
    const metadata = await sharp(buffer, { animated: false, limitInputPixels: 45_000_000 }).metadata()
    return metadata.width && metadata.height ? buffer : undefined
  } catch {
    return undefined
  }
}

async function inspectCandidate(candidate: ImageCandidate): Promise<InspectedImage | undefined> {
  const buffer = await fetchImage(candidate.url)
  if (!buffer) return undefined
  try {
    const image = sharp(buffer, { animated: false, limitInputPixels: 45_000_000 })
    const [metadata, stats] = await Promise.all([image.metadata(), image.stats()])
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    const aspect = width / Math.max(height, 1)
    const channelVariation = stats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0) / Math.max(1, Math.min(3, stats.channels.length))
    if (width < 480 || height < 280 || width * height < 220_000 || aspect < 0.42 || aspect > 3.2 || stats.entropy < 2 || channelVariation < 8) return undefined
    const format = metadata.format === 'png' ? 'image/png'
      : metadata.format === 'webp' ? 'image/webp'
        : metadata.format === 'gif' ? 'image/gif'
          : 'image/jpeg'
    const areaBonus = Math.min(260, Math.round(Math.log2((width * height) / 220_000 + 1) * 90))
    const aspectBonus = aspect >= 1.15 && aspect <= 2.15 ? 150 : aspect >= 0.75 && aspect <= 2.6 ? 75 : 0
    const detailBonus = Math.min(180, Math.round(stats.entropy * 22 + channelVariation))
    return { ...candidate, buffer, mediaType: format, width, height, entropy: stats.entropy, visualScore: candidate.score + areaBonus + aspectBonus + detailBonus }
  } catch {
    return undefined
  }
}

async function visionChoice(images: InspectedImage[], pageTitle?: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || !images.length) return undefined
  try {
    const content: Array<Record<string, unknown>> = [{
      type: 'text',
      text: `Choose the single best card-cover image for the saved page “${pageTitle || 'Untitled page'}”. Prefer a representative editorial, architecture, interior, or product photograph with a useful landscape crop. Reject logos, text-only graphics, colour swatches, blank panels, screenshots dominated by typography, and navigation UI. Reply only BEST: N, or BEST: NONE if every option is unsuitable.`,
    }]
    for (const [index, candidate] of images.entries()) {
      const thumbnail = await sharp(candidate.buffer, { animated: false })
        .rotate()
        .resize(640, 420, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer()
      content.push({ type: 'text', text: `Candidate ${index + 1} · ${candidate.width}×${candidate.height}${candidate.context ? ` · ${candidate.context.slice(0, 140)}` : ''}` })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumbnail.toString('base64') } })
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(40_000),
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
        max_tokens: 24,
        system: 'You are a strict visual editor selecting reliable, attractive preview covers. Follow the requested output format exactly.',
        messages: [{ role: 'user', content }],
      }),
    })
    if (!response.ok) return undefined
    const result = await response.json() as { content?: Array<{ type?: string; text?: string }> }
    const answer = result.content?.find((block) => block.type === 'text')?.text ?? ''
    if (/BEST\s*:\s*NONE/i.test(answer)) return null
    const choice = Number(answer.match(/BEST\s*:\s*(\d+)/i)?.[1])
    return Number.isInteger(choice) && choice >= 1 && choice <= images.length ? images[choice - 1] : undefined
  } catch {
    return undefined
  }
}

async function bestReachableImage(candidates: ImageCandidate[], pageTitle?: string) {
  const byUrl = new Map<string, ImageCandidate>()
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url)
    if (!existing || candidate.score > existing.score) byUrl.set(candidate.url, candidate)
  }
  const ranked = [...byUrl.values()].sort((left, right) => right.score - left.score).slice(0, 15)
  const inspected: InspectedImage[] = []
  for (let offset = 0; offset < ranked.length && inspected.length < 6; offset += 3) {
    const batch = await Promise.all(ranked.slice(offset, offset + 3).map(inspectCandidate))
    inspected.push(...batch.filter((candidate): candidate is InspectedImage => Boolean(candidate)))
  }
  if (!inspected.length) return undefined
  const finalists = inspected.sort((left, right) => right.visualScore - left.visualScore).slice(0, 5)
  const selected = await visionChoice(finalists, pageTitle)
  return selected === null ? undefined : selected ?? finalists[0]
}

async function directPreview(url: URL): Promise<LinkPreview> {
  const result = await fetchHtml(url)
  const extracted = extractHtmlPreview(result.html, result.url)
  const cover = await bestReachableImage(extracted.candidates, extracted.title)
  return {
    url: result.url.href,
    domain: result.url.hostname.replace(/^www\./, ''),
    title: extracted.title,
    description: extracted.description,
    image: cover?.url,
    imageBuffer: cover?.buffer,
    imageMimeType: cover?.mediaType,
    imageSource: 'page',
    location: extracted.location,
  }
}

function markdownImageCandidates(content: string, base: URL) {
  const candidates: ImageCandidate[] = []
  const pattern = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/gi
  let match: RegExpExecArray | null
  let index = 0
  while ((match = pattern.exec(content)) && index < 160) {
    const context = `${match[1]} ${match[2]}`.toLowerCase()
    if (!/logo|icon|avatar|flag|payment|badge|rating|spinner/.test(context)) {
      let score = 500 - Math.min(index, 200)
      if (/product|hero|project|gallery|backpack|furniture|architecture|interior|exterior/.test(context)) score += 180
      addCandidate(candidates, match[2], base, score)
    }
    index += 1
  }
  return candidates
}

async function readerPreview(url: URL): Promise<LinkPreview | undefined> {
  await assertPublicUrl(url)
  try {
    const response = await fetch(`https://r.jina.ai/${url.href}`, {
      signal: AbortSignal.timeout(28_000),
      headers: {
        Accept: 'application/json',
        'X-Return-Format': 'markdown',
        'X-Timeout': '18',
        'X-With-Images-Summary': 'true',
      },
    })
    if (!response.ok) return undefined
    const raw = await readLimitedBody(response)
    const parsed = JSON.parse(raw) as { data?: { url?: string; title?: string; description?: string; content?: string } }
    const resolved = normaliseWebUrl(parsed.data?.url || url.href)
    const content = parsed.data?.content ?? ''
    const cover = await bestReachableImage(markdownImageCandidates(content, resolved), clean(parsed.data?.title))
    return {
      url: resolved.href,
      domain: resolved.hostname.replace(/^www\./, ''),
      title: clean(parsed.data?.title),
      description: clean(parsed.data?.description),
      image: cover?.url,
      imageBuffer: cover?.buffer,
      imageMimeType: cover?.mediaType,
      imageSource: 'reader',
    }
  } catch {
    return undefined
  }
}

function urlsFromAnthropicBlocks(blocks: Array<Record<string, unknown>>) {
  const urls = new Set<string>()
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) if (result && typeof result === 'object' && 'url' in result && typeof result.url === 'string') urls.add(result.url)
    }
    if (block.type === 'text') {
      if (Array.isArray(block.citations)) for (const citation of block.citations) if (citation && typeof citation === 'object' && 'url' in citation && typeof citation.url === 'string') urls.add(citation.url)
      if (typeof block.text === 'string') for (const match of block.text.matchAll(/https?:\/\/[^\s<>)\]"']+/g)) urls.add(match[0])
    }
  }
  return [...urls]
}

async function searchCandidatePages(original: URL, title: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || !title) return []
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(45_000),
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
        max_tokens: 500,
        system: 'Find exact authoritative webpages for a saved-link preview. Prefer the original domain and exact product, project, article, or brand. Return only a short list of candidate webpage URLs; never invent URLs.',
        messages: [{ role: 'user', content: `Find the exact page or closest authoritative page for “${title.slice(0, 180)}”. Original URL: ${original.href}. Prefer ${original.hostname}.` }],
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2, allowed_callers: ['direct'] }],
      }),
    })
    if (!response.ok) return []
    const result = await response.json() as { content?: Array<Record<string, unknown>> }
    const comparableOriginal = original.href.replace(/\/$/, '').toLowerCase()
    return urlsFromAnthropicBlocks(result.content ?? []).flatMap((value) => {
      try {
        const url = normaliseWebUrl(value)
        return url.href.replace(/\/$/, '').toLowerCase() === comparableOriginal ? [] : [url]
      } catch { return [] }
    }).sort((left, right) => Number(right.hostname === original.hostname) - Number(left.hostname === original.hostname)).slice(0, 2)
  } catch {
    return []
  }
}

function mergePreview(base: LinkPreview, next?: LinkPreview) {
  if (!next) return base
  return {
    url: next.url || base.url,
    domain: next.domain || base.domain,
    title: base.title || next.title,
    description: base.description || next.description,
    image: base.image || next.image,
    imageBuffer: base.image ? base.imageBuffer : next.imageBuffer,
    imageMimeType: base.image ? base.imageMimeType : next.imageMimeType,
    imageSource: base.image ? base.imageSource : next.imageSource,
    location: base.location ?? next.location,
  }
}

export async function fetchLinkPreview(value: string, options: LinkPreviewOptions = {}): Promise<LinkPreview> {
  const initial = normaliseWebUrl(value)
  await assertPublicUrl(initial)
  let preview: LinkPreview = { url: initial.href, domain: initial.hostname.replace(/^www\./, ''), title: clean(options.titleHint) }
  try { preview = mergePreview(preview, await directPreview(initial)) } catch { /* Reader handles blocked and script-rendered pages. */ }
  if (!preview.image && options.useReader !== false) preview = mergePreview(preview, await readerPreview(initial))
  if (!preview.image && options.useWebSearch) {
    const title = preview.title || clean(options.titleHint) || preview.domain
    for (const candidate of await searchCandidatePages(initial, title)) {
      let candidatePreview: LinkPreview | undefined
      try { candidatePreview = await directPreview(candidate) } catch { /* Reader handles blocked candidate pages. */ }
      if (!candidatePreview?.image) {
        const readerResult = await readerPreview(candidate)
        candidatePreview = candidatePreview
          ? mergePreview(candidatePreview, readerResult)
          : readerResult
      }
      if (candidatePreview?.image) {
        preview.image = candidatePreview.image
        preview.imageBuffer = candidatePreview.imageBuffer
        preview.imageMimeType = candidatePreview.imageMimeType
        preview.imageSource = 'web-search'
        break
      }
    }
  }
  return preview
}
