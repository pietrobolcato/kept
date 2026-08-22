#!/usr/bin/env node

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = fileURLToPath(new URL('..', import.meta.url))
const itemsPath = join(root, 'data', 'items.json')

function parseArgs(args) {
  const options = { passwordEnv: 'KEPT_PASSWORD', dryRun: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const take = () => {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`)
      index += 1
      return value
    }
    if (argument === '--email') options.email = take()
    else if (argument === '--password-env') options.passwordEnv = take()
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

function usage() {
  console.log(`
Move the old local Kept library into one Supabase account.

  KEPT_PASSWORD='your password' npm run migrate:local -- --email you@example.com --dry-run
  KEPT_PASSWORD='your password' npm run migrate:local -- --email you@example.com

The password is read from KEPT_PASSWORD and is never stored. Use
--password-env NAME to read it from a different environment variable.
`)
}

function rowFromItem(item, storagePath) {
  return {
    title: item.title,
    description: item.description,
    kind: item.kind,
    image_url: storagePath ? null : item.image ?? null,
    storage_path: storagePath ?? null,
    source_url: item.url ?? null,
    domain: item.domain ?? null,
    space: item.space,
    tags: item.tags ?? [],
    palette: item.palette ?? [],
    created_at: item.createdAt,
    favourite: Boolean(item.favourite),
    source: item.source,
    ai_confidence: item.aiConfidence ?? 0,
    search_terms: item.searchTerms ?? [],
  }
}

function contentType(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.webp') return 'image/webp'
  return 'image/jpeg'
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return usage()
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  const email = options.email ?? process.env.KEPT_EMAIL
  const password = process.env[options.passwordEnv]
  if (!url || !key) throw new Error('Supabase is not configured in .env.')
  if (!email || !password) throw new Error(`Set KEPT_EMAIL and ${options.passwordEnv}, or pass --email and set ${options.passwordEnv}.`)

  const localItems = JSON.parse(await readFile(itemsPath, 'utf8'))
  if (!Array.isArray(localItems)) throw new Error('data/items.json is not a valid item list.')
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: auth, error: authError } = await client.auth.signInWithPassword({ email, password })
  if (authError || !auth.user) throw new Error(authError?.message ?? 'Could not sign in.')
  const { data: existing, error: listError } = await client.from('memory_items').select('title,source_url,created_at')
  if (listError) throw new Error(listError.message)
  const duplicateKeys = new Set((existing ?? []).map((item) => item.source_url ? `url:${item.source_url}` : `item:${item.title}:${item.created_at}`))
  let imported = 0
  let skipped = 0

  console.log(`Kept · moving ${localItems.length} local items to ${auth.user.email}`)
  for (const item of localItems) {
    const duplicateKey = item.url ? `url:${item.url}` : `item:${item.title}:${item.createdAt}`
    if (duplicateKeys.has(duplicateKey)) {
      skipped += 1
      console.log(`  already there · ${item.title}`)
      continue
    }
    if (options.dryRun) {
      imported += 1
      console.log(`  would move · ${item.title}`)
      continue
    }

    let storagePath
    if (typeof item.image === 'string' && item.image.startsWith('/uploads/')) {
      const localPath = join(root, item.image.replace(/^\//, ''))
      const bytes = await readFile(localPath)
      storagePath = `${auth.user.id}/${randomUUID()}${extname(localPath).toLowerCase() || '.jpg'}`
      const { error } = await client.storage.from('kept-images').upload(storagePath, bytes, { contentType: contentType(localPath), upsert: false })
      if (error) throw new Error(`Could not upload ${item.title}: ${error.message}`)
    }
    const { error } = await client.from('memory_items').insert(rowFromItem(item, storagePath))
    if (error) {
      if (storagePath) await client.storage.from('kept-images').remove([storagePath])
      throw new Error(`Could not move ${item.title}: ${error.message}`)
    }
    duplicateKeys.add(duplicateKey)
    imported += 1
    console.log(`  moved · ${item.title}`)
  }
  console.log(`\n${options.dryRun ? 'Dry run' : 'Migration'} complete · ${imported} ${options.dryRun ? 'would move' : 'moved'} · ${skipped} skipped`)
}

main().catch((error) => {
  console.error(`Migration stopped: ${error instanceof Error ? error.message : 'Unknown error'}`)
  process.exitCode = 1
})
