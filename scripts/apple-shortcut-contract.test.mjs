import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shortcutSourcePath = path.join(root, 'apple-shortcut', 'Keep-in-Kept.cherri')
const shortcutArtifactPath = path.join(root, 'public', 'downloads', 'Keep-in-Kept.shortcut')

async function text(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8')
}

test('the Shortcut remains available for every supported Share Sheet input', async () => {
  const source = await readFile(shortcutSourcePath, 'utf8')

  assert.match(source, /^#define name Keep-in-Kept$/m)
  assert.match(source, /^#define inputs image, media, url, text, webpage, file$/m)
  assert.match(source, /^#define from sharesheet, search$/m)
  assert.match(source, /^#define noinput stopwith /m)
})

test('generic screenshot files are detected as images before text or URL handling', async () => {
  const source = await readFile(shortcutSourcePath, 'utf8')
  const fileBranch = source.indexOf('if @sharedType contains "File"')
  const imageDetection = source.indexOf('getImages(@sharedItem)', fileBranch)
  const commonImagePipeline = source.indexOf('if @isImage', imageDetection)
  const textFallback = source.indexOf('@sharedText = getText(@sharedItem)', commonImagePipeline)

  assert.ok(fileBranch > 0)
  assert.ok(imageDetection > fileBranch)
  assert.ok(commonImagePipeline > imageDetection)
  assert.ok(textFallback > commonImagePipeline)
  assert.match(source, /convertToJPEG\(@imageCandidate, 0\.88, true\)/)
})

test('Google rich shares extract a URL safely and plain text becomes a note', async () => {
  const source = await readFile(shortcutSourcePath, 'utf8')
  const shortcutPattern = "https?://[^\\s<>]+"
  const javascriptPattern = /https?:\/\/[^\s<>]+/i

  assert.ok(source.includes(`matchText('${shortcutPattern}', @sharedText, false)`))
  assert.doesNotMatch(source, /\bgetURLs\s*\(/)
  assert.equal('Games People Play\nhttps://www.google.com/url?q=https%3A%2F%2Fexample.com'.match(javascriptPattern)?.[0], 'https://www.google.com/url?q=https%3A%2F%2Fexample.com')
  assert.equal('https://share.google/abc123'.match(javascriptPattern)?.[0], 'https://share.google/abc123')
  assert.equal('A thought with no link'.match(javascriptPattern), null)
  assert.match(source, /\{"type": "note", "value": "\{@sharedText\}"/)
})

test('the Shortcut auto-files a sole personal library and asks only when needed', async () => {
  const source = await readFile(shortcutSourcePath, 'utf8')
  const automatic = source.indexOf('getValue(destinationEnvelope, "defaultDestination")')
  const guard = source.indexOf('if !@destination', automatic)
  const picker = source.indexOf('chooseFromList(destinationLabels, "Choose a library")', guard)

  assert.ok(automatic > 0)
  assert.ok(guard > automatic)
  assert.ok(picker > guard)
  assert.doesNotMatch(source, /Where should this go\?/)
})

test('image and video bytes upload directly before a server-side capture finalisation', async () => {
  const source = await readFile(shortcutSourcePath, 'utf8')

  assert.match(source, /\/api\/apple-shortcut\/upload-ticket/)
  assert.match(source, /keptFileRequest\("\{@imageUploadUrl\}", "PUT", jpeg/)
  assert.match(source, /keptFileRequest\("\{@videoUploadUrl\}", "PUT", video/)
  assert.match(source, /\/api\/apple-shortcut\/capture-staged/)
  assert.match(source, /hash\(jpeg, "SHA256"\)/)
  assert.match(source, /hash\(video, "SHA256"\)/)
})

test('the checked-in artifact is signed for distribution and contains no generated debug files', async () => {
  const buildScript = await text('scripts/build-apple-shortcut.sh')
  const artifact = await stat(shortcutArtifactPath)

  assert.ok(artifact.isFile())
  assert.ok(artifact.size > 20_000, `Expected a signed Shortcut artifact, received ${artifact.size} bytes`)
  assert.match(buildScript, /--share=anyone/)
  assert.match(buildScript, /--derive-uuids/)
  assert.match(buildScript, /public\/downloads\/Keep-in-Kept\.shortcut/)
})

test('database migrations keep pairing credentials hashed, private, and single-connection', async () => {
  const tables = await text('supabase/migrations/20260825200000_create_apple_shortcut_capture.sql')
  const singleton = await text('supabase/migrations/20260825201000_single_apple_shortcut_connection.sql')

  assert.match(tables, /code_hash text not null unique/i)
  assert.match(tables, /token_hash text not null unique/i)
  assert.doesNotMatch(tables, /\n\s*(?:code|token)\s+text/i)
  assert.match(tables, /enable row level security/gi)
  assert.match(tables, /user_id = \(select auth\.uid\(\)\)/)
  assert.match(singleton, /create unique index[^;]+user_id/is)
})
