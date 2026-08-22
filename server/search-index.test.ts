import assert from 'node:assert/strict'
import test from 'node:test'
import type { MemoryItem } from '../src/types.js'
import { searchItemsByColour } from './search-index.js'

function item(id: string, palette: string[]): MemoryItem {
  return {
    id,
    title: id,
    description: '',
    kind: 'image',
    space: 'Objects',
    tags: [],
    palette,
    createdAt: '2026-08-06T00:00:00.000Z',
    favourite: false,
    source: 'Upload',
    aiConfidence: 1,
    searchTerms: [],
  }
}

test('dominant colours qualify as strong matches', () => {
  assert.deepEqual(searchItemsByColour('#4e9c1c', [item('green-object', ['#4e9c1c', '#f5f3ee', '#222222'])]), [
    { id: 'green-object', relevance: 100 },
  ])
})

test('a close secondary colour can contribute without looking dominant', () => {
  assert.deepEqual(searchItemsByColour('#8fd694', [item('green-accent', ['#f5f3ee', '#8fd694', '#222222'])]), [
    { id: 'green-accent', relevance: 48 },
  ])
})

test('tiny third-colour accents cannot qualify an item on their own', () => {
  assert.deepEqual(searchItemsByColour('#4e9c1c', [item('tiny-green-detail', ['#f5f3ee', '#222222', '#4e9c1c'])]), [])
})

test('the reported green no longer matches the pants, oil, or black shoes', () => {
  const results = searchItemsByColour('#4e9c1c', [
    item('pants', ['#f5f3ee', '#8fd694', '#2b2b28']),
    item('oil', ['#f2f0e6', '#e9e79a', '#ffffff']),
    item('shoes', ['#1a1a1a', '#e8e5df', '#c9a876']),
  ])
  assert.deepEqual(results, [])
})
