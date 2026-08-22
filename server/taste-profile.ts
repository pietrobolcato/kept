import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemoryItem } from '../src/types.js'
import { preferenceSignals, type TasteProfile } from './assistant.js'

export type TasteProfileState = {
  profile: TasteProfile
  sourceItemCount: number
  status: 'recalled' | 'refreshed'
}

function libraryFingerprint(items: MemoryItem[]) {
  const stable = items
    .map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      space: item.space,
      tags: item.tags,
      palette: item.palette,
      favourite: item.favourite,
      domain: item.domain,
      searchTerms: item.searchTerms,
      capturedAt: item.capturedAt,
      recent: Date.now() - new Date(item.createdAt).getTime() < 45 * 86_400_000,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

export async function recallTasteProfile(client: SupabaseClient, userId: string, visibleItems: MemoryItem[]): Promise<TasteProfileState> {
  // Shared libraries are useful context for a question, but should not silently
  // rewrite the member's personal taste model.
  const personalItems = visibleItems.filter((item) => !item.ownerId || item.ownerId === userId)
  const sourceFingerprint = libraryFingerprint(personalItems)
  const { data, error } = await client.from('user_taste_profiles')
    .select('profile,source_fingerprint,source_item_count')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`Could not recall your taste profile: ${error.message}`)
  if (data?.source_fingerprint === sourceFingerprint && data.profile && typeof data.profile === 'object') {
    return { profile: data.profile as TasteProfile, sourceItemCount: data.source_item_count ?? personalItems.length, status: 'recalled' }
  }

  const profile = preferenceSignals(personalItems)
  const { error: saveError } = await client.from('user_taste_profiles').upsert({
    user_id: userId,
    profile,
    source_fingerprint: sourceFingerprint,
    source_item_count: personalItems.length,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })
  if (saveError) throw new Error(`Could not save your taste profile: ${saveError.message}`)
  return { profile, sourceItemCount: personalItems.length, status: 'refreshed' }
}
