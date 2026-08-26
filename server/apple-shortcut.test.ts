import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appleShortcutName,
  buildShortcutRunUrl,
  cleanDeviceName,
  cleanFilename,
  composeShortcutDestinations,
  encodeDestination,
  fileExtension,
  isShortcutStagingPath,
  parseShortcutAuthorization,
  shortcutDestinationEnvelope,
  shortcutStagingPrefix,
} from './apple-shortcut.js'

function decodeDestination(id: string) {
  return JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as { ownerUserId: string; spaceName: string }
}

test('a personal-only account auto-files without showing a destination picker', () => {
  const destinations = composeShortcutDestinations({
    userId: 'user-me',
    libraryOwnerIds: [],
    directSpaces: [],
    ownerLabels: new Map(),
  })

  assert.deepEqual(destinations, [{
    id: encodeDestination('user-me', ''),
    label: 'My library',
    ownerUserId: 'user-me',
    spaceName: '',
  }])
  assert.deepEqual(shortcutDestinationEnvelope(destinations), {
    choices: { 'My library': destinations[0].id },
    defaultDestination: destinations[0].id,
  })
  assert.deepEqual(decodeDestination(destinations[0].id), { ownerUserId: 'user-me', spaceName: '' })
})

test('whole-library collaborators choose only a library and Kept auto-files within it', () => {
  const destinations = composeShortcutDestinations({
    userId: 'user-me',
    libraryOwnerIds: ['owner-z', 'owner-a', 'owner-a'],
    directSpaces: [
      { ownerUserId: 'owner-a', spaceName: 'Objects' },
      { ownerUserId: 'owner-z', spaceName: 'Reading list' },
    ],
    ownerLabels: new Map([
      ['owner-a', 'Alice’s library'],
      ['owner-z', 'Zoe’s library'],
    ]),
  })

  assert.deepEqual(destinations.map(({ label, spaceName }) => ({ label, spaceName })), [
    { label: 'My library', spaceName: '' },
    { label: 'Alice’s library', spaceName: '' },
    { label: 'Zoe’s library', spaceName: '' },
  ])
  assert.equal(shortcutDestinationEnvelope(destinations).defaultDestination, '')
})

test('direct space shares stay explicit, deterministic, and deduplicated', () => {
  const destinations = composeShortcutDestinations({
    userId: 'user-me',
    libraryOwnerIds: ['full-owner'],
    directSpaces: [
      { ownerUserId: 'space-owner', spaceName: 'Travel' },
      { ownerUserId: 'space-owner', spaceName: 'Objects' },
      { ownerUserId: 'space-owner', spaceName: 'Travel' },
      { ownerUserId: 'full-owner', spaceName: 'Suppressed by full access' },
      { ownerUserId: 'user-me', spaceName: 'Never expose personal spaces' },
      { ownerUserId: '', spaceName: 'Invalid' },
    ],
    ownerLabels: new Map([
      ['full-owner', 'Alex’s library'],
      ['space-owner', 'Sam’s library'],
    ]),
  })

  assert.deepEqual(destinations.map(({ label }) => label), [
    'My library',
    'Alex’s library',
    'Sam’s library · Objects',
    'Sam’s library · Travel',
  ])
  assert.deepEqual(decodeDestination(destinations[2].id), { ownerUserId: 'space-owner', spaceName: 'Objects' })
})

test('duplicate owner display names never overwrite a destination choice', () => {
  const destinations = composeShortcutDestinations({
    userId: 'user-me',
    libraryOwnerIds: ['owner-1', 'owner-2'],
    directSpaces: [],
    ownerLabels: new Map([
      ['owner-1', 'Alex’s library'],
      ['owner-2', 'Alex’s library'],
    ]),
  })
  const envelope = shortcutDestinationEnvelope(destinations)

  assert.deepEqual(destinations.map(({ label }) => label), ['My library', 'Alex’s library', 'Alex’s library (2)'])
  assert.equal(Object.keys(envelope.choices).length, destinations.length)
})

test('pairing deep links target the installed Shortcut and preserve the one-use payload', () => {
  const runUrl = new URL(buildShortcutRunUrl('https://kept.example/', 'pair_code-123456789012345678901234'))

  assert.equal(appleShortcutName, 'Keep-in-Kept')
  assert.equal(runUrl.protocol, 'shortcuts:')
  assert.equal(runUrl.hostname, 'run-shortcut')
  assert.equal(runUrl.searchParams.get('name'), appleShortcutName)
  assert.equal(runUrl.searchParams.get('input'), 'text')
  assert.deepEqual(JSON.parse(runUrl.searchParams.get('text') ?? ''), {
    keptPair: 'pair_code-123456789012345678901234',
    baseUrl: 'https://kept.example',
  })
})

test('Shortcut authorization accepts only bounded opaque bearer credentials', () => {
  const token = 'A'.repeat(32) + '_safe-token'
  assert.equal(parseShortcutAuthorization(`Bearer ${token}`), token)
  assert.equal(parseShortcutAuthorization(`shortcut ${token}`), token)
  assert.equal(parseShortcutAuthorization(`Bearer ${'a'.repeat(31)}`), undefined)
  assert.equal(parseShortcutAuthorization(`Bearer ${token}.unsafe`), undefined)
  assert.equal(parseShortcutAuthorization(`Bearer ${token} extra`), undefined)
  assert.equal(parseShortcutAuthorization(''), undefined)
})

test('staged uploads are bound to their owner and Shortcut connection', () => {
  const prefix = shortcutStagingPrefix('owner-1', 'connection-1')
  assert.equal(prefix, 'owner-1/shortcut-staging/connection-1/')
  assert.equal(isShortcutStagingPath(`${prefix}photo.webp`, 'owner-1', 'connection-1'), true)
  assert.equal(isShortcutStagingPath(`${prefix}../other/photo.webp`, 'owner-1', 'connection-1'), false)
  assert.equal(isShortcutStagingPath(`${prefix}photo.webp`, 'owner-2', 'connection-1'), false)
  assert.equal(isShortcutStagingPath(`${prefix}photo.webp`, 'owner-1', 'connection-2'), false)
})

test('capture metadata is normalised before entering storage and AI pipelines', () => {
  assert.equal(cleanDeviceName('  Pietro\n iPhone  '), 'Pietro iPhone')
  assert.equal(cleanDeviceName(''), 'Apple device')
  assert.equal(cleanFilename('../odd:<name>?*.HEIC', 'photo.jpg'), '..-odd-name-.HEIC')
  assert.equal(cleanFilename('\n\t', 'photo.jpg'), 'photo.jpg')
  assert.equal(fileExtension('image/png', 'image'), 'png')
  assert.equal(fileExtension('image/heif', 'image'), 'heic')
  assert.equal(fileExtension('video/quicktime', 'video'), 'mov')
  assert.equal(fileExtension('video/mp4', 'video'), 'mp4')
})
