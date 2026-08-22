import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Session } from '@supabase/supabase-js'
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  CalendarDays,
  ChevronDown,
  Clock3,
  Command,
  FileText,
  Folder,
  Grid2X2,
  Heart,
  Image as ImageIcon,
  Layers2,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  MapPin,
  MoreHorizontal,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Users,
  Video,
  X,
} from 'lucide-react'
import type { ItemKind, MemoryItem } from './types'
import { AssistantButton, AssistantPanel } from './AssistantPanel'
import { AuthLoading, AuthScreen } from './AuthScreen'
import { MobileCaptureDialog } from './MobileCapture'
import { ShareLibraryDialog, ShareSpaceDialog, SpaceInvitationGate, type SharedSpace } from './SpaceSharing'
import { apiFetch } from './lib/api'
import { supabase } from './lib/supabase'
import { itemDate, presetDateRange, type DateField, type DatePreset, type DateRange } from './date-search'

type View = 'all' | 'recent' | 'favourites' | 'space'
type CaptureTab = 'link' | 'upload' | 'note'
type SearchMatch = { id: string; relevance: number }
type SearchDateIntent = DateRange & { residualQuery: string }
type SortMode = 'auto' | 'date-desc' | 'date-asc' | 'kept-desc' | 'kept-asc'
type LibrarySpace = { id: string; ownerId: string; name: string; color: string; description: string; position: number; createdAt: string }
type SpaceMatch = { item: MemoryItem; relevance: number }
const pageSize = 18

const colourPresets = [
  ['Ink', '#2b2b2b'], ['Cream', '#e8e0d0'], ['Rust', '#bd5d45'], ['Mustard', '#d3a63b'],
  ['Sage', '#839276'], ['Forest', '#45654e'], ['Teal', '#4c9495'], ['Blue', '#507aa5'],
  ['Lavender', '#aa99c2'], ['Blush', '#d69a9b'],
] as const

type HsvColour = { h: number; s: number; v: number }

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value))
}

function hexToHsv(value: string): HsvColour {
  const fallback = '839276'
  const source = value.replace(/^#/, '')
  const hex = /^[0-9a-f]{6}$/i.test(source) ? source : fallback
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0
  if (delta) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6)
    else if (max === green) hue = 60 * ((blue - red) / delta + 2)
    else hue = 60 * ((red - green) / delta + 4)
  }
  return { h: hue < 0 ? hue + 360 : hue, s: max ? delta / max : 0, v: max }
}

function hsvToHex({ h, s, v }: HsvColour) {
  const hue = ((h % 360) + 360) % 360
  const chroma = v * s
  const secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1))
  const offset = v - chroma
  let channels: [number, number, number]
  if (hue < 60) channels = [chroma, secondary, 0]
  else if (hue < 120) channels = [secondary, chroma, 0]
  else if (hue < 180) channels = [0, chroma, secondary]
  else if (hue < 240) channels = [0, secondary, chroma]
  else if (hue < 300) channels = [secondary, 0, chroma]
  else channels = [chroma, 0, secondary]
  return `#${channels.map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('')}`
}

function ColourEditor({ value, onApply, onClear }: { value: string; onApply: (value: string) => void; onClear?: () => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(value || '#839276'))
  const selectedHex = hsvToHex(hsv)
  const [hexDraft, setHexDraft] = useState(selectedHex.slice(1).toUpperCase())
  const toneRef = useRef<HTMLDivElement>(null)

  useEffect(() => setHsv(hexToHsv(value || '#839276')), [value])
  useEffect(() => setHexDraft(selectedHex.slice(1).toUpperCase()), [selectedHex])

  const updateTone = (clientX: number, clientY: number) => {
    const bounds = toneRef.current?.getBoundingClientRect()
    if (!bounds) return
    setHsv((current) => ({
      ...current,
      s: clampUnit((clientX - bounds.left) / bounds.width),
      v: 1 - clampUnit((clientY - bounds.top) / bounds.height),
    }))
  }

  const commitHex = () => {
    const compact = hexDraft.trim().replace(/^#/, '')
    const expanded = /^[0-9a-f]{3}$/i.test(compact) ? compact.split('').map((character) => character.repeat(2)).join('') : compact
    if (/^[0-9a-f]{6}$/i.test(expanded)) setHsv(hexToHsv(`#${expanded}`))
    else setHexDraft(selectedHex.slice(1).toUpperCase())
  }

  const nudgeTone = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? .1 : .02
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    setHsv((current) => ({
      ...current,
      s: clampUnit(current.s + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0)),
      v: clampUnit(current.v + (event.key === 'ArrowDown' ? -step : event.key === 'ArrowUp' ? step : 0)),
    }))
  }

  return <div className="colour-editor">
    <div className="colour-editor-label"><span>Curated palette</span><output>{selectedHex.toUpperCase()}</output></div>
    <div className="colour-editor-presets">{colourPresets.map(([name, hex]) => <button type="button" key={hex} className={selectedHex.toLowerCase() === hex ? 'active' : ''} onClick={() => setHsv(hexToHsv(hex))} aria-label={name} aria-pressed={selectedHex.toLowerCase() === hex} title={name}><i style={{ background: hex }} /></button>)}</div>
    <div className="colour-editor-label custom"><span>Custom colour</span><small>Drag to fine-tune</small></div>
    <div
      ref={toneRef}
      className="colour-tone-field"
      style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
      role="slider"
      tabIndex={0}
      aria-label="Colour saturation and brightness"
      aria-valuetext={selectedHex.toUpperCase()}
      onKeyDown={nudgeTone}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); updateTone(event.clientX, event.clientY) }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateTone(event.clientX, event.clientY) }}
    >
      <i className="colour-tone-cursor" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: selectedHex }} />
    </div>
    <div className="colour-hue-row">
      <i style={{ background: selectedHex }} />
      <input className="colour-hue-slider" type="range" min="0" max="359" value={Math.round(hsv.h)} onChange={(event) => setHsv((current) => ({ ...current, h: Number(event.target.value) }))} aria-label="Hue" />
    </div>
    <div className="colour-editor-actions">
      <label className="colour-hex-field"><span>#</span><input value={hexDraft} maxLength={7} spellCheck={false} onChange={(event) => { const next = event.target.value.replace(/[^0-9a-f#]/gi, ''); setHexDraft(next); const compact = next.replace(/^#/, ''); if (/^[0-9a-f]{6}$/i.test(compact)) setHsv(hexToHsv(`#${compact}`)) }} onBlur={commitHex} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitHex() } }} aria-label="Hex colour" /></label>
      {onClear && <button type="button" className="colour-clear-button" onClick={onClear}>Clear</button>}
      <button type="button" className="colour-apply-button" onClick={() => onApply(selectedHex)}><Check size={13} /> Apply</button>
    </div>
  </div>
}

function ColourDialogButton({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open])
  return <>
    <button type="button" className="space-colour-button" onClick={() => setOpen(true)} aria-label={label} aria-haspopup="dialog" aria-expanded={open}><i style={{ background: value }} /></button>
    {open && createPortal(<div className="colour-picker-layer" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" className="colour-picker-backdrop" onClick={() => setOpen(false)} aria-label="Close colour picker" />
      <section className="colour-picker-dialog">
        <header><div><p className="eyebrow">Personalise</p><h3>Choose a colour</h3></div><button type="button" onClick={() => setOpen(false)} aria-label="Close"><X size={17} /></button></header>
        <ColourEditor value={value} onApply={(next) => { onChange(next); setOpen(false) }} />
      </section>
    </div>, document.body)}
  </>
}

function KeptLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Kept home">
      <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
      {!compact && <span className="brand-name">kept</span>}
    </div>
  )
}

function relativeDate(value: string) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(new Date(value))
}

function compactDate(value: string) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value))
}

function fullDate(value: string) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value))
}

function dateSourceLabel(source?: MemoryItem['capturedAtSource']) {
  if (source === 'exif') return 'From photo metadata'
  if (source === 'apple_photos') return 'From Apple Photos'
  if (source === 'manual') return 'Added manually'
  return 'Original photo date'
}

function kindLabel(kind: ItemKind) {
  return kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : kind === 'link' ? 'Link' : 'Note'
}

function friendlyOwnerName(label?: string) {
  if (!label || label === 'Shared library') return 'Shared library'
  const raw = label.includes('@') ? label.split('@')[0] : label
  const words = raw.replace(/[._-]+/g, ' ').trim()
  return words ? words.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Shared library'
}

function sharedPermissionLabel(permissions: SharedSpace['permissions']) {
  if (permissions.canAdd && permissions.canEdit && permissions.canDelete) return 'Full access'
  if (permissions.canAdd && permissions.canEdit) return 'Can add & edit'
  if (permissions.canAdd) return 'Can add'
  if (permissions.canEdit) return 'Can edit'
  return 'View only'
}

function locationSourceLabel(source: NonNullable<MemoryItem['location']>['source']) {
  if (source === 'exif') return 'From photo metadata'
  if (source === 'page') return 'From page metadata'
  if (source === 'manual') return 'Added manually'
  return 'Recognised from content'
}

function LibraryPreloader() {
  return <div className="library-preloader" role="status" aria-live="polite" aria-label="Opening your Kept library">
    <div className="preloader-stage" aria-hidden="true">
      <i className="preloader-memory memory-one" /><i className="preloader-memory memory-two" /><i className="preloader-memory memory-three" />
      <div className="preloader-mark"><span /><span /><span /><Sparkles size={16} /></div>
    </div>
    <p className="eyebrow">Your visual memory</p>
    <strong>Gathering what you’ve kept…</strong>
    <div className="preloader-progress" aria-hidden="true"><i /></div>
  </div>
}

function Sidebar({
  items,
  view,
  activeSpace,
  activeSpaceOwnerId,
  onNavigate,
  onCapture,
  onAssistant,
  onMobileCapture,
  onShareLibrary,
  spaces,
  sharedSpaces,
  currentUserId,
  onManageSpaces,
  mobileOpen,
  onMobileClose,
  email,
  onSignOut,
}: {
  items: MemoryItem[]
  view: View
  activeSpace: string
  activeSpaceOwnerId: string
  onNavigate: (view: View, space?: string, ownerId?: string) => void
  onCapture: () => void
  onAssistant: () => void
  onMobileCapture: () => void
  onShareLibrary: () => void
  spaces: LibrarySpace[]
  sharedSpaces: SharedSpace[]
  currentUserId: string
  onManageSpaces: () => void
  mobileOpen: boolean
  onMobileClose: () => void
  email: string
  onSignOut: () => void
}) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [expandedSharedOwners, setExpandedSharedOwners] = useState<Set<string>>(new Set())
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const nav = (next: View, space?: string, ownerId?: string) => {
    onNavigate(next, space, ownerId)
    onMobileClose()
  }
  const ownedSpaces = spaces.filter((space) => space.ownerId === currentUserId)
  const sharedGroups = useMemo(() => {
    const groups = new Map<string, SharedSpace[]>()
    for (const shared of sharedSpaces) groups.set(shared.ownerUserId, [...(groups.get(shared.ownerUserId) ?? []), shared])
    return [...groups].map(([ownerUserId, ownerSpaces]) => ({
      ownerUserId,
      ownerLabel: ownerSpaces.find((space) => space.ownerLabel)?.ownerLabel,
      spaces: ownerSpaces,
      wholeLibrary: ownerSpaces.some((space) => space.library),
      permissions: ownerSpaces[0].permissions,
    }))
  }, [sharedSpaces])
  const capture = () => {
    onMobileClose()
    onCapture()
  }
  useEffect(() => {
    if (!accountMenuOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountMenuOpen])
  useEffect(() => {
    setExpandedSharedOwners((current) => {
      const next = new Set(current)
      for (const group of sharedGroups) if (!current.size || group.ownerUserId === activeSpaceOwnerId) next.add(group.ownerUserId)
      return next
    })
  }, [sharedGroups, activeSpaceOwnerId])
  return (
    <>
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-top">
          <KeptLogo />
          <button className="icon-button sidebar-close" onClick={onMobileClose} aria-label="Close navigation"><X size={19} /></button>
        </div>

        <button className="capture-button" onClick={capture}>
          <span><Plus size={17} strokeWidth={2.2} /> Capture</span>
          <kbd>C</kbd>
        </button>

        <button className="assistant-nav-button" onClick={() => { onMobileClose(); onAssistant() }}>
          <span><Sparkles size={16} /> Ask Kept</span><em>AI</em>
        </button>

        <button className="phone-capture-button" onClick={() => { onMobileClose(); onMobileCapture() }}>
          <span><Share2 size={15} /> Add from phone</span><ArrowUpRight size={13} />
        </button>

        <nav aria-label="Library navigation">
          <p className="nav-label">Library</p>
          <button className={`nav-row ${view === 'all' ? 'active' : ''}`} onClick={() => nav('all')}>
            <span><Grid2X2 size={16} /> All items</span><em>{items.length}</em>
          </button>
          <button className={`nav-row ${view === 'recent' ? 'active' : ''}`} onClick={() => nav('recent')}>
            <span><Clock3 size={16} /> Recent</span>
          </button>
          <button className={`nav-row ${view === 'favourites' ? 'active' : ''}`} onClick={() => nav('favourites')}>
            <span><Star size={16} /> Favourites</span><em>{items.filter((item) => item.favourite).length}</em>
          </button>

          <div className="spaces-header">
            <p className="nav-label">Your spaces</p>
            <button onClick={onManageSpaces} aria-label="Manage spaces" title="Manage spaces"><Plus size={14} /></button>
          </div>
          {ownedSpaces.map((space) => (
            <button
              key={space.name}
              className={`nav-row space-row ${view === 'space' && activeSpace === space.name && activeSpaceOwnerId === currentUserId ? 'active' : ''}`}
              onClick={() => nav('space', space.name, currentUserId)}
            >
              <span><i style={{ background: space.color }} />{space.name}</span>
              <em>{items.filter((item) => item.space === space.name && item.ownerId === currentUserId).length}</em>
            </button>
          ))}
          {sharedGroups.length > 0 && <div className="shared-libraries">
            <div className="shared-spaces-header"><p className="nav-label">Shared with you</p><Users size={12} /></div>
            {sharedGroups.map((group) => {
              const expanded = expandedSharedOwners.has(group.ownerUserId)
              const ownerName = friendlyOwnerName(group.ownerLabel)
              const active = activeSpaceOwnerId === group.ownerUserId && view === 'space'
              return <section className={`shared-owner-group ${active ? 'active' : ''}`} key={group.ownerUserId}>
                <button className="shared-owner-header" onClick={() => setExpandedSharedOwners((current) => { const next = new Set(current); if (next.has(group.ownerUserId)) next.delete(group.ownerUserId); else next.add(group.ownerUserId); return next })} aria-expanded={expanded}>
                  <span className="shared-owner-avatar">{ownerName.slice(0, 2).toUpperCase()}</span>
                  <span className="shared-owner-copy"><strong>{group.wholeLibrary ? `${ownerName}’s library` : ownerName}</strong><small>{group.spaces.length} {group.spaces.length === 1 ? 'space' : 'spaces'} · {sharedPermissionLabel(group.permissions)}</small></span>
                  <ChevronDown size={13} />
                </button>
                {expanded && <div className="shared-owner-spaces">
                  {group.spaces.map((shared) => {
                    const space = spaces.find((entry) => entry.ownerId === shared.ownerUserId && entry.name === shared.name)
                    return <button key={`${shared.ownerUserId}:${shared.name}`} className={`nav-row space-row shared-space-row ${view === 'space' && activeSpace === shared.name && activeSpaceOwnerId === shared.ownerUserId ? 'active' : ''}`} onClick={() => nav('space', shared.name, shared.ownerUserId)}>
                      <span><i style={{ background: space?.color ?? '#b7b8ae' }} />{shared.name}</span><em>{items.filter((item) => item.space === shared.name && item.ownerId === shared.ownerUserId).length}</em>
                    </button>
                  })}
                </div>}
              </section>
            })}
          </div>}
        </nav>

        <div className="sidebar-bottom" ref={accountMenuRef}>
          {accountMenuOpen && <div className="account-menu" role="menu">
            <button role="menuitem" onClick={() => { setAccountMenuOpen(false); onMobileClose(); onShareLibrary() }}>
              <Share2 size={15} /><span><strong>Share personal library</strong><small>All current and future spaces</small></span>
            </button>
            <button role="menuitem" onClick={() => { setAccountMenuOpen(false); onSignOut() }}>
              <LogOut size={15} /><span><strong>Sign out</strong><small>{email}</small></span>
            </button>
          </div>}
          <button
            className="account-row"
            onClick={() => setAccountMenuOpen((open) => !open)}
            aria-label="Open personal space menu"
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
          >
            <div className="avatar">{email.slice(0, 2).toUpperCase()}</div>
            <div><strong>Personal space</strong><span>{email}</span></div>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>
      {mobileOpen && <button className="sidebar-scrim" onClick={onMobileClose} aria-label="Close navigation overlay" />}
    </>
  )
}

function SearchBar({ value, colour, onChange, onColourChange, inputRef }: { value: string; colour: string; onChange: (value: string) => void; onColourChange: (value: string) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [colourOpen, setColourOpen] = useState(false)
  const colourWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!colourOpen) return
    const closeOutside = (event: PointerEvent) => { if (!colourWrapRef.current?.contains(event.target as Node)) setColourOpen(false) }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setColourOpen(false) }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [colourOpen])
  return (
    <div className={`search-shell ${value || colour ? 'has-value' : ''}`}>
      <Search size={21} strokeWidth={1.8} aria-hidden="true" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search by meaning, mood, colour, anything…"
        aria-label="Search your saved items"
      />
      <div className="colour-search-wrap" ref={colourWrapRef}>
        <button type="button" className={`colour-search-button ${colour ? 'selected' : ''}`} onClick={() => setColourOpen((open) => !open)} aria-label="Search by colour" aria-expanded={colourOpen} aria-controls="colour-search-popover" title="Search by colour">
          {colour ? <i style={{ background: colour }} /> : <Palette size={16} />}
        </button>
        {colourOpen && <div className="colour-search-popover" id="colour-search-popover" role="dialog" aria-label="Search by colour">
          <div className="colour-search-head"><span><Palette size={15} /></span><div><strong>Search by colour</strong><small>Find the closest visual palettes, not just exact matches.</small></div></div>
          <ColourEditor value={colour || '#839276'} onApply={(next) => { onColourChange(next); setColourOpen(false) }} onClear={colour ? () => { onColourChange(''); setColourOpen(false) } : undefined} />
        </div>}
      </div>
      {value || colour ? <button onClick={() => { onChange(''); onColourChange('') }} aria-label="Clear search"><X size={17} /></button> : <div className="search-hint"><Sparkles size={13} /> semantic <kbd>/</kbd></div>}
    </div>
  )
}

function DateFilterBar({ preset, field, customFrom, customTo, onPreset, onField, onCustomFrom, onCustomTo, onClear }: {
  preset: DatePreset
  field: DateField
  customFrom: string
  customTo: string
  onPreset: (value: DatePreset) => void
  onField: (value: DateField) => void
  onCustomFrom: (value: string) => void
  onCustomTo: (value: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false) }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape) }
  }, [open])
  const quick: Array<[DatePreset, string]> = [['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'], ['thisMonth', 'This month']]
  return <div className="date-filter-bar" ref={wrapRef}>
    <span className="date-filter-label"><CalendarDays size={14} /> When</span>
    <div className="date-filter-pills">
      {quick.map(([value, label]) => <button type="button" key={value} className={preset === value ? 'active' : ''} onClick={() => onPreset(preset === value ? 'any' : value)}>{label}</button>)}
    </div>
    <button type="button" className={`precise-filter-button ${preset !== 'any' || field !== 'relevant' ? 'active' : ''}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}><SlidersHorizontal size={14} /> Filters{preset !== 'any' || field !== 'relevant' ? <i /> : null}</button>
    {open && <section className="date-filter-popover" aria-label="Precise date filters">
      <header><div><p className="eyebrow">Precise filters</p><strong>Choose which date matters</strong></div><button type="button" onClick={() => setOpen(false)} aria-label="Close filters"><X size={16} /></button></header>
      <label className="filter-label">Date meaning</label>
      <div className="date-field-options">
        {([['relevant', 'Best date', 'Captured date; otherwise kept'], ['captured', 'Originally captured', 'Only photos and videos with a source date'], ['kept', 'Date kept', 'When it entered your library']] as const).map(([value, title, note]) => <button type="button" key={value} className={field === value ? 'active' : ''} onClick={() => onField(value)}><span>{title}</span><small>{note}</small>{field === value && <Check size={13} />}</button>)}
      </div>
      <label className="filter-label">Custom range</label>
      <div className="date-custom-range"><label><span>From</span><input type="date" value={customFrom} onChange={(event) => { onCustomFrom(event.target.value); onPreset('custom') }} /></label><label><span>To</span><input type="date" min={customFrom} value={customTo} onChange={(event) => { onCustomTo(event.target.value); onPreset('custom') }} /></label></div>
      <footer><button type="button" onClick={onClear}>Clear dates</button><button type="button" onClick={() => setOpen(false)}>Done</button></footer>
    </section>}
  </div>
}

function LinkArtwork({ item }: { item: MemoryItem }) {
  const [first = '#dedbd2', second = '#71756a', third = '#d6ef65'] = item.palette
  return (
    <div className="link-art link-fallback" style={{ background: `linear-gradient(145deg, ${first}, ${second})` }}>
      <span className="fallback-orb" style={{ background: third }} />
      <Link2 size={22} />
      <p>{item.title}</p>
      <small>{item.domain ?? 'Saved link'}</small>
    </div>
  )
}

function isLikelyBrandPreview(value?: string) {
  if (!value) return false
  try {
    const resolved = new URL(value)
    const path = `${resolved.pathname} ${resolved.search}`.toLowerCase()
    return /(?:^|[\/_\-.])(logo|favicon|icon|wordmark|brandmark|logomark|sprite|badge|avatar|placeholder|colou?rswatch|swatch|play-button)(?:[\/_\-.]|$)/.test(path)
      || /[?&](?:width|w)=([1-9]\d?|1\d\d)(?:&|$)/.test(resolved.search.toLowerCase())
  } catch {
    return false
  }
}

function LinkVisual({ item, detail = false, onImageFailed }: { item: MemoryItem; detail?: boolean; onImageFailed?: () => void }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [item.image])
  if (!item.image || failed) return <LinkArtwork item={item} />
  const rejectPreview = () => { setFailed(true); onImageFailed?.() }
  return <img className="link-preview-image" src={item.image} alt={detail ? item.title : ''} referrerPolicy="no-referrer" loading={detail ? 'eager' : 'lazy'} decoding="async" onLoad={(event) => {
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth < 480 || naturalHeight < 280 || naturalWidth / Math.max(naturalHeight, 1) > 3.2) rejectPreview()
  }} onError={rejectPreview} />
}

function VideoCardPreview({ item }: { item: MemoryItem }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !item.video || failed) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (reducedMotion.matches) {
      video.pause()
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void video.play().catch(() => undefined)
      else video.pause()
    }, { threshold: 0.15, rootMargin: '180px 0px' })
    observer.observe(video)
    return () => {
      observer.disconnect()
      video.pause()
    }
  }, [failed, item.video])

  if (!item.video || failed) return item.image ? <img src={item.image} alt="" loading="lazy" decoding="async" /> : null
  return <video ref={videoRef} src={item.video} poster={item.image} muted loop playsInline preload="metadata" aria-hidden="true" tabIndex={-1} onError={() => setFailed(true)} />
}

function MemoryCard({ item, relevance, canEdit, removing, onOpen, onChat, onFavourite, onPreviewFailed }: { item: MemoryItem; relevance?: number; canEdit: boolean; removing?: boolean; onOpen: () => void; onChat: () => void; onFavourite: () => void; onPreviewFailed: () => void }) {
  return (
    <article className={`memory-card kind-${item.kind} ${relevance !== undefined ? 'has-relevance' : ''} ${removing ? 'is-removing' : ''}`}>
      <div className="card-visual">
        <button className="card-visual-open" onClick={onOpen} aria-label={`Open ${item.title}`} />
          {item.kind === 'image' && item.image && <img src={item.image} alt="" loading="lazy" decoding="async" />}
          {item.kind === 'video' && <VideoCardPreview item={item} />}
          {item.kind === 'link' && <LinkVisual item={item} onImageFailed={onPreviewFailed} />}
          {item.kind === 'note' && (
            <div className="note-art">
              <FileText size={18} />
              <p>“{item.description}”</p>
              <span>NOTE TO SELF</span>
            </div>
          )}
          <span className="kind-pill">{item.kind === 'image' ? <ImageIcon size={12} /> : item.kind === 'video' ? <Video size={12} /> : item.kind === 'link' ? <Link2 size={12} /> : <FileText size={12} />}{kindLabel(item.kind)}</span>
          {item.kind === 'video' && !item.video && <span className="video-play-pill"><span><Video size={15} /></span></span>}
          {(item.kind === 'image' || item.kind === 'video') && item.capturedAt && <span className="capture-date-pill"><CalendarDays size={11} /> {compactDate(item.capturedAt)}</span>}
          <div className="card-actions"><button className="card-chat-action" onClick={onChat} aria-label={`Chat about ${item.title}`} title="Chat about this"><Sparkles size={16} /></button><button className="card-action" onClick={onOpen} aria-label={`Open ${item.title}`}><ArrowUpRight size={17} /></button></div>
      </div>
      <button className="card-copy-open" onClick={onOpen} aria-label={`Open details for ${item.title}`}>
        <div className="card-copy">
          <h3>{item.title}</h3>
          <div className="card-meta"><p>{item.space} <span>·</span> {item.capturedAt ? `Taken ${compactDate(item.capturedAt)}` : relativeDate(item.createdAt)}</p>{relevance !== undefined && <span className="relevance-score">{relevance}% match</span>}</div>
        </div>
      </button>
      <button className={`favourite-button ${item.favourite ? 'selected' : ''}`} onClick={onFavourite} disabled={!canEdit} title={!canEdit ? 'View-only shared item' : undefined} aria-label={item.favourite ? `Remove ${item.title} from favourites` : `Add ${item.title} to favourites`}>
        <Heart size={15} fill={item.favourite ? 'currentColor' : 'none'} />
      </button>
    </article>
  )
}

function videoMimeType(file: File) {
  if (['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type)) return file.type
  if (/\.mov$/i.test(file.name)) return 'video/quicktime'
  if (/\.webm$/i.test(file.name)) return 'video/webm'
  return 'video/mp4'
}

async function sha256File(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function posterFromVideo(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = url
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('This video could not be previewed in your browser.'))
    })
    if (Number.isFinite(video.duration) && video.duration > 0.4) {
      video.currentTime = Math.min(1, video.duration * .12)
      await new Promise<void>((resolve) => { video.onseeked = () => resolve(); window.setTimeout(resolve, 1_500) })
    }
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale))
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('A poster could not be created.')), 'image/jpeg', .86))
  } finally {
    URL.revokeObjectURL(url)
  }
}

function CaptureModal({ open, currentUserId, targetSpace, initialValue = '', initialTab = 'link', onClose, onCaptured }: { open: boolean; currentUserId: string; targetSpace?: { ownerId: string; name: string }; initialValue?: string; initialTab?: CaptureTab; onClose: () => void; onCaptured: (item: MemoryItem) => void }) {
  const [tab, setTab] = useState<CaptureTab>(initialTab)
  const [value, setValue] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open || !initialValue) return
    setValue(initialValue)
    setTab(initialTab)
  }, [open, initialValue, initialTab])

  useEffect(() => {
    if (open && tab !== 'upload') window.setTimeout(() => tab === 'note' ? noteRef.current?.focus() : inputRef.current?.focus(), 80)
  }, [open, tab])

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const chooseFile = (next: File | null) => {
    if (!next) return
    if (!next.type.startsWith('image/') && !next.type.startsWith('video/') && !/\.(mp4|mov|webm)$/i.test(next.name)) { setError('Please choose an image or video file.'); return }
    if (next.type.startsWith('video/') && next.size > 200 * 1024 * 1024) { setError('Videos can be up to 200 MB.'); return }
    if (preview) URL.revokeObjectURL(preview)
    setFile(next)
    setPreview(URL.createObjectURL(next))
    setError('')
  }

  const resetAndClose = () => {
    if (loading) return
    setValue(''); setFile(null); setPreview(''); setError(''); setTab('link'); onClose()
  }

  const submit = async () => {
    if ((tab !== 'upload' && !value.trim()) || (tab === 'upload' && !file)) {
      setError(tab === 'upload' ? 'Drop or choose an image or video first.' : tab === 'link' ? 'Paste a link to continue.' : 'Write a note to continue.')
      return
    }
    setLoading(true); setError('')
    const started = Date.now()
    try {
      let response: Response
      if (tab === 'upload') {
        const isVideo = file!.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file!.name)
        if (isVideo) {
          const ownerId = targetSpace?.ownerId ?? currentUserId
          const mimeType = videoMimeType(file!)
          const extension = mimeType === 'video/quicktime' ? 'mov' : mimeType === 'video/webm' ? 'webm' : 'mp4'
          const videoStoragePath = `${ownerId}/${crypto.randomUUID()}.${extension}`
          const [poster, fingerprint] = await Promise.all([posterFromVideo(file!), sha256File(file!)])
          const { error: uploadError } = await supabase.storage.from('kept-images').upload(videoStoragePath, file!, { contentType: mimeType, cacheControl: '31536000', upsert: false })
          if (uploadError) throw new Error(`The video upload failed: ${uploadError.message}`)
          const body = new FormData()
          body.append('poster', poster, `${file!.name.replace(/\.[^.]+$/, '')}-poster.jpg`)
          body.append('videoStoragePath', videoStoragePath)
          body.append('videoMimeType', mimeType)
          body.append('contentFingerprint', fingerprint)
          body.append('filename', file!.name)
          body.append('hint', value)
          if (targetSpace) { body.append('ownerUserId', targetSpace.ownerId); body.append('spaceName', targetSpace.name) }
          response = await apiFetch('/api/upload-video', { method: 'POST', body })
          if (!response.ok) await supabase.storage.from('kept-images').remove([videoStoragePath])
        } else {
          const body = new FormData(); body.append('image', file!); body.append('hint', value)
          if (targetSpace) { body.append('ownerUserId', targetSpace.ownerId); body.append('spaceName', targetSpace.name) }
          response = await apiFetch('/api/upload', { method: 'POST', body })
        }
      } else {
        response = await apiFetch('/api/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: tab, value, ownerUserId: targetSpace?.ownerId, spaceName: targetSpace?.name }) })
      }
      if (!response.ok) throw new Error('We couldn’t save that just now.')
      const item = await response.json() as MemoryItem
      const remaining = Math.max(0, 1200 - (Date.now() - started))
      await new Promise((resolve) => window.setTimeout(resolve, remaining))
      onCaptured(item)
      setLoading(false); setValue(''); setFile(null); setPreview(''); setTab('link'); onClose()
    } catch (nextError) {
      setLoading(false); setError(nextError instanceof Error ? nextError.message : 'Something went wrong.')
    }
  }

  if (!open) return null
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="capture-title">
      <button className="modal-backdrop" onClick={resetAndClose} aria-label="Close capture dialog" />
      <section className="capture-modal">
        {loading ? (
          <div className="analysis-state">
            <div className="analysis-orbit"><Sparkles size={23} /><span /></div>
            <p className="eyebrow">Kept is looking</p>
            <h2>Understanding what you saved…</h2>
            <ul><li className="done"><Check size={13} /> Captured safely</li><li className="active"><LoaderCircle size={13} /> Reading the context</li><li>Finding the right space</li></ul>
          </div>
        ) : (
          <>
            <div className="modal-head">
              <div><p className="eyebrow">New memory</p><h2 id="capture-title">Keep something</h2></div>
              <button className="icon-button" onClick={resetAndClose} aria-label="Close"><X size={19} /></button>
            </div>
            <div className="capture-tabs" role="tablist" aria-label="Capture type">
              <button role="tab" aria-selected={tab === 'link'} className={tab === 'link' ? 'active' : ''} onClick={() => setTab('link')}><Link2 size={15} /> Paste link</button>
              <button role="tab" aria-selected={tab === 'upload'} className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}><Upload size={15} /> Upload</button>
              <button role="tab" aria-selected={tab === 'note'} className={tab === 'note' ? 'active' : ''} onClick={() => setTab('note')}><FileText size={15} /> Note</button>
            </div>

            <div className="capture-body">
              {targetSpace && <div className="capture-target"><Share2 size={14} /><span>Adding to shared space</span><strong>{targetSpace.name}</strong></div>}
              {tab === 'link' && (
                <label className="field-label">Link
                  <div className="url-field"><Link2 size={17} /><input ref={inputRef} type="url" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Paste any URL…" onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} /></div>
                </label>
              )}
              {tab === 'upload' && !preview && (
                <button className="dropzone" onClick={() => document.getElementById('capture-file')?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files[0]) }}>
                  <span><Upload size={23} /></span><strong>Drop an image or video here</strong><p>PNG, JPG, WEBP · MP4, MOV, WEBM</p>
                  <input id="capture-file" type="file" accept="image/*,video/mp4,video/quicktime,video/webm,.mov" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
                </button>
              )}
              {tab === 'upload' && preview && (
                <div className="upload-preview">
                  {file?.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file?.name ?? '') ? <video src={preview} muted controls playsInline /> : <img src={preview} alt="Upload preview" />}
                  <button className="icon-button" onClick={() => { setPreview(''); setFile(null) }} aria-label="Remove file"><X size={17} /></button>
                  <label>Anything to add? <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Optional context…" /></label>
                </div>
              )}
              {tab === 'note' && (
                <label className="field-label">Thought
                  <textarea ref={noteRef} value={value} onChange={(event) => setValue(event.target.value)} placeholder="Write anything worth remembering…" rows={6} />
                </label>
              )}
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="ai-note"><Sparkles size={15} /><p><strong>You only need to drop it.</strong><br />Kept names, describes and files it automatically.</p></div>
            </div>
            <div className="modal-footer">
              <p><Command size={13} /> Enter to save</p>
              <button className="primary-button" onClick={() => void submit()}>Keep it <ArrowUpRight size={16} /></button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function SpaceManager({
  open,
  spaces,
  items,
  onClose,
  onSpacesChange,
  onRename,
  onDelete,
  onShare,
  onItemsAdded,
  autoMatchSpaceId,
  onAutoMatchHandled,
}: {
  open: boolean
  spaces: LibrarySpace[]
  items: MemoryItem[]
  onClose: () => void
  onSpacesChange: (spaces: LibrarySpace[]) => void
  onRename: (from: string, to: string) => void
  onDelete: (from: string, to: string) => void
  onShare: (space: LibrarySpace) => void
  onItemsAdded: (items: MemoryItem[], space: LibrarySpace) => void
  autoMatchSpaceId?: string
  onAutoMatchHandled: () => void
}) {
  const [drafts, setDrafts] = useState<Record<string, { name: string; color: string; description: string }>>({})
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#d6ef65')
  const [newDescription, setNewDescription] = useState('')
  const [busy, setBusy] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [matchingSpace, setMatchingSpace] = useState<LibrarySpace | null>(null)
  const [matches, setMatches] = useState<SpaceMatch[]>([])
  const [selectedMatches, setSelectedMatches] = useState<Set<string>>(new Set())
  const [matchingBusy, setMatchingBusy] = useState(false)
  const [matchError, setMatchError] = useState('')
  const [selectedSpaceId, setSelectedSpaceId] = useState('')
  const [creatingSpace, setCreatingSpace] = useState(false)

  useEffect(() => {
    if (open) {
      setDrafts(Object.fromEntries(spaces.map((space) => [space.id, { name: space.name, color: space.color, description: space.description }])))
      setSelectedSpaceId((current) => spaces.some((space) => space.id === current) ? current : (spaces[0]?.id ?? ''))
    }
    else setMatchingSpace(null)
  }, [open, spaces])

  const create = async () => {
    if (!newName.trim() || busy) return
    setBusy('new'); setError('')
    try {
      const response = await apiFetch('/api/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName, color: newColor, description: newDescription }) })
      const data = await response.json() as LibrarySpace & { error?: string }
      if (!response.ok) throw new Error(data.error || 'That space could not be created.')
      onSpacesChange([...spaces, data]); setNewName(''); setNewColor('#d6ef65'); setNewDescription(''); setSelectedSpaceId(data.id); setCreatingSpace(false)
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : 'That space could not be created.') }
    finally { setBusy('') }
  }

  const save = async (space: LibrarySpace) => {
    const draft = drafts[space.id]
    if (!draft || busy) return undefined
    setBusy(space.id); setError('')
    try {
      const response = await apiFetch(`/api/spaces/${space.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })
      const data = await response.json() as LibrarySpace & { error?: string }
      if (!response.ok) throw new Error(data.error || 'That space could not be updated.')
      onSpacesChange(spaces.map((entry) => entry.id === data.id ? data : entry))
      if (space.name !== data.name) onRename(space.name, data.name)
      return data
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : 'That space could not be updated.'); return undefined }
    finally { setBusy('') }
  }

  const findMatches = async (space: LibrarySpace) => {
    if (busy || matchingBusy) return
    const draft = drafts[space.id] ?? { name: space.name, color: space.color, description: space.description }
    const changed = draft.name.trim() !== space.name || draft.color !== space.color || draft.description.trim() !== space.description
    const target = changed ? await save(space) : space
    if (!target) return
    setMatchingSpace(target); setMatches([]); setSelectedMatches(new Set()); setMatchError(''); setMatchingBusy(true)
    try {
      const response = await apiFetch(`/api/spaces/${target.id}/matches`)
      const data = await response.json() as { matches?: SpaceMatch[]; error?: string }
      if (!response.ok || !Array.isArray(data.matches)) throw new Error(data.error || 'Matching items are temporarily unavailable.')
      setMatches(data.matches)
      setSelectedMatches(new Set(data.matches.map(({ item }) => item.id)))
    } catch (nextError) { setMatchError(nextError instanceof Error ? nextError.message : 'Matching items are temporarily unavailable.') }
    finally { setMatchingBusy(false) }
  }

  useEffect(() => {
    if (!open || !autoMatchSpaceId) return
    const space = spaces.find((entry) => entry.id === autoMatchSpaceId)
    onAutoMatchHandled()
    if (space) void findMatches(space)
  }, [open, autoMatchSpaceId])

  const addMatches = async () => {
    if (!matchingSpace || !selectedMatches.size || matchingBusy) return
    setMatchingBusy(true); setMatchError('')
    try {
      const response = await apiFetch(`/api/spaces/${matchingSpace.id}/matches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemIds: [...selectedMatches] }) })
      const data = await response.json() as { items?: MemoryItem[]; error?: string }
      if (!response.ok || !Array.isArray(data.items)) throw new Error(data.error || 'Those items could not be added.')
      onItemsAdded(data.items, matchingSpace)
      setMatchingSpace(null); setMatches([]); setSelectedMatches(new Set())
    } catch (nextError) { setMatchError(nextError instanceof Error ? nextError.message : 'Those items could not be added.') }
    finally { setMatchingBusy(false) }
  }

  const reorder = async (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= spaces.length || busy) return
    const reordered = [...spaces]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    onSpacesChange(reordered); setBusy('order'); setError('')
    try {
      const response = await apiFetch('/api/spaces/reorder', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: reordered.map(({ id }) => id) }) })
      const data = await response.json() as LibrarySpace[] | { error?: string }
      if (!response.ok || !Array.isArray(data)) throw new Error(!Array.isArray(data) && data.error ? data.error : 'Spaces could not be reordered.')
      onSpacesChange(data)
    } catch (nextError) { onSpacesChange(spaces); setError(nextError instanceof Error ? nextError.message : 'Spaces could not be reordered.') }
    finally { setBusy('') }
  }

  const remove = async (space: LibrarySpace) => {
    if (busy) return
    const target = spaces.find((entry) => entry.name === 'Inbox' && entry.id !== space.id) ?? spaces.find((entry) => entry.id !== space.id)
    if (!target) return
    setBusy(space.id); setError('')
    try {
      const response = await apiFetch(`/api/spaces/${space.id}?moveTo=${target.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = await response.json() as { error?: string }
        throw new Error(data.error || 'That space could not be deleted.')
      }
      onSpacesChange(spaces.filter((entry) => entry.id !== space.id)); onDelete(space.name, target.name); setDeleting(null); setSelectedSpaceId(target.id)
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : 'That space could not be deleted.') }
    finally { setBusy('') }
  }

  if (!open) return null
  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId) ?? spaces[0]
  const selectedDraft = selectedSpace ? (drafts[selectedSpace.id] ?? { name: selectedSpace.name, color: selectedSpace.color, description: selectedSpace.description }) : undefined
  const selectedCount = selectedSpace ? items.filter((item) => item.ownerId === selectedSpace.ownerId && item.space === selectedSpace.name).length : 0
  const selectedChanged = Boolean(selectedSpace && selectedDraft && (selectedDraft.name.trim() !== selectedSpace.name || selectedDraft.color !== selectedSpace.color || selectedDraft.description.trim() !== selectedSpace.description))
  return <>
    <div className="modal-layer space-manager-layer" role="dialog" aria-modal="true" aria-labelledby="space-manager-title">
      <button className="modal-backdrop" onClick={onClose} aria-label="Close space manager" />
      <section className="space-manager">
      <header><div><p className="eyebrow">Your library</p><h2 id="space-manager-title">Spaces</h2><span>Give everything a natural place to return to.</span></div><div className="space-manager-header-actions"><button className="space-new-button" onClick={() => { setCreatingSpace(true); setDeleting(null) }}><Plus size={14} /> New space</button><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div></header>
      <div className="space-manager-body">
        <aside className="space-directory" aria-label="Your spaces">
          <div className="space-directory-heading"><span>{spaces.length} {spaces.length === 1 ? 'space' : 'spaces'}</span><small>Drag-free ordering</small></div>
          <div className="space-directory-list">
            {spaces.map((space, index) => {
              const count = items.filter((item) => item.ownerId === space.ownerId && item.space === space.name).length
              return <div className={`space-directory-row ${!creatingSpace && selectedSpace?.id === space.id ? 'selected' : ''}`} key={space.id}>
                <button className="space-directory-select" onClick={() => { setSelectedSpaceId(space.id); setCreatingSpace(false); setDeleting(null) }}>
                  <i style={{ background: space.color }} /><span><strong>{space.name}</strong><small>{count} {count === 1 ? 'item' : 'items'}</small></span>
                </button>
                <div className="space-order-buttons"><button onClick={() => void reorder(index, -1)} disabled={index === 0 || Boolean(busy)} aria-label={`Move ${space.name} up`}><ArrowUp size={12} /></button><button onClick={() => void reorder(index, 1)} disabled={index === spaces.length - 1 || Boolean(busy)} aria-label={`Move ${space.name} down`}><ArrowDown size={12} /></button></div>
              </div>
            })}
          </div>
        </aside>

        <div className="space-editor">
          {error && <p className="space-manager-error" role="alert">{error}</p>}
          {creatingSpace ? <div className="space-editor-content">
            <div className="space-editor-title"><span className="space-editor-mark" style={{ background: newColor }}><Plus size={17} /></span><div><p className="eyebrow">New space</p><h3>Create a home for related items</h3></div></div>
            <div className="space-form-section">
              <label><span>Name</span><div className="space-name-field"><ColourDialogButton value={newColor} onChange={setNewColor} label="Choose a colour for the new space" /><input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="e.g. Recipes to try" maxLength={80} onKeyDown={(event) => { if (event.key === 'Enter') void create() }} /></div></label>
              <label><span>What belongs here? <small>Optional, but helps Kept file things well.</small></span><textarea value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Describe this space in a sentence…" maxLength={500} rows={4} /></label>
            </div>
            <div className="space-editor-submit"><button className="quiet-button" onClick={() => setCreatingSpace(false)}>Cancel</button><button className="primary-button" onClick={() => void create()} disabled={!newName.trim() || Boolean(busy)}>{busy === 'new' ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Create space</button></div>
          </div> : selectedSpace && selectedDraft ? <div className="space-editor-content">
            <div className="space-editor-title"><span className="space-editor-mark" style={{ background: selectedDraft.color }}><Folder size={17} /></span><div><p className="eyebrow">Space details</p><h3>{selectedSpace.name}</h3><small>{selectedCount} {selectedCount === 1 ? 'item' : 'items'}</small></div></div>
            <div className="space-form-section">
              <label><span>Name and colour</span><div className="space-name-field"><ColourDialogButton value={selectedDraft.color} onChange={(color) => setDrafts((all) => ({ ...all, [selectedSpace.id]: { ...selectedDraft, color } }))} label={`${selectedSpace.name} colour`} /><input value={selectedDraft.name} onChange={(event) => setDrafts((all) => ({ ...all, [selectedSpace.id]: { ...selectedDraft, name: event.target.value } }))} maxLength={80} aria-label={`${selectedSpace.name} name`} /></div></label>
              <label><span>Purpose <small>Used for automatic filing and search.</small></span><textarea value={selectedDraft.description} onChange={(event) => setDrafts((all) => ({ ...all, [selectedSpace.id]: { ...selectedDraft, description: event.target.value } }))} placeholder="Describe what belongs in this space…" maxLength={500} rows={4} aria-label={`${selectedSpace.name} description`} /></label>
              {selectedChanged && <div className="space-editor-submit"><span>You have unsaved changes</span><button className="primary-button" onClick={() => void save(selectedSpace)} disabled={Boolean(busy)}>{busy === selectedSpace.id ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save changes</button></div>}
            </div>
            <div className="space-tools-section"><p className="space-section-label">Tools</p><div className="space-tool-grid">
              <button onClick={() => void findMatches(selectedSpace)} disabled={Boolean(busy) || matchingBusy}><span className="space-tool-icon"><Sparkles size={16} /></span><span><strong>Find matching items</strong><small>Use AI to find things that belong here.</small></span><ArrowUpRight size={14} /></button>
              <button onClick={() => onShare(selectedSpace)} disabled={Boolean(busy)}><span className="space-tool-icon"><Share2 size={16} /></span><span><strong>Share this space</strong><small>Invite someone and choose permissions.</small></span><ArrowUpRight size={14} /></button>
            </div></div>
            <div className="space-danger-section"><div><strong>Delete space</strong><span>{selectedSpace.name === 'Inbox' ? 'Inbox is permanent and cannot be deleted.' : `Items will be moved to Inbox.`}</span></div><button onClick={() => setDeleting(deleting === selectedSpace.id ? null : selectedSpace.id)} disabled={selectedSpace.name === 'Inbox' || Boolean(busy)}><Trash2 size={13} /> Delete</button></div>
            {deleting === selectedSpace.id && <div className="space-delete-confirm"><p><strong>Delete “{selectedSpace.name}”?</strong>{selectedCount ? ` Its ${selectedCount} ${selectedCount === 1 ? 'item' : 'items'} will move to Inbox.` : ' It is empty, so nothing else will move.'}</p><div><button onClick={() => setDeleting(null)}>Cancel</button><button onClick={() => void remove(selectedSpace)}>Delete space</button></div></div>}
          </div> : <div className="space-editor-empty"><Folder size={24} /><strong>Create your first space</strong><p>Spaces help Kept understand where your memories belong.</p><button className="primary-button" onClick={() => setCreatingSpace(true)}><Plus size={14} /> New space</button></div>}
        </div>
      </div>
      <footer><span><Check size={12} /> New captures can be filed into any space you create.</span><button onClick={onClose}>Done</button></footer>
      </section>
    </div>
    {matchingSpace && <div className="modal-layer space-match-layer" role="dialog" aria-modal="true" aria-labelledby="space-match-title">
      <button className="modal-backdrop" onClick={() => !matchingBusy && setMatchingSpace(null)} aria-label="Close matching items" />
      <section className="space-match-dialog">
        <header><div className="space-match-heading"><span style={{ background: matchingSpace.color }}><Sparkles size={15} /></span><div><p className="eyebrow">Smart filing</p><h2 id="space-match-title">Matches for {matchingSpace.name}</h2></div></div><button className="icon-button" onClick={() => setMatchingSpace(null)} disabled={matchingBusy} aria-label="Close"><X size={18} /></button></header>
        <div className="space-match-intro"><p>{matchingSpace.description || `Kept is using the name “${matchingSpace.name}” to understand what belongs here.`}</p><span>Adding an item moves it from its current space.</span></div>
        <div className="space-match-results">
          {matchingBusy && !matches.length ? <div className="space-match-loading"><LoaderCircle className="spin" size={20} /><strong>Looking across your library…</strong><span>Comparing meaning, tags and visual context</span></div> : matchError ? <div className="space-match-empty"><p>{matchError}</p><button onClick={() => void findMatches(matchingSpace)}>Try again</button></div> : matches.length ? matches.map(({ item, relevance }) => {
            const selected = selectedMatches.has(item.id)
            return <button type="button" key={item.id} className={`space-match-item ${selected ? 'selected' : ''}`} onClick={() => setSelectedMatches((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} aria-pressed={selected}>
              <span className="space-match-check">{selected && <Check size={12} />}</span>
              <span className="space-match-kind">{item.kind === 'image' ? <ImageIcon size={15} /> : item.kind === 'video' ? <Video size={15} /> : item.kind === 'link' ? <Link2 size={15} /> : <FileText size={15} />}</span>
              <span className="space-match-copy"><strong>{item.title}</strong><small>Currently in {item.space}</small></span>
              <span className="space-match-score">{relevance}%</span>
            </button>
          }) : <div className="space-match-empty"><Sparkles size={20} /><strong>No confident matches yet</strong><p>Add a more specific description, then try again.</p></div>}
        </div>
        <footer><button className="space-match-select" onClick={() => setSelectedMatches(selectedMatches.size === matches.length ? new Set() : new Set(matches.map(({ item }) => item.id)))} disabled={!matches.length || matchingBusy}>{selectedMatches.size === matches.length ? 'Clear all' : 'Select all'}</button><button className="primary-button" onClick={() => void addMatches()} disabled={!selectedMatches.size || matchingBusy}>{matchingBusy && matches.length ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />} Add {selectedMatches.size || ''} {selectedMatches.size === 1 ? 'item' : 'items'}</button></footer>
      </section>
    </div>}
  </>
}

function DetailPanel({ item, spaces, canEdit, canDelete, previewRefreshing, onClose, onChat, onFavourite, onMove, onDelete, onRefreshPreview, onPreviewFailed }: { item: MemoryItem | null; spaces: LibrarySpace[]; canEdit: boolean; canDelete: boolean; previewRefreshing: boolean; onClose: () => void; onChat: () => void; onFavourite: () => void; onMove: (space: string) => void; onDelete: () => void; onRefreshPreview: () => void; onPreviewFailed: () => void }) {
  const [spaceOpen, setSpaceOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  useEffect(() => {
    setSpaceOpen(false)
    setDeleteOpen(false)
  }, [item?.id])
  if (!item) return null
  const locationCoordinates = item.location?.latitude != null && item.location.longitude != null
    ? `${item.location.latitude.toFixed(5)}, ${item.location.longitude.toFixed(5)}`
    : ''
  const locationUrl = locationCoordinates
    ? `https://www.openstreetmap.org/?mlat=${item.location!.latitude}&mlon=${item.location!.longitude}#map=15/${item.location!.latitude}/${item.location!.longitude}`
    : ''
  return (
    <div className="detail-layer" role="dialog" aria-modal="true" aria-labelledby="detail-title">
      <button className="detail-backdrop" onClick={onClose} aria-label="Close item details" />
      <aside className="detail-panel">
        <div className="detail-toolbar">
          <button className="back-button" onClick={onClose}><ArrowLeft size={17} /> Back</button>
          <div><button className="icon-button detail-chat-trigger" onClick={onChat} aria-label={`Chat about ${item.title}`} title="Chat about this"><Sparkles size={17} /></button><button className={`icon-button ${item.favourite ? 'selected' : ''}`} onClick={onFavourite} disabled={!canEdit} aria-label="Toggle favourite" title={!canEdit ? 'View-only shared item' : undefined}><Heart size={17} fill={item.favourite ? 'currentColor' : 'none'} /></button>{canDelete ? <button className="icon-button detail-delete-trigger" onClick={() => setDeleteOpen((open) => !open)} aria-label="Delete item"><Trash2 size={17} /></button> : <button className="icon-button" disabled aria-label="View-only item"><MoreHorizontal size={18} /></button>}</div>
        </div>
        {deleteOpen && <div className="detail-delete-banner"><div><Trash2 size={15} /><p><strong>Delete this item?</strong><span>This removes it for everyone with access to this space.</span></p></div><div><button onClick={() => setDeleteOpen(false)}>Cancel</button><button onClick={onDelete}>Delete</button></div></div>}
        <div className="detail-scroll">
          <div className="detail-visual">
            {item.kind === 'image' && item.image && <img src={item.image} alt={item.title} />}
            {item.kind === 'video' && item.video && <video src={item.video} poster={item.image} controls playsInline preload="metadata" aria-label={item.title} />}
            {item.kind === 'link' && <LinkVisual item={item} detail onImageFailed={onPreviewFailed} />}
            {item.kind === 'note' && <div className="note-art"><FileText size={21} /><p>“{item.description}”</p><span>NOTE TO SELF</span></div>}
          </div>
          <div className="detail-content">
            <div className="detail-source"><span>{item.kind === 'link' ? <Link2 size={13} /> : item.kind === 'image' ? <ImageIcon size={13} /> : item.kind === 'video' ? <Video size={13} /> : <FileText size={13} />}{item.domain ?? item.source}</span><span>{item.capturedAt ? `Taken ${compactDate(item.capturedAt)}` : `Kept ${relativeDate(item.createdAt)}`}</span></div>
            <h2 id="detail-title">{item.title}</h2>
            <p className="detail-description">{item.description}</p>
            {item.url && <div className="detail-link-actions"><a className="open-original" href={item.url} target="_blank" rel="noreferrer">Open original <ArrowUpRight size={15} /></a>{canEdit && <button className="refresh-preview-button" onClick={onRefreshPreview} disabled={previewRefreshing}>{previewRefreshing ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{item.image ? 'Refresh preview' : 'Find a preview'}</button>}</div>}
            <hr />
            <div className="understood-row"><div className="spark-box"><Sparkles size={17} /></div><div><strong>Understood by Kept</strong><span>{Math.round(item.aiConfidence * 100)}% confident · visual + context</span></div><Check size={17} /></div>
            <dl className="metadata-list">
              <div className="detail-space-row"><dt>Space</dt><dd><button onClick={() => canEdit && setSpaceOpen((open) => !open)} aria-expanded={spaceOpen} disabled={!canEdit} title={!canEdit ? 'View-only shared item' : undefined}><Folder size={14} /> {item.space}{canEdit && <ChevronDown size={13} />}</button>{spaceOpen && <div className="detail-space-menu">{spaces.map((space) => <button key={space.id} className={item.space === space.name ? 'active' : ''} onClick={() => { onMove(space.name); setSpaceOpen(false) }}><i style={{ background: space.color }} />{space.name}{item.space === space.name && <Check size={12} />}</button>)}</div>}</dd></div>
              <div><dt>Dates</dt><dd className="date-detail">{item.capturedAt && <span><CalendarDays size={14} /><span><strong>Taken {fullDate(item.capturedAt)}</strong><small>{dateSourceLabel(item.capturedAtSource)}</small></span></span>}<span><Clock3 size={14} /><span><strong>Kept {fullDate(item.createdAt)}</strong><small>Added to your library</small></span></span></dd></div>
              {item.location && <div><dt>Location</dt><dd className="location-detail">{locationUrl ? <a href={locationUrl} target="_blank" rel="noreferrer"><MapPin size={14} /><span><strong>{item.location.name || locationCoordinates}</strong>{item.location.name && <small>{locationCoordinates}</small>}</span><ArrowUpRight size={13} /></a> : <span className="location-static"><MapPin size={14} /><strong>{item.location.name}</strong></span>}<em>{locationSourceLabel(item.location.source)}</em></dd></div>}
              <div><dt>Tags</dt><dd className="tags-detail">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}<button aria-label="Add tag"><Plus size={12} /></button></dd></div>
              <div><dt>Colours</dt><dd className="palette-detail">{item.palette.map((color) => <i key={color} style={{ background: color }} title={color} />)}<span>{item.palette.join(' · ')}</span></dd></div>
            </dl>
            <div className="findable-box"><Search size={16} /><div><strong>Findable as</strong><p>{item.searchTerms.slice(0, 3).join(' · ')}</p></div></div>
          </div>
        </div>
      </aside>
    </div>
  )
}

function LibraryApp({ session }: { session: Session }) {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [spaces, setSpaces] = useState<LibrarySpace[]>([])
  const [sharedSpaces, setSharedSpaces] = useState<SharedSpace[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('all')
  const [activeSpace, setActiveSpace] = useState('')
  const [activeSpaceOwnerId, setActiveSpaceOwnerId] = useState(session.user.id)
  const [kind, setKind] = useState<'all' | ItemKind>('all')
  const [query, setQuery] = useState('')
  const [selectedColour, setSelectedColour] = useState('')
  const [datePreset, setDatePreset] = useState<DatePreset>('any')
  const [dateField, setDateField] = useState<DateField>('relevant')
  const [customDateFrom, setCustomDateFrom] = useState('')
  const [customDateTo, setCustomDateTo] = useState('')
  const [detectedDate, setDetectedDate] = useState<SearchDateIntent | null>(null)
  const [rankedSearch, setRankedSearch] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('auto')
  const [spaceManagerOpen, setSpaceManagerOpen] = useState(false)
  const [autoMatchSpaceId, setAutoMatchSpaceId] = useState('')
  const [sharingSpace, setSharingSpace] = useState<LibrarySpace | null>(null)
  const [librarySharingOpen, setLibrarySharingOpen] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [mobileCaptureOpen, setMobileCaptureOpen] = useState(false)
  const [incomingCapture, setIncomingCapture] = useState<{ value: string; tab: CaptureTab } | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantItemId, setAssistantItemId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([])
  const [resolvedQuery, setResolvedQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [previewingIds, setPreviewingIds] = useState<string[]>([])
  const [removingIds, setRemovingIds] = useState<string[]>([])
  const [visibleCount, setVisibleCount] = useState(pageSize)
  const [paging, setPaging] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const paginationRef = useRef<HTMLDivElement>(null)
  const paginationTimerRef = useRef<number | null>(null)
  const previewRequestsRef = useRef(new Set<string>())
  const previewAttemptedRef = useRef(new Set<string>())
  const automaticPreviewCountRef = useRef(0)
  const localToday = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }, [])
  const timezoneOffset = useMemo(() => new Date().getTimezoneOffset(), [])
  const explicitDateRange = useMemo<DateRange | undefined>(() => {
    if (datePreset !== 'custom') return presetDateRange(datePreset, localToday, timezoneOffset)
    if (!customDateFrom && !customDateTo) return undefined
    const from = customDateFrom ? new Date(`${customDateFrom}T00:00:00`) : new Date('1900-01-01T00:00:00')
    const through = customDateTo || customDateFrom
    const to = new Date(new Date(`${through || localToday}T00:00:00`).getTime() + 86_400_000)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) return undefined
    return { from: from.toISOString(), to: to.toISOString(), label: customDateFrom === customDateTo || (!customDateTo && customDateFrom) ? compactDate(from.toISOString()) : `${customDateFrom ? compactDate(from.toISOString()) : 'Any time'} – ${customDateTo ? compactDate(new Date(`${customDateTo}T00:00:00`).toISOString()) : 'Today'}` }
  }, [customDateFrom, customDateTo, datePreset, localToday, timezoneOffset])
  const searchSignature = `${query.trim()}|${selectedColour}|${explicitDateRange?.from ?? ''}|${explicitDateRange?.to ?? ''}|${dateField}`

  const loadLibrary = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const sharedRequest = apiFetch('/api/shared-spaces').catch(() => undefined)
      const [itemResponse, spaceResponse] = await Promise.all([apiFetch('/api/items'), apiFetch('/api/spaces')])
      const itemData = await itemResponse.json() as MemoryItem[] | { error?: string }
      const spaceData = await spaceResponse.json() as LibrarySpace[] | { error?: string }
      if (!itemResponse.ok || !Array.isArray(itemData)) throw new Error(!Array.isArray(itemData) && itemData.error ? itemData.error : 'The library is temporarily offline.')
      if (!spaceResponse.ok || !Array.isArray(spaceData)) throw new Error(!Array.isArray(spaceData) && spaceData.error ? spaceData.error : 'Spaces are temporarily unavailable.')
      setItems(itemData); setSpaces(spaceData)
      try {
        const sharedResponse = await sharedRequest
        if (!sharedResponse) throw new Error('Shared spaces could not be refreshed.')
        const sharedData = await sharedResponse.json() as { spaces?: SharedSpace[] }
        if (!sharedResponse.ok || !Array.isArray(sharedData.spaces)) throw new Error('Shared spaces could not be refreshed.')
        setSharedSpaces(sharedData.spaces)
      } catch {
        setSharedSpaces([])
        setToast('Shared spaces could not be refreshed. Your personal library is still available.')
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'The library is temporarily offline.')
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [session.user.id])

  useEffect(() => { void loadLibrary() }, [loadLibrary])

  useEffect(() => {
    let refreshTimer: number | undefined
    const refreshSoon = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => void loadLibrary(false), 180)
    }
    const channel = supabase
      .channel(`memory-items:${session.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'memory_items' }, refreshSoon)
      .subscribe()
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshSoon()
    }
    window.addEventListener('focus', refreshSoon)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer)
      window.removeEventListener('focus', refreshSoon)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      void supabase.removeChannel(channel)
    }
  }, [loadLibrary, session.user.id])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('capture') !== 'shared') return
    const sharedUrl = params.get('url')?.trim() ?? ''
    const sharedText = params.get('text')?.trim() ?? ''
    const embeddedUrl = sharedText.match(/https?:\/\/[^\s<>"']+/i)?.[0] ?? ''
    const value = sharedUrl || embeddedUrl || sharedText || params.get('title')?.trim() || ''
    if (value) {
      setIncomingCapture({ value, tab: sharedUrl || embeddedUrl ? 'link' : 'note' })
      setCaptureOpen(true)
    }
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`)
  }, [])

  const refreshPreview = useCallback(async (id: string, searchWeb = false, notify = false) => {
    if (previewRequestsRef.current.has(id)) return
    previewRequestsRef.current.add(id)
    setPreviewingIds((all) => all.includes(id) ? all : [...all, id])
    try {
      const response = await apiFetch(`/api/items/${id}/refresh-preview${searchWeb ? '?search=1' : ''}`, { method: 'POST' })
      const data = await response.json() as { item?: MemoryItem; source?: string; error?: string }
      if (!response.ok || !data.item) throw new Error(data.error || 'No reliable preview image was found.')
      setItems((all) => all.map((item) => item.id === data.item?.id ? data.item : item))
      if (notify) setToast(data.source === 'web-search' ? 'Found a preview through web search' : 'Preview refreshed')
    } catch (error) {
      if (notify) setToast(error instanceof Error ? error.message : 'No reliable preview image was found.')
    } finally {
      previewRequestsRef.current.delete(id)
      setPreviewingIds((all) => all.filter((value) => value !== id))
    }
  }, [])

  useEffect(() => {
    if (loading || previewingIds.length || automaticPreviewCountRef.current >= 12) return
    const candidates = items.filter((item) => item.ownerId === session.user.id && item.kind === 'link' && item.url && (!item.image || isLikelyBrandPreview(item.image)) && !previewAttemptedRef.current.has(item.id)).slice(0, 3)
    if (!candidates.length) return
    for (const item of candidates) {
      previewAttemptedRef.current.add(item.id)
      automaticPreviewCountRef.current += 1
      void refreshPreview(item.id)
    }
  }, [items, loading, previewingIds.length, refreshPreview, session.user.id])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
      if (event.key === '/' && !typing) { event.preventDefault(); searchRef.current?.focus() }
      if (event.key.toLowerCase() === 'c' && !typing && !captureOpen) { event.preventDefault(); setCaptureOpen(true) }
      if (event.key === 'Escape') { setCaptureOpen(false); setMobileCaptureOpen(false); setLibrarySharingOpen(false); setSelectedId(null); setMobileOpen(false); setAssistantOpen(false); setSpaceManagerOpen(false); setAutoMatchSpaceId('') }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [captureOpen])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 3000)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    const normalized = query.trim()
    if (!normalized && !selectedColour && !explicitDateRange) {
      setSearchMatches([])
      setResolvedQuery('')
      setDetectedDate(null)
      setRankedSearch(false)
      setSearching(false)
      return
    }
    const controller = new AbortController()
    setSearching(true)
    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams()
        if (normalized) params.set('q', normalized)
        if (selectedColour) params.set('color', selectedColour)
        params.set('today', localToday)
        params.set('offset', String(timezoneOffset))
        params.set('dateField', dateField)
        if (explicitDateRange) {
          params.set('from', explicitDateRange.from)
          params.set('to', explicitDateRange.to)
          params.set('dateLabel', explicitDateRange.label)
        }
        const response = await apiFetch(`/api/search?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Search is unavailable.')
        const data = await response.json() as { results: SearchMatch[]; ranked?: boolean; dateIntent?: SearchDateIntent }
        setSearchMatches(data.results)
        setDetectedDate(data.dateIntent ?? null)
        setRankedSearch(Boolean(data.ranked))
        setResolvedQuery(searchSignature)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setSearchMatches([])
        setResolvedQuery(searchSignature)
        setToast('Semantic search is temporarily unavailable.')
      } finally {
        if (!controller.signal.aborted) setSearching(false)
      }
    }, 240)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [query, selectedColour, explicitDateRange, dateField, localToday, timezoneOffset, searchSignature])

  const navigate = useCallback((nextView: View, space?: string, ownerId?: string) => {
    setView(nextView); setActiveSpace(space ?? ''); setActiveSpaceOwnerId(ownerId ?? session.user.id); setKind('all')
  }, [session.user.id])

  const shownItems = useMemo(() => {
    let result = [...new Map(items.map((item) => [item.id, item])).values()]
    if (view === 'favourites') result = result.filter((item) => item.favourite)
    if (view === 'space') result = result.filter((item) => item.space === activeSpace && item.ownerId === activeSpaceOwnerId)
    if (kind !== 'all') result = result.filter((item) => item.kind === kind)
    if (query.trim() || selectedColour || explicitDateRange) {
      if (resolvedQuery !== searchSignature) return []
      const order = new Map(searchMatches.map((match, index) => [match.id, index]))
      result = result.filter((item) => order.has(item.id)).sort((left, right) => order.get(left.id)! - order.get(right.id)!)
    }
    if (sortMode !== 'auto' || !rankedSearch) {
      const mode = sortMode === 'auto' ? 'date-desc' : sortMode
      result.sort((left, right) => {
        const leftValue = new Date(mode.startsWith('kept') ? left.createdAt : (itemDate(left) ?? left.createdAt)).getTime()
        const rightValue = new Date(mode.startsWith('kept') ? right.createdAt : (itemDate(right) ?? right.createdAt)).getTime()
        return mode.endsWith('asc') ? leftValue - rightValue : rightValue - leftValue
      })
    }
    return result
  }, [items, view, activeSpace, activeSpaceOwnerId, kind, query, selectedColour, explicitDateRange, resolvedQuery, searchMatches, searchSignature, sortMode, rankedSearch])

  useEffect(() => {
    setVisibleCount(pageSize)
    setPaging(false)
    if (paginationTimerRef.current) {
      window.clearTimeout(paginationTimerRef.current)
      paginationTimerRef.current = null
    }
  }, [view, activeSpace, activeSpaceOwnerId, kind, query, selectedColour, datePreset, dateField, customDateFrom, customDateTo, sortMode])

  const visibleItems = shownItems.slice(0, visibleCount)
  const hasMoreItems = visibleCount < shownItems.length
  const loadNextPage = useCallback(() => {
    if (paging || paginationTimerRef.current !== null || visibleCount >= shownItems.length) return
    setPaging(true)
    paginationTimerRef.current = window.setTimeout(() => {
      setVisibleCount((count) => Math.min(count + pageSize, shownItems.length))
      setPaging(false)
      paginationTimerRef.current = null
    }, 100)
  }, [paging, shownItems.length, visibleCount])

  useEffect(() => {
    const sentinel = paginationRef.current
    if (!sentinel || !hasMoreItems || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadNextPage()
    }, { rootMargin: '500px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreItems, loadNextPage])

  useEffect(() => () => {
    if (paginationTimerRef.current) window.clearTimeout(paginationTimerRef.current)
  }, [])

  const relevanceById = useMemo(() => new Map(searchMatches.map((match) => [match.id, match.relevance])), [searchMatches])
  const hasSearch = Boolean(query.trim() || selectedColour || explicitDateRange)
  const hasSearchScope = hasSearch && (view === 'favourites' || view === 'space' || kind !== 'all' || explicitDateRange || detectedDate)
  const searchPending = hasSearch && (searching || resolvedQuery !== searchSignature)

  const clearViewScope = () => {
    setView('all')
    setActiveSpace('')
    setActiveSpaceOwnerId(session.user.id)
  }

  const clearSearchScope = () => {
    clearViewScope()
    setKind('all')
    setDatePreset('any')
    setDateField('relevant')
    setCustomDateFrom('')
    setCustomDateTo('')
    if (detectedDate) setQuery(detectedDate.residualQuery)
  }

  const selected = items.find((item) => item.id === selectedId) ?? null
  const sharedAccess = (item: MemoryItem | null) => item && item.ownerId !== session.user.id
    ? sharedSpaces.find((space) => space.ownerUserId === item.ownerId && space.name === item.space)?.permissions
    : undefined
  const canEditItem = (item: MemoryItem) => item.ownerId === session.user.id || Boolean(sharedAccess(item)?.canEdit)
  const canDeleteItem = (item: MemoryItem) => item.ownerId === session.user.id || Boolean(sharedAccess(item)?.canDelete)
  const activeSharedSpace = sharedSpaces.find((space) => space.ownerUserId === activeSpaceOwnerId && space.name === activeSpace)
  const captureTarget = view === 'space' && activeSharedSpace?.permissions.canAdd ? { ownerId: activeSharedSpace.ownerUserId, name: activeSharedSpace.name } : undefined
  const pageTitle = query ? `Results for “${query}”` : selectedColour ? 'Closest colour matches' : explicitDateRange ? explicitDateRange.label : view === 'space' ? activeSpace : view === 'favourites' ? 'Favourites' : view === 'recent' ? 'Recently kept' : 'Everything worth finding again.'

  const toggleFavourite = async (id: string) => {
    const current = items.find((item) => item.id === id)
    if (!current) return
    const favourite = !current.favourite
    setItems((all) => all.map((item) => item.id === id ? { ...item, favourite } : item))
    try {
      const response = await apiFetch(`/api/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favourite }) })
      if (!response.ok) throw new Error('You do not have permission to edit that item.')
      setToast(favourite ? 'Added to favourites' : 'Removed from favourites')
    } catch (error) {
      setItems((all) => all.map((item) => item.id === id ? current : item))
      setToast(error instanceof Error ? error.message : 'That item could not be updated.')
    }
  }

  const deleteItem = async (id: string) => {
    try {
      const response = await apiFetch(`/api/items/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = await response.json() as { error?: string }
        throw new Error(data.error || 'That item could not be deleted.')
      }
      setRemovingIds((all) => [...all, id]); setSelectedId(null)
      await new Promise((resolve) => window.setTimeout(resolve, 260))
      setItems((all) => all.filter((item) => item.id !== id)); setRemovingIds((all) => all.filter((itemId) => itemId !== id)); setToast('Item deleted')
    } catch (error) {
      setRemovingIds((all) => all.filter((itemId) => itemId !== id))
      setToast(error instanceof Error ? error.message : 'That item could not be deleted.')
    }
  }

  const moveItem = async (id: string, space: string) => {
    const current = items.find((item) => item.id === id)
    if (!current || current.space === space) return
    setItems((all) => all.map((item) => item.id === id ? { ...item, space } : item))
    try {
      const response = await apiFetch(`/api/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ space }) })
      if (!response.ok) throw new Error('That item could not be moved.')
      const updated = await response.json() as MemoryItem
      setItems((all) => all.map((item) => item.id === id ? updated : item)); setToast(`Moved to ${space}`)
    } catch (error) {
      setItems((all) => all.map((item) => item.id === id ? current : item))
      setToast(error instanceof Error ? error.message : 'That item could not be moved.')
    }
  }

  return (
    <div className="app-shell">
      {loading && <LibraryPreloader />}
      <Sidebar items={items} spaces={spaces} sharedSpaces={sharedSpaces} currentUserId={session.user.id} view={view} activeSpace={activeSpace} activeSpaceOwnerId={activeSpaceOwnerId} onNavigate={navigate} onCapture={() => { setIncomingCapture(null); setCaptureOpen(true) }} onAssistant={() => { setAssistantOpen(true); setSelectedId(null); setCaptureOpen(false) }} onMobileCapture={() => setMobileCaptureOpen(true)} onShareLibrary={() => setLibrarySharingOpen(true)} onManageSpaces={() => { setSpaceManagerOpen(true); setMobileOpen(false) }} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} email={session.user.email ?? 'Signed in'} onSignOut={() => void supabase.auth.signOut()} />
      <main className="main-content">
        <header className="mobile-header"><button className="icon-button" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><KeptLogo /><div><button className="icon-button mobile-assistant" onClick={() => setAssistantOpen(true)} aria-label="Ask Kept"><Sparkles size={18} /></button><button className="icon-button mobile-add" onClick={() => setCaptureOpen(true)} aria-label="Capture something"><Plus size={20} /></button></div></header>
        <div className="content-wrap">
          <div className="page-intro">
            <div><p className="eyebrow">Your visual memory</p><h1>{pageTitle}</h1></div>
            {view === 'all' && !hasSearch && <p className="intro-note"><Sparkles size={14} /> Kept has organised <strong>{items.length} {items.length === 1 ? 'thing' : 'things'}</strong> for you</p>}
            {view === 'space' && activeSpaceOwnerId === session.user.id && !hasSearch && <div className="space-page-actions"><button className="auto-fill-space-button" onClick={() => { const space = spaces.find((entry) => entry.ownerId === session.user.id && entry.name === activeSpace); if (space) { setAutoMatchSpaceId(space.id); setSpaceManagerOpen(true) } }}><Sparkles size={14} /> Auto-fill</button><button className="share-space-button" onClick={() => { const space = spaces.find((entry) => entry.ownerId === session.user.id && entry.name === activeSpace); if (space) setSharingSpace(space) }}><Share2 size={14} /> Share space</button></div>}
          </div>
          <div className="search-sticky-shelf">
            <SearchBar value={query} colour={selectedColour} onChange={setQuery} onColourChange={setSelectedColour} inputRef={searchRef} />
            <DateFilterBar preset={datePreset} field={dateField} customFrom={customDateFrom} customTo={customDateTo} onPreset={setDatePreset} onField={setDateField} onCustomFrom={setCustomDateFrom} onCustomTo={setCustomDateTo} onClear={() => { setDatePreset('any'); setDateField('relevant'); setCustomDateFrom(''); setCustomDateTo('') }} />
          {hasSearchScope && (
            <div className="search-scope" aria-label="Active search filters">
              <span className="search-scope-label"><Layers2 size={13} /> Searching within</span>
              <div className="search-scope-chips">
                {view === 'favourites' && <button type="button" className="search-scope-chip" onClick={clearViewScope} aria-label="Remove Favourites search filter"><Heart size={12} /> Favourites <X size={11} /></button>}
                {view === 'space' && <button type="button" className="search-scope-chip" onClick={clearViewScope} aria-label={`Remove ${activeSpace} space search filter`}><Folder size={12} /> Space: {activeSpace} <X size={11} /></button>}
                {kind !== 'all' && <button type="button" className="search-scope-chip" onClick={() => setKind('all')} aria-label={`Remove ${kindLabel(kind)} type search filter`}>Type: {kindLabel(kind)}s <X size={11} /></button>}
                {explicitDateRange && <button type="button" className="search-scope-chip" onClick={() => { setDatePreset('any'); setCustomDateFrom(''); setCustomDateTo('') }} aria-label={`Remove ${explicitDateRange.label} date filter`}><CalendarDays size={12} /> {explicitDateRange.label} · {dateField === 'relevant' ? 'best date' : dateField === 'captured' ? 'taken' : 'kept'} <X size={11} /></button>}
                {!explicitDateRange && detectedDate && <button type="button" className="search-scope-chip inferred-date" onClick={() => setQuery(detectedDate.residualQuery)} aria-label={`Remove inferred ${detectedDate.label} date filter`}><Sparkles size={12} /> Understood: {detectedDate.label} <X size={11} /></button>}
              </div>
              <button type="button" className="search-everything" onClick={clearSearchScope}>Search everything</button>
            </div>
          )}
          </div>
          {!hasSearch && view === 'all' && (
            <div className="suggestions" aria-label="Suggested searches">
              <span>Try</span>
              <button onClick={() => setQuery('design knife')}>design knife</button>
              <button onClick={() => setQuery('auto parking space')}>auto parking space</button>
              <button onClick={() => setQuery('calm green chair')}>calm green chair</button>
            </div>
          )}

          <div className="library-toolbar">
            <div className="filter-tabs">
              {([['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['link', 'Links'], ['note', 'Notes']] as const).map(([value, label]) => <button key={value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{label}</button>)}
            </div>
            <div className="sort-control"><span>{searchPending ? 'Searching…' : `${shownItems.length} ${shownItems.length === 1 ? 'item' : 'items'}`}</span><label><span className="sr-only">Sort items</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}><option value="auto">{rankedSearch ? 'Most relevant' : 'Newest date'}</option>{rankedSearch && <option value="date-desc">Newest date</option>}<option value="date-asc">Oldest date</option><option value="kept-desc">Recently kept</option><option value="kept-asc">First kept</option></select><ChevronDown size={14} /></label></div>
          </div>

          {hasSearch && !searchPending && shownItems.length > 0 && <div className="result-note">{rankedSearch ? <Sparkles size={14} /> : <CalendarDays size={14} />}<p>{detectedDate ? `${rankedSearch ? 'Meaning-matched and constrained' : 'Showing items'} to ${detectedDate.label.toLowerCase()}.` : explicitDateRange ? `${rankedSearch ? 'Meaning-matched within' : 'Showing'} ${explicitDateRange.label.toLowerCase()}.` : query && selectedColour ? 'Ranked by meaning and nearest visual palette.' : selectedColour ? 'Ranked by perceptual colour similarity.' : 'Ranked by semantic and fuzzy relevance.'} <strong>{shownItems.length} {shownItems.length === 1 ? 'match' : 'matches'}.</strong></p></div>}

          {loading || searchPending ? (
            <div className="masonry skeleton-grid">{[1, 2, 3, 4, 5, 6].slice(0, searchPending ? 3 : 6).map((value) => <div className="skeleton-card" key={value} />)}</div>
          ) : shownItems.length ? (
            <>
              <section className={`masonry ${hasSearch ? 'search-results' : ''}`} aria-label="Saved items">
                {visibleItems.map((item) => <MemoryCard key={item.id} item={item} canEdit={canEditItem(item)} removing={removingIds.includes(item.id)} relevance={rankedSearch ? relevanceById.get(item.id) : undefined} onOpen={() => setSelectedId(item.id)} onChat={() => { setAssistantItemId(item.id); setAssistantOpen(true); setSelectedId(null); setCaptureOpen(false) }} onFavourite={() => void toggleFavourite(item.id)} onPreviewFailed={() => { if (item.ownerId === session.user.id && !previewAttemptedRef.current.has(item.id)) { previewAttemptedRef.current.add(item.id); void refreshPreview(item.id) } }} />)}
              </section>
              {hasMoreItems && <div className="pagination-sentinel" ref={paginationRef} role="status" aria-live="polite">
                <button type="button" onClick={loadNextPage} disabled={paging} aria-label={`Load more items. Showing ${visibleItems.length} of ${shownItems.length}`}>
                  <span className="pagination-pulse" aria-hidden="true"><i /><i /><i /></span>
                  <span>{paging ? 'Gathering more…' : `Keep scrolling · ${shownItems.length - visibleItems.length} more`}</span>
                </button>
              </div>}
            </>
          ) : (
            <div className="empty-state"><div><Search size={24} /></div><h2>Nothing hiding here</h2><p>{hasSearch ? 'Try a broader feeling, object, colour, place or date.' : 'Keep something new and it will appear here.'}</p>{hasSearch ? <button className="secondary-button" onClick={() => { setQuery(''); setSelectedColour(''); setDatePreset('any'); setDateField('relevant'); setCustomDateFrom(''); setCustomDateTo('') }}>Clear search</button> : <button className="primary-button" onClick={() => setCaptureOpen(true)}>Capture something <Plus size={15} /></button>}</div>
          )}
        </div>
        {!hasSearch && <button className="floating-capture" onClick={() => setCaptureOpen(true)} aria-label="Capture something"><Plus size={20} /><span>Keep something</span></button>}
        <AssistantButton onClick={() => { setAssistantOpen(true); setSelectedId(null); setCaptureOpen(false) }} />
      </main>

      <CaptureModal open={captureOpen} currentUserId={session.user.id} targetSpace={captureTarget} initialValue={incomingCapture?.value} initialTab={incomingCapture?.tab} onClose={() => { setCaptureOpen(false); setIncomingCapture(null) }} onCaptured={(item) => { setIncomingCapture(null); setItems((all) => item.duplicate ? all.map((existing) => existing.id === item.id ? { ...item, duplicate: undefined } : existing) : [item, ...all]); if (captureTarget && !item.duplicate) { setView('space'); setActiveSpace(captureTarget.name); setActiveSpaceOwnerId(captureTarget.ownerId) } else { setView('all'); setActiveSpace(''); setActiveSpaceOwnerId(session.user.id) }; setToast(item.duplicate ? `Already kept in ${item.space}` : `Filed in ${item.space}`); window.setTimeout(() => setSelectedId(item.id), 350) }} />
      <MobileCaptureDialog open={mobileCaptureOpen} onClose={() => setMobileCaptureOpen(false)} />
      <DetailPanel item={selected} spaces={spaces.filter((space) => space.ownerId === selected?.ownerId)} canEdit={selected ? canEditItem(selected) : false} canDelete={selected ? canDeleteItem(selected) : false} previewRefreshing={selected ? previewingIds.includes(selected.id) : false} onClose={() => setSelectedId(null)} onChat={() => { if (selected) { setAssistantItemId(selected.id); setSelectedId(null); setAssistantOpen(true) } }} onFavourite={() => selected && void toggleFavourite(selected.id)} onMove={(space) => selected && void moveItem(selected.id, space)} onDelete={() => selected && void deleteItem(selected.id)} onRefreshPreview={() => selected && void refreshPreview(selected.id, true, true)} onPreviewFailed={() => { if (selected && selected.ownerId === session.user.id && !previewAttemptedRef.current.has(selected.id)) { previewAttemptedRef.current.add(selected.id); void refreshPreview(selected.id) } }} />
      <SpaceManager
        open={spaceManagerOpen}
        spaces={spaces.filter((space) => space.ownerId === session.user.id)}
        items={items}
        onClose={() => { setSpaceManagerOpen(false); setAutoMatchSpaceId('') }}
        onSpacesChange={(owned) => setSpaces((all) => [...owned, ...all.filter((space) => space.ownerId !== session.user.id)])}
        onRename={(from, to) => { setItems((all) => all.map((item) => item.ownerId === session.user.id && item.space === from ? { ...item, space: to } : item)); if (activeSpaceOwnerId === session.user.id && activeSpace === from) setActiveSpace(to); setToast(`Renamed to ${to}`) }}
        onDelete={(from, to) => { setItems((all) => all.map((item) => item.ownerId === session.user.id && item.space === from ? { ...item, space: to } : item)); if (activeSpaceOwnerId === session.user.id && activeSpace === from) { setView('space'); setActiveSpace(to) }; setToast(`Deleted ${from}; its items moved to ${to}`) }}
        onShare={(space) => { setSpaceManagerOpen(false); setSharingSpace(space) }}
        onItemsAdded={(moved, space) => { const byId = new Map(moved.map((item) => [item.id, item])); setItems((all) => all.map((item) => byId.get(item.id) ?? item)); setToast(`Added ${moved.length} ${moved.length === 1 ? 'item' : 'items'} to ${space.name}`) }}
        autoMatchSpaceId={autoMatchSpaceId}
        onAutoMatchHandled={() => setAutoMatchSpaceId('')}
      />
      <ShareSpaceDialog open={Boolean(sharingSpace)} spaceName={sharingSpace?.name ?? ''} currentUserId={session.user.id} onClose={() => setSharingSpace(null)} />
      <ShareLibraryDialog open={librarySharingOpen} currentUserId={session.user.id} onClose={() => setLibrarySharingOpen(false)} />
      <SpaceInvitationGate onAccepted={(shared) => { setSharedSpaces((all) => [shared, ...all.filter((entry) => entry.ownerUserId !== shared.ownerUserId || entry.name !== shared.name)]); void loadLibrary(false); navigate('space', shared.name, shared.ownerUserId); setToast(`Joined ${shared.name}`) }} onLibraryAccepted={() => { void loadLibrary(false); navigate('all'); setToast('Joined the shared library') }} />
      <AssistantPanel
        open={assistantOpen}
        userId={session.user.id}
        items={items}
        initialItemId={assistantItemId}
        onInitialItemHandled={() => setAssistantItemId(null)}
        onClose={() => { setAssistantOpen(false); setAssistantItemId(null) }}
        onOpenItem={(id) => { setAssistantOpen(false); setSelectedId(id) }}
        onItemUpdated={(updated) => { setItems((all) => all.map((item) => item.id === updated.id ? updated : item)); setToast('Item updated by Kept') }}
        onItemsCreated={(created) => { setItems((all) => [...created.filter((item) => !all.some(({ id }) => id === item.id)), ...all]); const added = created.filter((item) => !item.duplicate).length; setToast(added ? `Kept added ${added} ${added === 1 ? 'item' : 'items'}` : 'Already in your library') }}
        onItemsDeleted={(ids) => { setRemovingIds((all) => [...new Set([...all, ...ids])]); setSelectedId((id) => id && ids.includes(id) ? null : id); window.setTimeout(() => { setItems((all) => all.filter((item) => !ids.includes(item.id))); setRemovingIds((all) => all.filter((id) => !ids.includes(id))); setToast(`Kept removed ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`) }, 260) }}
      />
      {toast && <div className="toast" role="status"><Check size={15} />{toast}</div>}
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  if (session === undefined) return <AuthLoading />
  if (!session) return <AuthScreen />
  return <LibraryApp key={session.user.id} session={session} />
}
