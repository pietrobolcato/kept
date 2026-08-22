#!/usr/bin/env node

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { archiveLinkPreview } from '../server/capture.js'
import { fileFingerprint, imageVisualFingerprint, linkFingerprint } from '../server/dedupe.js'
import { fetchValidatedImage } from '../server/link-preview.js'

type Row = {
  id: string
  user_id: string
  title: string
  kind: 'image' | 'link' | 'note'
  source_url: string | null
  image_url: string | null
  storage_path: string | null
  content_fingerprint: string | null
  visual_fingerprint: string | null
}

async function main() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running the backfill.')
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.from('memory_items')
    .select('id,user_id,title,kind,source_url,image_url,storage_path,content_fingerprint,visual_fingerprint')
    .order('created_at', { ascending: true })
  if (error) throw error
  const rows = (data ?? []) as Row[]
  let fingerprinted = 0
  let archived = 0
  let duplicates = 0
  let unavailable = 0

  console.log(`Kept · preparing ${rows.length} existing items for durable, duplicate-safe capture`)
  for (const [index, row] of rows.entries()) {
    const patch: Record<string, string | null> = {}
    let newStoragePath: string | undefined
    try {
      if (row.kind === 'link' && row.source_url && !row.content_fingerprint) {
        patch.content_fingerprint = linkFingerprint(row.source_url)
      }
      if (row.kind === 'image' && row.storage_path && (!row.content_fingerprint || !row.visual_fingerprint)) {
        const { data: blob, error: downloadError } = await client.storage.from('kept-images').download(row.storage_path)
        if (downloadError) throw downloadError
        const buffer = Buffer.from(await blob.arrayBuffer())
        if (!row.content_fingerprint) patch.content_fingerprint = fileFingerprint(buffer)
        if (!row.visual_fingerprint) patch.visual_fingerprint = await imageVisualFingerprint(buffer)
      }
      if (row.kind === 'link' && row.image_url && !row.storage_path) {
        const imageBuffer = await fetchValidatedImage(row.image_url)
        if (imageBuffer) {
          newStoragePath = await archiveLinkPreview(client, row.user_id, { imageBuffer })
          if (newStoragePath) { patch.storage_path = newStoragePath; patch.image_url = null }
        } else unavailable += 1
      }
      if (Object.keys(patch).length) {
        const { error: updateError } = await client.from('memory_items').update(patch).eq('id', row.id)
        if (updateError?.code === '23505') {
          duplicates += 1
          if (newStoragePath) await client.storage.from('kept-images').remove([newStoragePath])
        } else if (updateError) {
          if (newStoragePath) await client.storage.from('kept-images').remove([newStoragePath])
          throw updateError
        } else {
          if (patch.content_fingerprint || patch.visual_fingerprint) fingerprinted += 1
          if (newStoragePath) archived += 1
        }
      }
      console.log(`  [${index + 1}/${rows.length}] ${row.title.slice(0, 68)}${newStoragePath ? ' · preview archived' : ''}`)
    } catch (itemError) {
      unavailable += 1
      console.warn(`  [${index + 1}/${rows.length}] skipped · ${row.title.slice(0, 55)} · ${itemError instanceof Error ? itemError.message : 'Unknown error'}`)
    }
  }
  console.log(`\nBackfill complete · ${fingerprinted} fingerprinted · ${archived} previews archived · ${duplicates} historical duplicates retained · ${unavailable} unavailable`)
}

main().catch((error) => {
  console.error(`Backfill stopped: ${error instanceof Error ? error.message : 'Unknown error'}`)
  process.exitCode = 1
})
