import assert from 'node:assert/strict'
import test from 'node:test'
import { extractLinks, markdownLinkSource, normalizeLink } from './import-apple.mjs'

test('normalizes repeatedly HTML-encoded query separators and removes tracking', () => {
  assert.equal(
    normalizeLink('https://example.com/item?colour=09&amp;amp;size=375&amp;srsltid=tracking'),
    'https://example.com/item?colour=09&size=375',
  )
})

test('deduplicates HTML, Markdown, and visible URL versions of the same link', () => {
  const links = extractLinks({
    html: '<a href="https://example.com/item?colour=09&amp;size=375">Cloths</a>',
    plaintext: '[Cloths](https://example.com/item?colour=09&amp;amp;size=375)\nhttps://example.com/item?colour=09&size=375',
    attachments: [],
  })

  assert.deepEqual(links, [{
    url: 'https://example.com/item?colour=09&size=375',
    label: 'Cloths',
  }])
})

test('extracts link metadata used by HTML and rich-note exports', () => {
  const links = extractLinks({
    html: '<div data-url="https://example.com/scale?utm_source=notes">Scale</div><object data="https://example.com/peeler"></object>',
    plaintext: '',
    attachments: [],
  })

  assert.deepEqual(links, [
    { url: 'https://example.com/scale', label: 'Scale' },
    { url: 'https://example.com/peeler', label: '' },
  ])
})

test('keeps balanced parentheses in a URL while trimming sentence punctuation', () => {
  assert.equal(normalizeLink('https://example.com/wiki/Design_(object).'), 'https://example.com/wiki/Design_(object)')
})

test('extracts inline, reference, autolink, and visible URLs from Markdown', () => {
  const source = markdownLinkSource('/tmp/links.md', `
  [https://old.example/item](https://example.com/inline)
[Reference][item]
<https://example.com/autolink>
https://example.com/visible

[item]: https://example.com/reference "Reference title"
  `)

  assert.deepEqual(extractLinks(source), [
    { url: 'https://example.com/inline', label: 'https://old.example/item' },
    { url: 'https://example.com/reference', label: 'Reference' },
    { url: 'https://example.com/autolink', label: 'https://example.com/autolink' },
    { url: 'https://example.com/visible', label: 'https://example.com/visible' },
  ])
})
