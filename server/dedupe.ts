import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { normaliseWebUrl } from './link-preview.js'

const trackingParameters = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_cid', 'mc_eid',
  'igshid', 'ref_src', 'ref_url', 'vero_conv', 'vero_id', '_hsenc', '_hsmi',
])

export function canonicalLink(value: string) {
  const url = normaliseWebUrl(value)
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || trackingParameters.has(key.toLowerCase())) url.searchParams.delete(key)
  }
  const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
  url.search = ''
  for (const [key, valuePart] of sorted) url.searchParams.append(key, valuePart)
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.href
}

function fingerprint(kind: 'link' | 'file', value: string | Buffer) {
  return createHash('sha256').update(`${kind}\0`).update(value).digest('hex')
}

export function linkFingerprint(value: string) {
  return fingerprint('link', canonicalLink(value))
}

export function fileFingerprint(buffer: Buffer) {
  return fingerprint('file', buffer)
}

/**
 * A 256-bit difference hash. It is deliberately conservative: callers should
 * only accept a very small Hamming distance, catching the same photo after
 * ordinary metadata stripping/recompression without merging merely similar art.
 */
export async function imageVisualFingerprint(buffer: Buffer) {
  const { data } = await sharp(buffer, { animated: false, limitInputPixels: 80_000_000 })
    .rotate()
    .resize(17, 16, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const bytes = Buffer.alloc(32)
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const bit = row * 16 + column
      if (data[row * 17 + column] > data[row * 17 + column + 1]) bytes[Math.floor(bit / 8)] |= 1 << (7 - (bit % 8))
    }
  }
  return bytes.toString('hex')
}

export function fingerprintDistance(left: string, right: string) {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return Number.POSITIVE_INFINITY
  let distance = 0
  for (let index = 0; index < left.length; index += 2) {
    let value = Number.parseInt(left.slice(index, index + 2), 16) ^ Number.parseInt(right.slice(index, index + 2), 16)
    while (value) { value &= value - 1; distance += 1 }
  }
  return distance
}
