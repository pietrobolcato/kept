import type { MemoryItem } from './types'

export type DateField = 'relevant' | 'captured' | 'kept'
export type DatePreset = 'any' | 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'thisYear' | 'custom'

export interface DateRange {
  from: string
  to: string
  label: string
}

export interface DateIntent extends DateRange {
  residualQuery: string
  phrase: string
}

const numberWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30,
}

const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function parts(today?: string) {
  const match = today?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (match) return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) }
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() }
}

function localStart(year: number, month: number, day: number, offsetMinutes: number) {
  return new Date(Date.UTC(year, month, day) + offsetMinutes * 60_000)
}

function addDays(value: Date, amount: number) {
  return new Date(value.getTime() + amount * 86_400_000)
}

function cleanResidual(query: string, start: number, length: number) {
  return `${query.slice(0, start)} ${query.slice(start + length)}`
    .replace(/\s+/g, ' ').replace(/\b(?:from|in|on)\s*$/i, '').replace(/^[,;:\s-]+|[,;:\s-]+$/g, '').trim()
}

function rangeForDay(day: Date, label: string): DateRange {
  return { from: day.toISOString(), to: addDays(day, 1).toISOString(), label }
}

function makeIntent(query: string, match: RegExpMatchArray, range: DateRange): DateIntent {
  return { ...range, phrase: match[0], residualQuery: cleanResidual(query, match.index ?? 0, match[0].length) }
}

export function presetDateRange(preset: DatePreset, today?: string, offsetMinutes = 0): DateRange | undefined {
  if (preset === 'any' || preset === 'custom') return undefined
  const current = parts(today)
  const start = localStart(current.year, current.month, current.day, offsetMinutes)
  if (preset === 'today') return rangeForDay(start, 'Today')
  if (preset === 'yesterday') return rangeForDay(addDays(start, -1), 'Yesterday')
  if (preset === 'last7' || preset === 'last30') {
    const days = preset === 'last7' ? 7 : 30
    return { from: addDays(start, -(days - 1)).toISOString(), to: addDays(start, 1).toISOString(), label: `Last ${days} days` }
  }
  if (preset === 'thisMonth') return {
    from: localStart(current.year, current.month, 1, offsetMinutes).toISOString(),
    to: localStart(current.year, current.month + 1, 1, offsetMinutes).toISOString(),
    label: 'This month',
  }
  return {
    from: localStart(current.year, 0, 1, offsetMinutes).toISOString(),
    to: localStart(current.year + 1, 0, 1, offsetMinutes).toISOString(),
    label: 'This year',
  }
}

export function extractDateIntent(query: string, today?: string, offsetMinutes = 0): DateIntent | undefined {
  const current = parts(today)
  const start = localStart(current.year, current.month, current.day, offsetMinutes)
  let match = query.match(/\b(today)\b/i)
  if (match) return makeIntent(query, match, rangeForDay(start, 'Today'))
  match = query.match(/\b(yesterday)\b/i)
  if (match) return makeIntent(query, match, rangeForDay(addDays(start, -1), 'Yesterday'))
  match = query.match(/\b((?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty))\s+days?\s+ago\b/i)
  if (match) {
    const amount = Number(match[1]) || numberWords[match[1].toLowerCase()]
    if (amount > 0 && amount <= 365) return makeIntent(query, match, rangeForDay(addDays(start, -amount), amount === 1 ? 'Yesterday' : `${amount} days ago`))
  }
  match = query.match(/\b(last\s+(7|30)\s+days?)\b/i)
  if (match) return makeIntent(query, match, presetDateRange(match[2] === '7' ? 'last7' : 'last30', today, offsetMinutes)!)
  match = query.match(/\b(this|last)\s+(week|month|year)\b/i)
  if (match) {
    const previous = match[1].toLowerCase() === 'last'
    const unit = match[2].toLowerCase()
    let from: Date; let to: Date
    if (unit === 'week') {
      const weekday = new Date(Date.UTC(current.year, current.month, current.day)).getUTCDay() || 7
      const thisMonday = addDays(start, 1 - weekday)
      from = previous ? addDays(thisMonday, -7) : thisMonday
      to = previous ? thisMonday : addDays(start, 1)
    } else if (unit === 'month') {
      from = localStart(current.year, current.month - (previous ? 1 : 0), 1, offsetMinutes)
      to = previous ? localStart(current.year, current.month, 1, offsetMinutes) : localStart(current.year, current.month + 1, 1, offsetMinutes)
    } else {
      from = localStart(current.year - (previous ? 1 : 0), 0, 1, offsetMinutes)
      to = localStart(current.year + (previous ? 0 : 1), 0, 1, offsetMinutes)
    }
    return makeIntent(query, match, { from: from.toISOString(), to: to.toISOString(), label: `${previous ? 'Last' : 'This'} ${unit}` })
  }
  match = query.match(new RegExp(`\\b(${months.join('|')})(?:\\s+(20\\d{2}|19\\d{2}))?\\b`, 'i'))
  if (match) {
    const month = months.indexOf(match[1].toLowerCase())
    const year = match[2] ? Number(match[2]) : current.year
    return makeIntent(query, match, {
      from: localStart(year, month, 1, offsetMinutes).toISOString(),
      to: localStart(year, month + 1, 1, offsetMinutes).toISOString(),
      label: new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month, 1))),
    })
  }
  match = query.match(/(?:\bin\s+)?\b(19\d{2}|20\d{2})\b/i)
  if (match) {
    const year = Number(match[1])
    return makeIntent(query, match, { from: localStart(year, 0, 1, offsetMinutes).toISOString(), to: localStart(year + 1, 0, 1, offsetMinutes).toISOString(), label: String(year) })
  }
  return undefined
}

export function itemDate(item: MemoryItem, field: DateField = 'relevant') {
  if (field === 'captured') return item.capturedAt
  if (field === 'kept') return item.createdAt
  return item.capturedAt ?? item.createdAt
}

export function filterItemsByDate(items: MemoryItem[], range: Pick<DateRange, 'from' | 'to'>, field: DateField = 'relevant') {
  const from = new Date(range.from).getTime()
  const to = new Date(range.to).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return items
  return items.filter((item) => {
    const value = itemDate(item, field)
    if (!value) return false
    const timestamp = new Date(value).getTime()
    return timestamp >= from && timestamp < to
  })
}
