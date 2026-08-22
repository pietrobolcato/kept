import assert from 'node:assert/strict'
import test from 'node:test'
import { extractDateIntent, filterItemsByDate } from '../src/date-search.js'
import type { MemoryItem } from '../src/types.js'

const base: MemoryItem = { id: '1', title: 'Photo', description: '', kind: 'image', space: 'Home', tags: [], palette: [], createdAt: '2026-08-22T10:00:00.000Z', favourite: false, source: 'Upload', aiConfidence: 1, searchTerms: [] }

test('understands a relative day while preserving the semantic query', () => {
  const intent = extractDateIntent('cream sofa two days ago', '2026-08-22', -60)
  assert.equal(intent?.label, '2 days ago')
  assert.equal(intent?.residualQuery, 'cream sofa')
  assert.equal(intent?.from, '2026-08-19T23:00:00.000Z')
  assert.equal(intent?.to, '2026-08-20T23:00:00.000Z')
})

test('understands month and year phrases', () => {
  const intent = extractDateIntent('lamps from March 2024', '2026-08-22', 0)
  assert.equal(intent?.label, 'March 2024')
  assert.equal(intent?.residualQuery, 'lamps')
  assert.equal(intent?.from, '2024-03-01T00:00:00.000Z')
  assert.equal(intent?.to, '2024-04-01T00:00:00.000Z')
})

test('relevant date prefers the original photo date and kept date remains deterministic', () => {
  const item = { ...base, capturedAt: '2022-05-10T12:00:00.000Z' }
  const range = { from: '2022-05-10T00:00:00.000Z', to: '2022-05-11T00:00:00.000Z' }
  assert.deepEqual(filterItemsByDate([item], range, 'relevant').map(({ id }) => id), ['1'])
  assert.deepEqual(filterItemsByDate([item], range, 'kept'), [])
})
