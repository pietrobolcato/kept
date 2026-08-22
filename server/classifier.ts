import { readFile } from 'node:fs/promises'
import type { ItemKind, MemoryItem } from '../src/types.js'

type Classification = Pick<MemoryItem, 'title' | 'description' | 'space' | 'tags' | 'searchTerms' | 'palette' | 'aiConfidence'> & { locationName?: string }
type SpaceOption = { name: string; description?: string }

const paletteMap: Record<string, string[]> = {
  'Home ideas': ['#d9d0c3', '#66705a', '#8a6b50'],
  'Design references': ['#cbb8ea', '#ffc7a8', '#486756'],
  'Reading list': ['#e85f4b', '#f4cc56', '#efe8db'],
  Travel: ['#398395', '#d8ae70', '#eee2c9'],
  Objects: ['#ded5c7', '#6e665e', '#342920'],
  Inbox: ['#d9d6cd', '#9b9890', '#595750'],
}

function normaliseSpaces(availableSpaces: Array<string | SpaceOption>) {
  const options = availableSpaces.flatMap((space) => {
    if (typeof space === 'string') return space.trim() ? [{ name: space.trim(), description: '' }] : []
    const name = space.name.trim()
    return name ? [{ name, description: space.description?.trim() ?? '' }] : []
  })
  return options.length ? options : Object.keys(paletteMap).map((name) => ({ name, description: '' }))
}

function semanticSpace(input: string, spaces: SpaceOption[]) {
  const meaningfulWords = (value: string) => (value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).map((word) => {
    if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
    if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1)
    return word
  })
  const inputWords = new Set(meaningfulWords(input))
  const ranked = spaces.map((space) => {
    const words = meaningfulWords(`${space.name} ${space.description ?? ''}`)
    const score = words.reduce((total, word) => total + (inputWords.has(word) ? (space.name.toLowerCase().includes(word) ? 3 : 1) : 0), 0)
    return { space, score }
  }).sort((left, right) => right.score - left.score)
  return ranked[0]?.score ? ranked[0].space.name : undefined
}

function localClassification(value: string, kind: ItemKind, availableSpaces: SpaceOption[]): Classification {
  const input = value.toLowerCase()
  const urlHost = kind === 'link' ? (() => {
    try {
      const match = value.match(/https?:\/\/[^\s]+/i)
      return new URL(match?.[0] ?? value).hostname.replace('www.', '')
    } catch {
      return 'Saved link'
    }
  })() : ''

  const rules = [
    { match: /home|house|interior|chair|room|architect|garage|garden|kitchen/, space: 'Home ideas', tags: ['home', 'inspiration', 'interior'] },
    { match: /design|type|font|brand|interface|web|studio|creative/, space: 'Design references', tags: ['design', 'reference', 'visual'] },
    { match: /book|read|essay|article|author/, space: 'Reading list', tags: ['reading', 'ideas', 'reference'] },
    { match: /travel|hotel|trip|italy|japan|restaurant|city/, space: 'Travel', tags: ['travel', 'place', 'future trip'] },
    { match: /knife|lamp|table|camera|object|product|ceramic/, space: 'Objects', tags: ['object', 'product design', 'material'] },
  ]
  const found = rules.find((rule) => rule.match.test(input))
  const namedRuleSpace = availableSpaces.find((space) => space.name === found?.space)?.name
  const space = semanticSpace(input, availableSpaces)
    ?? namedRuleSpace
    ?? availableSpaces.find((option) => option.name === 'Inbox')?.name
    ?? availableSpaces[0].name
  const rawTitle = value.trim().split(/[.!?\n]/)[0].slice(0, 58)
  const readableTitle = rawTitle ? `${rawTitle.charAt(0).toUpperCase()}${rawTitle.slice(1)}` : kind === 'video' ? 'Video memory' : kind === 'image' ? 'Visual reference' : 'Untitled thought'
  const fallbackTitle = kind === 'link' ? `Saved from ${urlHost}` : readableTitle

  return {
    title: fallbackTitle,
    description: kind === 'link'
      ? 'A newly saved link, classified from its address and ready for enrichment.'
      : kind === 'image' || kind === 'video'
        ? `An uploaded visual reference saved as ${fallbackTitle.toLowerCase()}.`
        : value.trim().slice(0, 170),
    space,
    tags: found?.tags ?? ['uncategorised', 'new'],
    searchTerms: [value, ...(found?.tags ?? []), space],
    palette: paletteMap[space] ?? paletteMap.Inbox,
    aiConfidence: found ? 0.88 : 0.72,
  }
}

export async function classify(
  value: string,
  kind: ItemKind,
  imagePath?: string,
  imageUrl?: string,
  imageBytes?: Buffer,
  imageMediaType?: string,
  availableSpaces: Array<string | SpaceOption> = Object.keys(paletteMap),
): Promise<Classification> {
  const spaceOptions = normaliseSpaces(availableSpaces)
  const spaceNames = spaceOptions.map(({ name }) => name)
  const fallback = localClassification(value, kind, spaceOptions)
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallback

  try {
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: `Classify this saved ${kind}: ${value || 'uploaded image'}. Infer what someone would naturally call it later. Choose the best space using both its name and purpose:\n${spaceOptions.map((space) => `- ${space.name}${space.description ? `: ${space.description}` : ''}`).join('\n')}` },
    ]

    if (imageBytes) {
      content.unshift({ type: 'image', source: { type: 'base64', media_type: imageMediaType ?? 'image/jpeg', data: imageBytes.toString('base64') } })
    } else if (imagePath) {
      const bytes = await readFile(imagePath)
      const extension = imagePath.split('.').pop()?.toLowerCase()
      const mediaType = extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : extension === 'webp' ? 'image/webp' : 'image/jpeg'
      content.unshift({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } })
    } else if (imageUrl) {
      content.unshift({ type: 'image', source: { type: 'url', url: imageUrl } })
    }

    const result = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
        max_tokens: 700,
        system: 'You organise a personal visual memory. Be specific, concrete, concise, and useful for future semantic retrieval.',
        messages: [{ role: 'user', content }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A specific human-readable title under 70 characters.' },
                description: { type: 'string', description: 'One concise sentence describing the saved item.' },
                space: { type: 'string', enum: spaceNames },
                tags: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Return 3 to 5 concrete visual or topical tags.' },
                searchTerms: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Return 5 to 8 natural phrases someone might search later. Include broader concepts, concrete examples, likely product categories, and conceptual synonyms.' },
                palette: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Return exactly three representative six-digit hex colours, ordered from most to least visually dominant on the subject. Ignore tiny accents such as logos, labels, isolated stitches, and incidental page or photo backgrounds unless they occupy substantial visible area.' },
                locationName: { type: ['string', 'null'], description: 'A city, neighbourhood, venue, building, or region only when the page text or image makes it confidently identifiable. Never guess from visual style alone; otherwise return null.' },
              },
              required: ['title', 'description', 'space', 'tags', 'searchTerms', 'palette', 'locationName'],
              additionalProperties: false,
            },
          },
        },
      }),
    })
    if (!result.ok) {
      const details = (await result.text()).slice(0, 500)
      console.warn(`Anthropic classification failed (${result.status}): ${details}`)
      return fallback
    }
    const json = await result.json() as { content?: Array<{ type?: string; text?: string }> }
    const raw = json.content?.find((block) => block.type === 'text')?.text
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Classification>
    const palette = parsed.palette?.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 3)
    return {
      ...fallback,
      ...parsed,
      tags: parsed.tags?.filter(Boolean).slice(0, 5) ?? fallback.tags,
      searchTerms: parsed.searchTerms?.filter(Boolean).slice(0, 8) ?? fallback.searchTerms,
      palette: palette?.length === 3 ? palette : fallback.palette,
      locationName: typeof parsed.locationName === 'string' ? parsed.locationName.trim().slice(0, 240) || undefined : undefined,
      aiConfidence: 0.96,
    }
  } catch (error) {
    console.warn('Anthropic classification failed:', error instanceof Error ? error.message : 'Unknown error')
    return fallback
  }
}
