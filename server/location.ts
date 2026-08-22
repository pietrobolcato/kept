import exifr from 'exifr'
import type { MemoryLocation } from '../src/types.js'

function validOriginalDate(value: unknown) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return undefined
  const year = value.getUTCFullYear()
  if (year < 1900 || value.getTime() > Date.now() + 86_400_000) return undefined
  return value.toISOString()
}

export async function imageExifDate(buffer: Buffer): Promise<string | undefined> {
  try {
    const metadata = await exifr.parse(buffer, ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'ModifyDate']) as Record<string, unknown> | undefined
    return validOriginalDate(metadata?.DateTimeOriginal)
      ?? validOriginalDate(metadata?.CreateDate)
      ?? validOriginalDate(metadata?.DateTimeDigitized)
      ?? validOriginalDate(metadata?.ModifyDate)
  } catch {
    return undefined
  }
}

function finiteCoordinate(value: unknown, limit: number) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined
}

export async function imageExifLocation(buffer: Buffer): Promise<MemoryLocation | undefined> {
  try {
    const gps = await exifr.gps(buffer)
    const latitude = finiteCoordinate(gps?.latitude, 90)
    const longitude = finiteCoordinate(gps?.longitude, 180)
    if (latitude === undefined || longitude === undefined) return undefined
    return { latitude, longitude, source: 'exif' }
  } catch {
    return undefined
  }
}

export function locationWithName(location: MemoryLocation | undefined, name?: string): MemoryLocation | undefined {
  const cleanName = name?.replace(/\s+/g, ' ').trim().slice(0, 240)
  if (location) return !location.name && cleanName ? { ...location, name: cleanName } : location
  return cleanName ? { name: cleanName, source: 'inferred' } : undefined
}
