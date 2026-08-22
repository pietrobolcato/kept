#!/usr/bin/env node

import 'dotenv/config'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'

const execFile = promisify(execFileCallback)
const root = fileURLToPath(new URL('..', import.meta.url))
const manifestPath = join(root, 'data', 'import-manifest.json')
const dryRun = process.argv.includes('--dry-run')

const readAlbumDatesScript = String.raw`
function safe(callable, fallback = '') { try { return callable(); } catch (_) { return fallback; } }
function run(argv) {
  const app = Application('Photos');
  const wanted = argv[0];
  const album = app.albums().find(candidate => safe(() => candidate.id()) === wanted);
  if (!album) throw new Error('Album not found: ' + wanted);
  return JSON.stringify(safe(() => album.mediaItems(), []).map(item => ({
    id: safe(() => item.id()),
    date: safe(() => item.date().toISOString()),
  })));
}`

async function readAlbumDates(albumId) {
  const { stdout } = await execFile('osascript', ['-l', 'JavaScript', '-e', readAlbumDatesScript, albumId], { maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout.trim())
}

function validDate(value) {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() >= 1900 && parsed.getTime() <= Date.now() + 86_400_000 ? parsed.toISOString() : undefined
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Apple Photos date backfill must run on the Mac that owns the Photos library.')
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running the backfill.')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const imported = Object.entries(manifest.completed ?? {}).flatMap(([sourceKey, entry]) => {
    const separator = sourceKey.lastIndexOf(':asset:')
    if (!sourceKey.startsWith('photos:') || separator < 0 || !entry?.itemId) return []
    return [{ albumId: sourceKey.slice('photos:'.length, separator), assetId: sourceKey.slice(separator + ':asset:'.length), itemId: entry.itemId, filename: entry.filename }]
  })
  const albumIds = [...new Set(imported.map(({ albumId }) => albumId))]
  console.log(`Kept · restoring original dates for ${imported.length} imported Apple Photos item${imported.length === 1 ? '' : 's'}${dryRun ? ' · dry run' : ''}`)
  const dateByAsset = new Map()
  for (const albumId of albumIds) {
    const assets = await readAlbumDates(albumId)
    for (const asset of assets) if (asset.id && validDate(asset.date)) dateByAsset.set(asset.id, validDate(asset.date))
  }
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const candidates = imported.flatMap((entry) => dateByAsset.has(entry.assetId) ? [{ ...entry, capturedAt: dateByAsset.get(entry.assetId) }] : [])
  if (!dryRun) {
    for (let offset = 0; offset < candidates.length; offset += 20) {
      await Promise.all(candidates.slice(offset, offset + 20).map(async ({ itemId, capturedAt }) => {
        const { error } = await client.from('memory_items').update({ captured_at: capturedAt, captured_at_source: 'apple_photos' }).eq('id', itemId).is('captured_at', null)
        if (error) throw error
      }))
    }
  }
  console.log(`${dryRun ? 'Would restore' : 'Restored'} ${candidates.length} original date${candidates.length === 1 ? '' : 's'} · ${imported.length - candidates.length} unavailable or no longer in Photos`)
}

main().catch((error) => {
  console.error(`Date backfill stopped: ${error instanceof Error ? error.message : 'Unknown error'}`)
  process.exitCode = 1
})
