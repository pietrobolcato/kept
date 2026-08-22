#!/usr/bin/env node

import 'dotenv/config'
import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { load as loadHtml } from 'cheerio'
import { marked } from 'marked'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'

const execFile = promisify(execFileCallback)
const root = fileURLToPath(new URL('..', import.meta.url))
const dataPath = join(root, 'data')
const manifestPath = join(dataPath, 'import-manifest.json')
const photosSourcePath = join(root, 'scripts', 'apple-photos.swift')
const photosInfoPath = join(root, 'scripts', 'KeptPhotosImporter-Info.plist')
const photosEntitlementsPath = join(root, 'scripts', 'KeptPhotosImporter.entitlements')
const photosAppPath = join(root, '.cache', 'apple-importer', 'Kept Photos Importer.app')
const photosExecutablePath = join(photosAppPath, 'Contents', 'MacOS', 'KeptPhotosImporter')
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'])
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm'])

const listNotesScript = String.raw`
function safe(callable, fallback = '') { try { return callable(); } catch (_) { return fallback; } }
function run() {
  const app = Application('Notes');
  return JSON.stringify(app.notes().map(note => ({
    id: safe(() => note.id()),
    name: safe(() => note.name(), 'Untitled note'),
    folder: safe(() => note.container().name(), 'Notes'),
    protected: Boolean(safe(() => note.passwordProtected(), false)),
  })));
}`

const readNoteScript = String.raw`
function safe(callable, fallback = '') { try { return callable(); } catch (_) { return fallback; } }
function run(argv) {
  const app = Application('Notes');
  const wanted = argv[0];
  const note = app.notes().find(candidate => safe(() => candidate.id()) === wanted);
  if (!note) throw new Error('Note not found');
  const attachments = safe(() => note.attachments(), []).map(attachment => ({
    name: safe(() => attachment.name(), 'Attachment'),
    url: safe(() => attachment.url(), safe(() => attachment.URL(), '')),
  }));
  return JSON.stringify({
    id: safe(() => note.id()),
    name: safe(() => note.name(), 'Untitled note'),
    html: safe(() => note.body()),
    plaintext: safe(() => note.plaintext()),
    attachments,
  });
}`

const listAlbumsScript = String.raw`
function safe(callable, fallback = '') { try { return callable(); } catch (_) { return fallback; } }
function run() {
  const app = Application('Photos');
  return JSON.stringify(app.albums().map(album => ({
    id: safe(() => album.id()),
    name: safe(() => album.name(), 'Untitled album'),
    count: safe(() => album.mediaItems().length, 0),
  })));
}`

const readAlbumScript = String.raw`
function safe(callable, fallback = '') { try { return callable(); } catch (_) { return fallback; } }
function run(argv) {
  const app = Application('Photos');
  const wanted = argv[0];
  const album = app.albums().find(candidate => safe(() => candidate.id()) === wanted);
  if (!album) throw new Error('Album not found');
  return JSON.stringify({
    id: safe(() => album.id()),
    name: safe(() => album.name(), 'Untitled album'),
    items: safe(() => album.mediaItems(), []).map(item => ({
      id: safe(() => item.id()),
      filename: safe(() => item.filename()),
      name: safe(() => item.name()),
      description: safe(() => item.description()),
      date: safe(() => item.date().toISOString()),
    })),
  });
}`

const exportPhotoScript = String.raw`
on run argv
  set mediaId to item 1 of argv
  set destinationPath to item 2 of argv
  tell application "Photos"
    set matchingItems to every media item whose id is mediaId
    if (count of matchingItems) is 0 then error "Photo not found"
    with timeout of 120 seconds
      export matchingItems to (POSIX file destinationPath) without using originals
    end timeout
  end tell
end run`

function usage() {
  console.log(`
Kept one-time importer

Usage:
  npm run import:apple
  npm run import:apple -- --note "Note name" --album "Album name"
  npm run import:apple -- --markdown path/to/saved-links.md
  npm run import:apple -- --list
  npm run import:apple -- --note "Note name" --dry-run

Options:
  --note <name-or-id>      Import links (or text) from one Apple Note
  --markdown <path>        Import links (or text) from any Markdown file
  --album <name-or-id>     Import every supported photo and video from one Photos album
  --include-note-text      Also save useful non-link text from a link-filled note
  --api <url>              Kept API base URL (default http://127.0.0.1:8787)
  --email <address>        Kept account receiving the import (or KEPT_EMAIL)
  --password-env <name>    Environment variable holding its password (default KEPT_PASSWORD)
  --concurrency <1-4>      Parallel photo uploads (default 2)
  --max-image-edge <px>    Longest saved image edge (default 1920)
  --image-quality <1-100>  WebP quality for saved images (default 76)
  --dry-run                Inspect and report without saving anything
  --keep-export            Keep the temporary rendered Photos export
  --list                   List available notes and albums, then exit
  --help                   Show this help

If no source is supplied, an interactive Apple picker is shown. macOS may ask
Terminal to access Notes, Photos, or automation the first time.
`)
}

function parseArgs(argv) {
  const options = {
    api: 'http://127.0.0.1:8787',
    passwordEnv: 'KEPT_PASSWORD',
    concurrency: 2,
    maxImageEdge: 1920,
    imageQuality: 76,
    dryRun: false,
    includeNoteText: false,
    keepExport: false,
    list: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const take = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`)
      index += 1
      return value
    }
    if (argument === '--note') options.note = take()
    else if (argument === '--markdown') options.markdown = take()
    else if (argument === '--album') options.album = take()
    else if (argument === '--api') options.api = take()
    else if (argument === '--email') options.email = take()
    else if (argument === '--password-env') options.passwordEnv = take()
    else if (argument === '--concurrency') options.concurrency = Number(take())
    else if (argument === '--max-image-edge') options.maxImageEdge = Number(take())
    else if (argument === '--image-quality') options.imageQuality = Number(take())
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--include-note-text') options.includeNoteText = true
    else if (argument === '--keep-export') options.keepExport = true
    else if (argument === '--list') options.list = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) throw new Error('--concurrency must be between 1 and 4.')
  if (!Number.isInteger(options.maxImageEdge) || options.maxImageEdge < 640 || options.maxImageEdge > 4096) throw new Error('--max-image-edge must be between 640 and 4096.')
  if (!Number.isInteger(options.imageQuality) || options.imageQuality < 40 || options.imageQuality > 95) throw new Error('--image-quality must be between 40 and 95.')
  const api = new URL(options.api)
  if (!['http:', 'https:'].includes(api.protocol)) throw new Error('--api must be an HTTP(S) URL.')
  options.api = api.href.endsWith('/') ? api.href : `${api.href}/`
  return options
}

async function runJxa(source, args = []) {
  const { stdout } = await execFile('osascript', ['-l', 'JavaScript', '-e', source, ...args], { maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(stdout.trim() || 'null')
}

async function runAppleScript(source, args = []) {
  await execFile('osascript', ['-l', 'AppleScript', '-e', source, ...args], { maxBuffer: 32 * 1024 * 1024 })
}

async function ensurePhotosHelper() {
  let needsBuild = false
  try {
    const bundledInfoPath = join(photosAppPath, 'Contents', 'Info.plist')
    const [source, info, entitlements, executable, bundledInfo] = await Promise.all([
      stat(photosSourcePath),
      stat(photosInfoPath),
      stat(photosEntitlementsPath),
      stat(photosExecutablePath),
      stat(bundledInfoPath),
    ])
    needsBuild = Math.max(source.mtimeMs, info.mtimeMs, entitlements.mtimeMs) > Math.min(executable.mtimeMs, bundledInfo.mtimeMs)
  } catch {
    needsBuild = true
  }
  if (!needsBuild) return
  const contentsPath = join(photosAppPath, 'Contents')
  await mkdir(join(contentsPath, 'MacOS'), { recursive: true })
  await copyFile(photosInfoPath, join(contentsPath, 'Info.plist'))
  await execFile('swiftc', [photosSourcePath, '-o', photosExecutablePath, '-framework', 'Photos', '-framework', 'AppKit'], { maxBuffer: 32 * 1024 * 1024 })
  await execFile('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', photosEntitlementsPath, photosAppPath], { maxBuffer: 32 * 1024 * 1024 })
}

async function runPhotoKit(args) {
  await ensurePhotosHelper()
  const statusResult = await execFile(photosExecutablePath, ['status'], { maxBuffer: 32 * 1024 * 1024 })
  let status = JSON.parse(statusResult.stdout.trim() || '{}').status
  if (status === 'notDetermined') {
    // Launch through Launch Services for the first request. On newer macOS
    // versions, executing a bundled binary directly may not create a visible
    // Photos privacy entry even though the binary lives inside an app bundle.
    await execFile('open', ['-W', '-n', photosAppPath, '--args', 'authorize'], { maxBuffer: 32 * 1024 * 1024 })
    const refreshed = await execFile(photosExecutablePath, ['status'], { maxBuffer: 32 * 1024 * 1024 })
    status = JSON.parse(refreshed.stdout.trim() || '{}').status
  }
  if (status !== 'authorized' && status !== 'limited') {
    throw new Error('Photos access was not granted. Allow Kept Photos Importer in System Settings → Privacy & Security → Photos.')
  }
  const { stdout } = await execFile(photosExecutablePath, args, { maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(stdout.trim() || 'null')
}

function displayNotes(notes) {
  console.log('\nApple Notes')
  if (!notes.length) console.log('  No notes found.')
  notes.forEach((note, index) => console.log(`  ${String(index + 1).padStart(3)}. ${note.name}  ·  ${note.folder}${note.protected ? '  ·  locked' : ''}`))
}

function displayAlbums(albums) {
  console.log('\nPhotos albums')
  if (!albums.length) console.log('  No albums found.')
  albums.forEach((album, index) => console.log(`  ${String(index + 1).padStart(3)}. ${album.name}  ·  ${album.count} item${album.count === 1 ? '' : 's'}`))
}

function resolveSelection(items, requested, type) {
  if (!requested) return undefined
  const normalized = requested.trim().toLowerCase()
  const matches = items.filter((item) => item.id === requested || item.name.trim().toLowerCase() === normalized)
  if (!matches.length) throw new Error(`No ${type} matched “${requested}”. Run with --list to see available names.`)
  if (matches.length > 1) throw new Error(`More than one ${type} is named “${requested}”. Run without arguments and choose it interactively.`)
  return matches[0]
}

async function choose(items, label, rl) {
  if (!items.length) return undefined
  const answer = (await rl.question(`Choose a ${label} by number, or 0 to skip: `)).trim()
  const index = Number(answer)
  if (!Number.isInteger(index) || index < 0 || index > items.length) throw new Error(`Choose a number from 0 to ${items.length}.`)
  return index === 0 ? undefined : items[index - 1]
}

async function loadManifest() {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    return parsed?.version === 1 && parsed.completed ? parsed : { version: 1, completed: {} }
  } catch {
    return { version: 1, completed: {} }
  }
}

let manifestWrite = Promise.resolve()
function saveManifest(manifest) {
  manifestWrite = manifestWrite.then(async () => {
    await mkdir(dataPath, { recursive: true })
    const temporary = `${manifestPath}.tmp`
    await writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8')
    await rename(temporary, manifestPath)
  })
  return manifestWrite
}

function apiUrl(options, pathname) {
  return new URL(pathname.replace(/^\//, ''), options.api)
}

function authHeaders(options, headers = {}) {
  if (!options.accessToken) throw new Error('Sign in before importing.')
  return { ...headers, Authorization: `Bearer ${options.accessToken}` }
}

async function authenticateImporter(options) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  const email = options.email ?? process.env.KEPT_EMAIL
  const password = process.env[options.passwordEnv]
  if (!url || !key) throw new Error('Supabase is not configured in .env.')
  if (!email || !password) throw new Error(`Set KEPT_EMAIL and ${options.passwordEnv}, or pass --email and set ${options.passwordEnv}, before importing.`)
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(error?.message ?? 'Could not sign in to Kept.')
  options.accessToken = data.session.access_token
  options.supabase = client
  options.userId = data.user.id
  console.log(`Signed in as ${data.user.email}.`)
}

async function readApiError(response) {
  try {
    const body = await response.json()
    return body.error || body.message || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

async function apiIsReady(options) {
  try {
    const response = await fetch(apiUrl(options, '/api/health'), { signal: AbortSignal.timeout(1_500) })
    return response.ok
  } catch {
    return false
  }
}

async function ensureApi(options) {
  if (options.dryRun || await apiIsReady(options)) return undefined
  const target = new URL(options.api)
  if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error(`Kept is not reachable at ${options.api}`)
  const tsxPath = join(root, 'node_modules', '.bin', 'tsx')
  try { await access(tsxPath) } catch { throw new Error('Run npm install before using the importer.') }
  console.log(`\nStarting the Kept API on port ${target.port || '80'}…`)
  const child = spawn(tsxPath, ['server/index.ts'], {
    cwd: root,
    env: { ...process.env, PORT: target.port || '80' },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error('The Kept API stopped before the import began.')
    if (await apiIsReady(options)) return child
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  child.kill('SIGTERM')
  throw new Error('Timed out while starting the Kept API.')
}

const disposableQueryParameters = new Set([
  '_hsenc',
  '_hsmi',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'rsltid',
  'srsltid',
])

function decodeHtmlEntities(value) {
  let decoded = String(value)
  // Notes can hand the same URL to us through multiple HTML representations.
  // In practice this means an ampersand may be encoded more than once.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = loadHtml(`<textarea>${decoded}</textarea>`).text()
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

function trimLinkPunctuation(value) {
  let trimmed = value.trim().replace(/^[<\u201c\u201d"']+/, '').replace(/[>\u201c\u201d"',.;!?]+$/, '')
  while (trimmed.endsWith(')')) {
    const opens = (trimmed.match(/\(/g) || []).length
    const closes = (trimmed.match(/\)/g) || []).length
    if (closes <= opens) break
    trimmed = trimmed.slice(0, -1)
  }
  return trimmed
}

function normalizeLink(value) {
  try {
    const decoded = trimLinkPunctuation(decodeHtmlEntities(value).replace(/[\u200B-\u200D\uFEFF]/g, ''))
    const url = new URL(decoded)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    url.hash = ''
    for (const parameter of [...url.searchParams.keys()]) {
      if (parameter.toLowerCase().startsWith('utm_') || disposableQueryParameters.has(parameter.toLowerCase())) {
        url.searchParams.delete(parameter)
      }
    }
    return url.href
  } catch {
    return undefined
  }
}

function extractLinks(note) {
  const candidates = []
  const add = (value, label = '') => {
    const url = normalizeLink(typeof value === 'string' ? value : '')
    if (!url) return
    candidates.push({ url, label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 180) })
  }
  const $ = loadHtml(note.html || '')
  $('a[href]').each((_index, element) => add($(element).attr('href'), $(element).text()))
  $('[data-href], [data-url], object[data]').each((_index, element) => {
    add($(element).attr('data-href') || $(element).attr('data-url') || $(element).attr('data'), $(element).text())
  })

  // A Markdown renderer has already turned every Markdown destination, autolink,
  // and bare URL into an anchor. Do not rescan its URL-looking link labels as
  // separate destinations (for example, [old URL](new URL)).
  const visibleHtml = loadHtml(note.html || '')
  if (note.markdown) visibleHtml('a').remove()
  const visibleText = [note.markdown ? '' : note.plaintext || '', visibleHtml.root().text()].join('\n')
  for (const match of visibleText.matchAll(/\[([^\]]+)]\(\s*(?:<([^>\r\n]+)>|(https?:\/\/[^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gi)) add(match[2] || match[3], match[1])
  for (const match of visibleText.matchAll(/https?:\/\/[^\s<>"']+/gi)) add(match[0])
  for (const attachment of note.attachments || []) add(attachment.url, attachment.name)

  const unique = new Map()
  for (const candidate of candidates) {
    const existing = unique.get(candidate.url)
    if (!existing || (!existing.label && candidate.label)) unique.set(candidate.url, candidate)
  }
  return [...unique.values()]
}

function markdownLinkSource(path, markdown) {
  return {
    id: createHash('sha256').update(path).digest('hex').slice(0, 24),
    name: basename(path),
    html: marked.parse(markdown),
    plaintext: markdown,
    attachments: [],
    markdown: true,
  }
}

async function capture(options, type, value, context = '') {
  const response = await fetch(apiUrl(options, '/api/capture'), {
    method: 'POST',
    headers: authHeaders(options, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ type, value, context }),
  })
  if (!response.ok) throw new Error(await readApiError(response))
  return response.json()
}

async function importLinkSource(options, note, manifest, source = {}) {
  const sourceType = source.type || 'notes'
  const heading = source.heading || 'Note'
  const contextName = source.contextName || 'Apple Notes'
  const links = extractLinks(note)
  const nonUrlAttachments = (note.attachments || []).filter((attachment) => !normalizeLink(attachment.url))
  console.log(`\n${heading}: ${note.name}`)
  console.log(`  Found ${links.length} unique web link${links.length === 1 ? '' : 's'}.`)
  if (sourceType === 'notes' && links.length && !/<a\b[^>]*\bhref\s*=/i.test(note.html || '')) {
    console.log('  Note: Apple Notes did not expose any hidden rich-link destinations. Links shown only as underlined labels must be changed to visible URLs in Notes before they can be imported.')
  }
  if (nonUrlAttachments.length) console.log(`  ${nonUrlAttachments.length} embedded Notes attachment${nonUrlAttachments.length === 1 ? '' : 's'} cannot be exported through Apple’s Notes scripting API and will be skipped.`)

  let imported = 0
  let skipped = 0
  let failed = 0
  let existingUrls = new Set()
  if (!options.dryRun) {
    const response = await fetch(apiUrl(options, '/api/items'), { headers: authHeaders(options) })
    if (response.ok) existingUrls = new Set((await response.json()).map((item) => normalizeLink(item.url)).filter(Boolean))
  }
  for (const [index, link] of links.entries()) {
    const sourceKey = `${sourceType}:${note.id}:link:${link.url}`
    if (manifest.completed[sourceKey] || existingUrls.has(link.url)) {
      skipped += 1
      console.log(`  [${index + 1}/${links.length}] already kept · ${new URL(link.url).hostname}`)
      continue
    }
    if (options.dryRun) {
      imported += 1
      console.log(`  [${index + 1}/${links.length}] would import · ${link.label ? `${link.label} · ` : ''}${link.url}`)
      continue
    }
    try {
      const context = link.label ? `${contextName} link label: ${link.label}` : ''
      const item = await capture(options, 'link', link.url, context)
      manifest.completed[sourceKey] = { itemId: item.id, importedAt: new Date().toISOString() }
      await saveManifest(manifest)
      existingUrls.add(link.url)
      if (item.duplicate) {
        skipped += 1
        console.log(`  [${index + 1}/${links.length}] already kept · ${item.title}`)
      } else {
        imported += 1
        console.log(`  [${index + 1}/${links.length}] kept · ${item.title}`)
      }
    } catch (error) {
      failed += 1
      console.warn(`  [${index + 1}/${links.length}] failed · ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const shouldSaveText = links.length === 0 || options.includeNoteText
  const plaintext = (note.plaintext || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim()
  if (shouldSaveText && plaintext.length > 20) {
    const value = `${note.name}\n\n${plaintext}`
    const sourceKey = `${sourceType}:${note.id}:text:${createHash('sha256').update(value).digest('hex')}`
    if (manifest.completed[sourceKey]) skipped += 1
    else if (options.dryRun) {
      imported += 1
      console.log('  Would also import the note text.')
    } else {
      try {
        const item = await capture(options, 'note', value)
        manifest.completed[sourceKey] = { itemId: item.id, importedAt: new Date().toISOString() }
        await saveManifest(manifest)
        imported += 1
        console.log(`  Kept note text · ${item.title}`)
      } catch (error) {
        failed += 1
        console.warn(`  Note text failed · ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }
  }
  return { imported, skipped, failed }
}

async function importNote(options, selected, manifest) {
  const note = await runJxa(readNoteScript, [selected.id])
  if (!note) throw new Error('Could not read the selected note.')
  return importLinkSource(options, note, manifest)
}

async function importMarkdown(options, source, manifest) {
  return importLinkSource(options, source, manifest, {
    type: 'markdown',
    heading: 'Markdown file',
    contextName: 'Markdown',
  })
}

async function walkFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function mimeType(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.avif') return 'image/avif'
  return 'image/jpeg'
}

function withoutExtension(value) {
  return basename(value, extname(value)).toLowerCase()
}

async function compressImage(path, options) {
  return sharp(path, { animated: false, limitInputPixels: 80_000_000 })
    .rotate()
    .resize({
      width: options.maxImageEdge,
      height: options.maxImageEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: options.imageQuality, effort: 4, smartSubsample: true })
    .toBuffer()
}

async function uploadImage(options, bytes, filename, hint, capturedAt) {
  const body = new FormData()
  body.append('image', new Blob([bytes], { type: 'image/webp' }), `${withoutExtension(filename)}.webp`)
  body.append('hint', hint)
  if (capturedAt) {
    body.append('capturedAt', capturedAt)
    body.append('capturedAtSource', 'apple_photos')
  }
  const response = await fetch(apiUrl(options, '/api/upload'), { method: 'POST', headers: authHeaders(options), body })
  if (!response.ok) throw new Error(await readApiError(response))
  return response.json()
}

async function prepareVideo(path) {
  const directory = join(path, '..')
  const stem = withoutExtension(path)
  const videoPath = join(directory, `${stem}-kept.mp4`)
  const posterPath = join(directory, `${stem}-poster.jpg`)
  const attempts = [
    { edge: 1920, crf: 24, audio: '128k' },
    { edge: 1440, crf: 28, audio: '96k' },
    { edge: 1080, crf: 31, audio: '80k' },
    { edge: 960, crf: 34, audio: '64k' },
  ]
  const maximumStoredBytes = 48 * 1024 * 1024
  for (const attempt of attempts) {
    await execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-map_metadata', '0', '-vf', `scale=min(${attempt.edge}\\,iw):-2`, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(attempt.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', attempt.audio, videoPath], { maxBuffer: 32 * 1024 * 1024 })
    if ((await stat(videoPath)).size <= maximumStoredBytes) break
  }
  if ((await stat(videoPath)).size > maximumStoredBytes) {
    throw new Error('Video remains larger than 48 MB after web optimisation.')
  }
  await execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=min(1280\\,iw):-2', '-q:v', '3', posterPath], { maxBuffer: 32 * 1024 * 1024 })
  return { videoPath, posterPath }
}

async function uploadVideo(options, path, filename, hint, capturedAt) {
  if (!options.supabase || !options.userId) throw new Error('Sign in before importing video.')
  const prepared = await prepareVideo(path)
  const [videoBytes, posterBytes] = await Promise.all([readFile(prepared.videoPath), readFile(prepared.posterPath)])
  const videoStoragePath = `${options.userId}/${randomUUID()}.mp4`
  const { error: uploadError } = await options.supabase.storage.from('kept-images').upload(videoStoragePath, videoBytes, { contentType: 'video/mp4', cacheControl: '31536000', upsert: false })
  if (uploadError) throw new Error(`Video storage failed: ${uploadError.message}`)
  const body = new FormData()
  body.append('poster', new Blob([posterBytes], { type: 'image/jpeg' }), `${withoutExtension(filename)}-poster.jpg`)
  body.append('videoStoragePath', videoStoragePath)
  body.append('videoMimeType', 'video/mp4')
  body.append('contentFingerprint', createHash('sha256').update(videoBytes).digest('hex'))
  body.append('filename', `${withoutExtension(filename)}.mp4`)
  body.append('hint', hint)
  if (capturedAt) { body.append('capturedAt', capturedAt); body.append('capturedAtSource', 'apple_photos') }
  const response = await fetch(apiUrl(options, '/api/upload-video'), { method: 'POST', headers: authHeaders(options), body })
  if (!response.ok) {
    await options.supabase.storage.from('kept-images').remove([videoStoragePath])
    throw new Error(await readApiError(response))
  }
  const item = await response.json()
  return { item, savedBytes: videoBytes.length }
}

async function mapConcurrent(values, concurrency, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      await worker(values[index], index)
    }
  })
  await Promise.all(runners)
}

async function importAlbum(options, selected, manifest, cleanup) {
  const album = await runJxa(readAlbumScript, [selected.id])
  if (!album) throw new Error('Could not read the selected Photos album.')
  const exportPath = await mkdtemp(join(tmpdir(), 'kept-photos-import-'))
  cleanup.exportPath = exportPath
  console.log(`\nPhotos album: ${album.name}`)
  console.log(`  Exporting ${album.items.length} item${album.items.length === 1 ? '' : 's'} as browser-compatible rendered files…`)
  console.log(`  Saved copies will be WebP, at most ${options.maxImageEdge}px on the longest edge, quality ${options.imageQuality}.`)
  let exportFailures = 0
  let manifestSkipped = 0
  const supported = []
  for (let index = 0; index < album.items.length; index += 1) {
    const item = album.items[index]
    const sourceKey = `photos:${album.id}:asset:${item.id}`
    if (manifest.completed[sourceKey]) {
      manifestSkipped += 1
      if ((index + 1) % 50 === 0 || index === album.items.length - 1) console.log(`  Checked ${index + 1}/${album.items.length}…`)
      continue
    }
    const itemPath = join(exportPath, String(index + 1).padStart(4, '0'))
    await mkdir(itemPath)
    try {
      await runAppleScript(exportPhotoScript, [item.id, itemPath])
      const exported = await walkFiles(itemPath)
      const media = exported.filter((path) => imageExtensions.has(extname(path).toLowerCase()) || videoExtensions.has(extname(path).toLowerCase()))
      for (const path of media) supported.push({ path, item, kind: videoExtensions.has(extname(path).toLowerCase()) ? 'video' : 'image' })
      if (!media.length) exportFailures += 1
    } catch (error) {
      exportFailures += 1
      console.warn(`  [${index + 1}/${album.items.length}] could not export · ${item.filename || item.name || 'photo'} · ${error instanceof Error && /timed out/i.test(error.message) ? 'Photos timed out fetching this item' : 'unsupported or unavailable'}`)
    }
    if ((index + 1) % 10 === 0 || index === album.items.length - 1) console.log(`  Rendered ${index + 1}/${album.items.length}…`)
  }
  const unsupported = exportFailures
  const videoCount = supported.filter(({ kind }) => kind === 'video').length
  console.log(`  ${manifestSkipped} already kept · ${supported.length} new supported item${supported.length === 1 ? '' : 's'} · ${supported.length - videoCount} photo${supported.length - videoCount === 1 ? '' : 's'} · ${videoCount} video${videoCount === 1 ? '' : 's'}${unsupported ? ` · ${unsupported} unavailable or unsupported` : ''}.`)

  const results = { imported: 0, skipped: unsupported + manifestSkipped, failed: 0 }
  await mapConcurrent(supported, options.concurrency, async ({ path, item: photo, kind }, index) => {
    try {
      const sourceKey = `photos:${album.id}:asset:${photo.id}`
      if (manifest.completed[sourceKey]) {
        results.skipped += 1
        console.log(`  [${index + 1}/${supported.length}] already kept · ${basename(path)}`)
        return
      }
      const hint = `From Apple Photos album “${album.name}”. ${photo.description || withoutExtension(photo.filename || photo.name || path).replace(/^\d+-/, '').replace(/[-_]+/g, ' ')}`
      if (options.dryRun) {
        results.imported += 1
        console.log(`  [${index + 1}/${supported.length}] would import · ${basename(path)}`)
        return
      }
      const originalBytes = (await stat(path)).size
      let item
      let savedBytes
      if (kind === 'video') {
        const result = await uploadVideo(options, path, photo.filename || basename(path), hint, photo.date)
        item = result.item
        savedBytes = result.savedBytes
      } else {
        const bytes = await compressImage(path, options)
        item = await uploadImage(options, bytes, photo.filename || basename(path), hint, photo.date)
        savedBytes = bytes.length
      }
      manifest.completed[sourceKey] = {
        itemId: item.id,
        importedAt: new Date().toISOString(),
        filename: photo.filename || basename(path),
        originalBytes,
        savedBytes,
        kind,
      }
      await saveManifest(manifest)
      results.imported += 1
      console.log(`  [${index + 1}/${supported.length}] kept ${kind} · ${item.title} · ${(savedBytes / 1024 / (kind === 'video' ? 1024 : 1)).toFixed(kind === 'video' ? 1 : 0)} ${kind === 'video' ? 'MB' : 'KB'}`)
    } catch (error) {
      results.failed += 1
      console.warn(`  [${index + 1}/${supported.length}] failed · ${basename(path)} · ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  })
  if (options.keepExport) {
    console.log(`  Rendered export kept at ${exportPath}`)
    cleanup.exportPath = undefined
  }
  return results
}

function mergeResults(results) {
  return results.reduce((total, result) => ({
    imported: total.imported + result.imported,
    skipped: total.skipped + result.skipped,
    failed: total.failed + result.failed,
  }), { imported: 0, skipped: 0, failed: 0 })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { usage(); return }
  const interactive = !options.note && !options.markdown && !options.album
  const needsApple = Boolean(options.note || options.album || options.list || interactive)
  if (needsApple && process.platform !== 'darwin') throw new Error('Apple Notes and Photos imports only run on macOS. Markdown imports work on any platform.')

  console.log('Kept · one-time importer')
  console.log('Nothing is changed until a source is selected.')
  const [notesResult, albumsResult] = await Promise.allSettled([
    options.note || options.list || interactive ? runJxa(listNotesScript) : Promise.resolve([]),
    options.album || options.list || interactive ? runJxa(listAlbumsScript) : Promise.resolve([]),
  ])
  if (notesResult.status === 'rejected') throw notesResult.reason
  const notes = notesResult.value
  const photosError = albumsResult.status === 'rejected'
    ? 'Photos could not be automated. Allow your terminal app to control Photos in System Settings → Privacy & Security → Automation, then run this command again.'
    : undefined
  if (photosError && options.album) throw new Error(photosError)
  const albums = albumsResult.status === 'fulfilled' ? albumsResult.value : []
  if (options.list) {
    displayNotes(notes)
    if (photosError) console.log(`\nPhotos albums\n  ${photosError}`)
    else displayAlbums(albums)
    return
  }

  let selectedNote = resolveSelection(notes, options.note, 'note')
  let selectedAlbum = resolveSelection(albums, options.album, 'album')
  let selectedMarkdown
  if (options.markdown) {
    const path = resolve(options.markdown)
    selectedMarkdown = markdownLinkSource(path, await readFile(path, 'utf8'))
  }
  if (interactive) {
    if (!process.stdin.isTTY) throw new Error('Supply --note and/or --album when running non-interactively.')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      displayNotes(notes)
      selectedNote = await choose(notes, 'note', rl)
      if (photosError) console.log(`\nPhotos albums\n  ${photosError}`)
      else {
        displayAlbums(albums)
        selectedAlbum = await choose(albums, 'Photos album', rl)
      }
    } finally {
      rl.close()
    }
  }
  if (!selectedNote && !selectedMarkdown && !selectedAlbum) {
    console.log('\nNothing selected. No changes made.')
    return
  }
  if (selectedNote?.protected) throw new Error('Unlock the selected note in Notes before importing it.')

  const cleanup = { apiChild: undefined, exportPath: undefined }
  const onInterrupt = () => {
    cleanup.apiChild?.kill('SIGTERM')
    if (cleanup.exportPath) void rm(cleanup.exportPath, { recursive: true, force: true })
    process.exit(130)
  }
  process.once('SIGINT', onInterrupt)
  try {
    const manifest = await loadManifest()
    cleanup.apiChild = await ensureApi(options)
    if (!options.dryRun) await authenticateImporter(options)
    const results = []
    if (selectedNote) results.push(await importNote(options, selectedNote, manifest))
    if (selectedMarkdown) results.push(await importMarkdown(options, selectedMarkdown, manifest))
    if (selectedAlbum) results.push(await importAlbum(options, selectedAlbum, manifest, cleanup))
    await manifestWrite
    const total = mergeResults(results)
    console.log(`\n${options.dryRun ? 'Dry run complete' : 'Import complete'} · ${total.imported} ${options.dryRun ? 'would import' : 'imported'} · ${total.skipped} skipped · ${total.failed} failed`)
    if (options.dryRun) console.log('Run again without --dry-run when the selection looks right.')
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    cleanup.apiChild?.kill('SIGTERM')
    if (cleanup.exportPath) await rm(cleanup.exportPath, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nImport stopped: ${error instanceof Error ? error.message : 'Unknown error'}`)
    process.exitCode = 1
  })
}

export { extractLinks, markdownLinkSource, normalizeLink }
