export type ItemKind = 'image' | 'video' | 'link' | 'note'
export type MemoryDateSource = 'exif' | 'apple_photos' | 'manual'

export interface MemoryLocation {
  name?: string
  latitude?: number
  longitude?: number
  source: 'exif' | 'page' | 'inferred' | 'manual'
}

export interface MemoryItem {
  id: string
  /** Supabase owner; differs from the signed-in user for items in a shared space. */
  ownerId?: string
  title: string
  description: string
  kind: ItemKind
  image?: string
  /** Signed private playback URL for video memories. `image` is its poster. */
  video?: string
  videoMimeType?: string
  url?: string
  domain?: string
  space: string
  tags: string[]
  palette: string[]
  createdAt: string
  /** When the photo was originally taken. `createdAt` remains when it was kept. */
  capturedAt?: string
  capturedAtSource?: MemoryDateSource
  favourite: boolean
  source: 'Browser' | 'Upload' | 'Quick note'
  aiConfidence: number
  searchTerms: string[]
  location?: MemoryLocation
  /** Present only on a capture response when Kept returned the existing item. */
  duplicate?: boolean
}

export interface CapturePayload {
  type: 'link' | 'note'
  value: string
}
