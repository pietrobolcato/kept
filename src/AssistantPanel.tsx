import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronRight,
  ExternalLink,
  Globe2,
  History,
  Image as ImageIcon,
  Library,
  LoaderCircle,
  Paperclip,
  Search,
  Send,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'
import type { MemoryItem } from './types'
import { apiFetch } from './lib/api'

type AssistantSource = { title: string; url: string; image?: string; domain?: string }
type AssistantCreateItem = Pick<MemoryItem, 'title' | 'description' | 'kind' | 'space' | 'tags' | 'palette' | 'searchTerms'> & { url?: string; domain?: string }
type AssistantActionBase = {
  id: string
  label: string
  description: string
  expiresAt: string
}
type AssistantAction = AssistantActionBase & (
  | { kind: 'update'; itemId: string; itemTitle: string; patch: Partial<Pick<MemoryItem, 'title' | 'description' | 'space' | 'tags' | 'favourite'>> }
  | { kind: 'create'; items: AssistantCreateItem[] }
  | { kind: 'delete'; itemIds: string[]; itemTitles: string[] }
)
type AssistantActionResult = {
  item?: MemoryItem
  items?: MemoryItem[]
  deletedItemIds?: string[]
  receipt?: string
}
type AssistantReply = {
  message: string
  itemIds: string[]
  sources: AssistantSource[]
  activities: string[]
  proposedAction?: AssistantAction
  conversation: ConversationSummary
}
type AssistantStreamEvent =
  | { type: 'ready' }
  | { type: 'reset' }
  | { type: 'delta'; delta: string }
  | { type: 'done'; data: AssistantReply }
  | { type: 'error'; error: string }
type ConversationSummary = {
  id: string
  title: string
  preview: string
  messageCount: number
  createdAt: string
  updatedAt: string
}
type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  itemIds?: string[]
  sources?: AssistantSource[]
  activities?: string[]
  proposedAction?: AssistantAction
  attachmentLabels?: string[]
  receipt?: string
  createdAt?: string
  streaming?: boolean
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const raw = await response.text()
  let data: (T & { error?: string }) | undefined
  if (raw) {
    try {
      data = JSON.parse(raw) as T & { error?: string }
    } catch {
      throw new Error(fallback)
    }
  }
  if (!response.ok) throw new Error(data?.error || fallback)
  if (!data) throw new Error(fallback)
  return data
}

function conversationTime(value: string) {
  const date = new Date(value)
  const elapsed = Date.now() - date.getTime()
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formattedMessage(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|https?:\/\/[^\s<>"']+)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*')) return <em key={`${part}-${index}`}>{part.slice(1, -1)}</em>
    if (/^https?:\/\//.test(part)) {
      const clean = part.replace(/[),.;!?]+$/, '')
      const suffix = part.slice(clean.length)
      return <span key={`${part}-${index}`}><a className="assistant-inline-link" href={clean} target="_blank" rel="noreferrer">Open result <ExternalLink size={11} /></a>{suffix}</span>
    }
    return part
  })
}

function itemThumb(item: MemoryItem) {
  if (item.image) return <img src={item.image} alt="" />
  return <span style={{ background: item.palette[0] }}><ImageIcon size={13} /></span>
}

function SourceCard({ source, fallback }: { source: AssistantSource; fallback: string }) {
  const [imageFailed, setImageFailed] = useState(false)
  const [displayImage, setDisplayImage] = useState('')
  const [imageLoading, setImageLoading] = useState(Boolean(source.image))
  const domain = source.domain || (() => {
    try { return new URL(source.url).hostname.replace(/^www\./, '') } catch { return fallback }
  })()
  useEffect(() => {
    setImageFailed(false)
    setDisplayImage('')
    setImageLoading(Boolean(source.image))
    if (!source.image) return
    const controller = new AbortController()
    let objectUrl = ''
    void apiFetch(`/api/assistant/source-image?url=${encodeURIComponent(source.image)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Proxy unavailable')
        objectUrl = URL.createObjectURL(await response.blob())
        setDisplayImage(objectUrl)
      })
      .catch(() => { if (!controller.signal.aborted) setDisplayImage(source.image ?? '') })
      .finally(() => { if (!controller.signal.aborted) setImageLoading(false) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [source.image])
  return <a href={source.url} target="_blank" rel="noreferrer">
    <span className={`assistant-source-image${imageLoading ? ' loading' : ''}`}>
      {displayImage && !imageFailed
        ? <img src={displayImage} alt={`Preview of ${source.title}`} referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
        : imageLoading ? <LoaderCircle className="spin" size={18} /> : <Globe2 size={18} />}
    </span>
    <div><strong>{source.title}</strong><small>{domain}</small></div>
    <ExternalLink size={13} />
  </a>
}

function ActionReview({
  action,
  onApplied,
}: {
  action: AssistantAction
  onApplied: (result: AssistantActionResult) => void
}) {
  const [state, setState] = useState<'ready' | 'applying' | 'applied' | 'dismissed'>('ready')
  const [error, setError] = useState('')
  const changed = action.kind === 'update' ? Object.entries(action.patch) : []

  const confirm = async () => {
    setState('applying'); setError('')
    try {
      const response = await apiFetch(`/api/assistant/actions/${action.id}/confirm`, { method: 'POST' })
      const data = await readJsonResponse<AssistantActionResult>(response, 'That change could not be applied.')
      if (!data.item && !data.items?.length && !data.deletedItemIds?.length) throw new Error('That change could not be applied.')
      setState('applied')
      onApplied(data)
    } catch (nextError) {
      setState('ready')
      setError(nextError instanceof Error ? nextError.message : 'That change could not be applied.')
    }
  }

  const dismiss = () => {
    setState('dismissed')
    void apiFetch(`/api/assistant/actions/${action.id}`, { method: 'DELETE' })
  }

  if (state === 'dismissed') return <div className="assistant-action quiet"><X size={14} /><span>Change dismissed. Nothing changed.</span></div>
  if (state === 'applied') return <div className="assistant-action applied"><Check size={15} /><div><strong>Change applied</strong><span>Your library and search are up to date.</span></div></div>

  return (
    <section className="assistant-action" aria-label="Proposed library change">
      <div className="action-review-head"><span><Sparkles size={14} /></span><div><strong>{action.label}</strong><p>{action.description}</p></div></div>
      {action.kind === 'update' && <><div className="action-target"><small>ITEM</small><strong>{action.itemTitle}</strong></div><dl className="action-changes">
        {changed.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value}</dd></div>)}
      </dl></>}
      {action.kind === 'create' && <div className="action-item-list">{action.items.map((item) => <div key={`${item.title}-${item.url ?? ''}`}><span style={{ background: item.palette[0] }}><Globe2 size={12} /></span><div><strong>{item.title}</strong><small>{item.space}{item.domain ? ` · ${item.domain}` : ' · note'}</small></div></div>)}</div>}
      {action.kind === 'delete' && <div className="action-item-list destructive">{action.itemTitles.map((title, index) => <div key={`${action.itemIds[index]}-${title}`}><span><Trash2 size={12} /></span><div><strong>{title}</strong><small>Will be permanently removed</small></div></div>)}</div>}
      <p className="action-safety"><Check size={12} /> Kept will only apply this after you confirm.</p>
      {error && <p className="assistant-error" role="alert">{error}</p>}
      <div className="action-buttons">
        <button className="assistant-secondary" onClick={dismiss}>Not now</button>
        <button className={`assistant-confirm ${action.kind === 'delete' ? 'danger' : ''}`} onClick={() => void confirm()} disabled={state === 'applying'}>{state === 'applying' ? <LoaderCircle className="spin" size={14} /> : action.kind === 'delete' ? <Trash2 size={14} /> : <Check size={14} />} {action.kind === 'create' ? `Add ${action.items.length}` : action.kind === 'delete' ? `Remove ${action.itemIds.length}` : 'Confirm change'}</button>
      </div>
    </section>
  )
}

function LibraryPicker({
  items,
  selected,
  onDone,
  onClose,
}: {
  items: MemoryItem[]
  selected: string[]
  onDone: (ids: string[]) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState(selected)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) => !needle || [item.title, item.description, item.space, ...item.tags].join(' ').toLowerCase().includes(needle)).slice(0, 30)
  }, [items, query])

  const toggle = (id: string) => setDraft((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : ids.length < 4 ? [...ids, id] : ids)
  return (
    <div className="assistant-picker-layer" role="dialog" aria-modal="true" aria-labelledby="picker-title">
      <button className="assistant-picker-backdrop" onClick={onClose} aria-label="Close item picker" />
      <section className="assistant-picker">
        <header><div><p>ATTACH FROM KEPT</p><h3 id="picker-title">Choose up to four items</h3></div><button onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        <label className="picker-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, spaces or tags…" autoFocus /></label>
        <div className="picker-items">
          {filtered.map((item) => {
            const checked = draft.includes(item.id)
            return <button key={item.id} className={checked ? 'selected' : ''} onClick={() => toggle(item.id)}>{itemThumb(item)}<div><strong>{item.title}</strong><small>{item.space} · {item.kind}</small></div><i>{checked && <Check size={13} />}</i></button>
          })}
          {!filtered.length && <p className="picker-empty">No saved items match that search.</p>}
        </div>
        <footer><span>{draft.length}/4 selected</span><button onClick={() => { onDone(draft); onClose() }}>Attach items <ArrowRight size={15} /></button></footer>
      </section>
    </div>
  )
}

export function AssistantPanel({
  open,
  userId,
  items,
  initialItemId,
  onInitialItemHandled,
  onClose,
  onOpenItem,
  onItemUpdated,
  onItemsCreated,
  onItemsDeleted,
}: {
  open: boolean
  userId: string
  items: MemoryItem[]
  initialItemId?: string | null
  onInitialItemHandled?: () => void
  onClose: () => void
  onOpenItem: (id: string) => void
  onItemUpdated: (item: MemoryItem) => void
  onItemsCreated: (items: MemoryItem[]) => void
  onItemsDeleted: (ids: string[]) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [conversationLoading, setConversationLoading] = useState(false)
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const [attachmentOpen, setAttachmentOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [attachedIds, setAttachedIds] = useState<string[]>([])
  const [deviceFile, setDeviceFile] = useState<File | null>(null)
  const [devicePreview, setDevicePreview] = useState('')
  const [error, setError] = useState('')
  const [retryPrompt, setRetryPrompt] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoredRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const storageKey = `kept.assistant.current.${userId}`

  const refreshConversations = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const response = await apiFetch('/api/assistant/conversations')
      const data = await readJsonResponse<{ conversations: ConversationSummary[] }>(response, 'Chat history could not be loaded.')
      setConversations(data.conversations)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Chat history could not be loaded.')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const loadConversation = useCallback(async (id: string) => {
    setConversationLoading(true); setError('')
    try {
      const response = await apiFetch(`/api/assistant/conversations/${id}`)
      const data = await readJsonResponse<{ conversation: ConversationSummary; messages: ChatMessage[] }>(response, 'That conversation could not be loaded.')
      setConversationId(data.conversation.id)
      setMessages(data.messages)
      setHistoryOpen(false)
      window.localStorage.setItem(storageKey, data.conversation.id)
    } catch (nextError) {
      window.localStorage.removeItem(storageKey)
      setError(nextError instanceof Error ? nextError.message : 'That conversation could not be loaded.')
    } finally {
      setConversationLoading(false)
    }
  }, [storageKey])

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 250)
  }, [open])
  useEffect(() => {
    if (!open || !initialItemId || !items.some(({ id }) => id === initialItemId)) return
    restoredRef.current = true
    setConversationId(null); setMessages([]); setHistoryOpen(false); setError(''); setRetryPrompt('')
    setAttachedIds([initialItemId]); setDeviceFile(null); setDevicePreview('')
    window.localStorage.removeItem(storageKey)
    onInitialItemHandled?.()
  }, [initialItemId, items, onInitialItemHandled, open, storageKey])
  useEffect(() => {
    if (!open || restoredRef.current) return
    restoredRef.current = true
    void refreshConversations()
    const savedConversation = window.localStorage.getItem(storageKey)
    if (savedConversation) void loadConversation(savedConversation)
  }, [loadConversation, open, refreshConversations, storageKey])
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])
  useEffect(() => () => { if (devicePreview) URL.revokeObjectURL(devicePreview) }, [devicePreview])

  const attachedItems = attachedIds.map((id) => items.find((item) => item.id === id)).filter((item): item is MemoryItem => Boolean(item))
  const contextItem = attachedItems.length === 1 ? attachedItems[0] : undefined

  const startNewConversation = () => {
    setConversationId(null); setMessages([]); setHistoryOpen(false); setError('')
    setAttachedIds([]); setDeviceFile(null); setDevicePreview('')
    window.localStorage.removeItem(storageKey)
    window.setTimeout(() => inputRef.current?.focus(), 50)
  }

  const removeConversation = async (id: string) => {
    try {
      const response = await apiFetch(`/api/assistant/conversations/${id}`, { method: 'DELETE' })
      if (!response.ok) await readJsonResponse(response, 'That conversation could not be deleted.')
      setConversations((all) => all.filter((conversation) => conversation.id !== id))
      if (conversationId === id) startNewConversation()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'That conversation could not be deleted.')
    }
  }

  const chooseDeviceFile = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('For this MVP, device attachments need to be images.'); return }
    if (file.size > 12 * 1024 * 1024) { setError('Please choose an image under 12 MB.'); return }
    if (devicePreview) URL.revokeObjectURL(devicePreview)
    setDeviceFile(file); setDevicePreview(URL.createObjectURL(file)); setError(''); setAttachmentOpen(false)
  }

  const send = async (prompt?: string) => {
    const text = (prompt ?? value).trim()
    if (!text || sending) return
    const attachmentLabels = [...attachedItems.map((item) => item.title), ...(deviceFile ? [deviceFile.name] : [])]
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', text, attachmentLabels }
    const assistantMessageId = crypto.randomUUID()
    const assistantMessage: ChatMessage = { id: assistantMessageId, role: 'assistant', text: '', streaming: true }
    const history = messages.filter((message) => !message.streaming).map((message) => {
      const sourceContext = message.sources?.length
        ? `\nSources used in that answer:\n${message.sources.map((source) => `- ${source.title}: ${source.url}`).join('\n')}`
        : ''
      const itemContext = message.itemIds?.length
        ? `\nKept items referenced:\n${message.itemIds.map((id) => items.find((item) => item.id === id)).filter((item): item is MemoryItem => Boolean(item)).map((item) => `- ${item.title} [${item.id}] (${item.url ?? item.space})`).join('\n')}`
        : ''
      return { role: message.role, content: `${sourceContext}${itemContext}${sourceContext || itemContext ? '\nAnswer text:\n' : ''}${message.text}` }
    })
    setMessages((all) => [...all, userMessage, assistantMessage])
    setValue(''); setSending(true); setError(''); setRetryPrompt(''); setAttachmentOpen(false)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    const body = new FormData()
    body.append('message', text)
    body.append('history', JSON.stringify(history))
    body.append('attachmentItemIds', JSON.stringify(attachedIds))
    if (conversationId) body.append('conversationId', conversationId)
    if (deviceFile) body.append('attachment', deviceFile)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const response = await apiFetch('/api/assistant/chat/stream', { method: 'POST', body, signal: controller.signal })
      if (!response.ok) {
        setMessages((all) => all.filter(({ id }) => id !== assistantMessageId))
        await readJsonResponse(response, 'Kept couldn’t complete that request. Please try again.')
      }
      if (!response.body) throw new Error('Kept couldn’t start the live response. Please try again.')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let data: AssistantReply | undefined
      const consume = (line: string) => {
        if (!line.trim()) return
        let event: AssistantStreamEvent
        try {
          event = JSON.parse(line) as AssistantStreamEvent
        } catch {
          throw new Error('Kept received an unreadable live response. Please try again.')
        }
        if (event.type === 'delta' && event.delta) {
          setMessages((all) => all.map((message) => message.id === assistantMessageId ? { ...message, text: message.text + event.delta } : message))
        } else if (event.type === 'reset') {
          setMessages((all) => all.map((message) => message.id === assistantMessageId ? { ...message, text: '' } : message))
        } else if (event.type === 'done') {
          data = event.data
          setMessages((all) => all.map((message) => message.id === assistantMessageId ? {
            ...message,
            text: event.data.message,
            itemIds: event.data.itemIds,
            sources: event.data.sources,
            activities: event.data.activities,
            proposedAction: event.data.proposedAction,
            streaming: false,
          } : message))
        } else if (event.type === 'error') {
          throw new Error(event.error || 'Kept couldn’t complete that request.')
        }
      }
      while (true) {
        const { done, value: chunk } = await reader.read()
        buffer += decoder.decode(chunk, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) consume(line)
        if (done) break
      }
      if (buffer.trim()) consume(buffer)
      if (!data) throw new Error('Kept’s live response ended too soon. Please try again.')
      const completed = data
      setConversationId(completed.conversation.id)
      window.localStorage.setItem(storageKey, completed.conversation.id)
      setConversations((all) => [completed.conversation, ...all.filter(({ id }) => id !== completed.conversation.id)])
      void refreshConversations()
      setAttachedIds([]); setDeviceFile(null); setDevicePreview('')
    } catch (nextError) {
      if (controller.signal.aborted) {
        setMessages((all) => all.map((message) => message.id === assistantMessageId ? { ...message, streaming: false, text: message.text || 'Stopped.' } : message))
      } else {
        setMessages((all) => all.filter(({ id }) => id !== assistantMessageId))
        setRetryPrompt(text)
        setError(nextError instanceof Error ? nextError.message : 'Kept couldn’t complete that request.')
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setSending(false)
    }
  }

  const stop = () => abortRef.current?.abort()

  const applied = (messageId: string, result: AssistantActionResult) => {
    if (result.item) onItemUpdated(result.item)
    else if (result.items?.length) onItemsCreated(result.items)
    if (result.deletedItemIds?.length) onItemsDeleted(result.deletedItemIds)
    setMessages((all) => all.map((message) => message.id === messageId ? { ...message, receipt: result.receipt ?? 'Library updated' } : message))
  }

  if (!open) return null
  return (
    <div className="assistant-layer" role="dialog" aria-modal="true" aria-labelledby="assistant-title">
      <button className="assistant-backdrop" onClick={onClose} aria-label="Close Kept assistant" />
      <aside className="assistant-panel">
        <header className="assistant-head">
          <div className="assistant-identity"><span><Sparkles size={17} /></span><div><h2 id="assistant-title">Ask Kept</h2><p><i /> Ready · memory + web</p></div></div>
          <div className="assistant-head-actions">
            <button className={historyOpen ? 'active' : ''} onClick={() => { setHistoryOpen((value) => !value); void refreshConversations() }} aria-label="Chat history" title="Chat history"><History size={17} /></button>
            <button onClick={startNewConversation} aria-label="Start a new chat" title="New chat"><SquarePen size={17} /></button>
            <button className="assistant-close" onClick={onClose} aria-label="Close assistant"><X size={19} /></button>
          </div>
        </header>

        <div className="assistant-scroll" ref={scrollRef}>
          {historyOpen ? (
            <section className="assistant-history" aria-label="Chat history">
              <div className="assistant-history-intro">
                <p className="eyebrow">Saved conversations</p>
                <h3>Pick up where you left off</h3>
                <p>Your chats stay private to your account and can be removed at any time.</p>
                <button onClick={startNewConversation}><SquarePen size={14} /> Start a new chat</button>
              </div>
              {error && <p className="assistant-history-error" role="alert">{error}</p>}
              {historyLoading && !conversations.length ? (
                <div className="assistant-history-loading"><LoaderCircle className="spin" size={18} /> Loading conversations…</div>
              ) : conversations.length ? (
                <div className="assistant-history-list">
                  {conversations.map((conversation) => <article key={conversation.id} className={conversation.id === conversationId ? 'current' : ''}>
                    <button className="assistant-history-open" onClick={() => void loadConversation(conversation.id)} disabled={conversationLoading}>
                      <span><History size={14} /></span>
                      <div><strong>{conversation.title}</strong><p>{conversation.preview}</p><small>{conversationTime(conversation.updatedAt)} · {conversation.messageCount} messages</small></div>
                      <ChevronRight size={15} />
                    </button>
                    <button className="assistant-history-delete" onClick={() => void removeConversation(conversation.id)} aria-label={`Delete ${conversation.title}`} title="Delete conversation"><Trash2 size={13} /></button>
                  </article>)}
                </div>
              ) : (
                <div className="assistant-history-empty"><History size={21} /><strong>No saved conversations yet</strong><p>Your first completed chat will appear here.</p></div>
              )}
            </section>
          ) : conversationLoading ? (
            <div className="assistant-conversation-loading"><LoaderCircle className="spin" size={19} /><span>Opening your conversation…</span></div>
          ) : !messages.length ? (
            <div className="assistant-welcome">
              <div className="assistant-orbit"><Sparkles size={24} /><i /><i /></div>
              <p className="eyebrow">Your library, in conversation</p>
              <h3>{contextItem ? `Explore “${contextItem.title}”` : 'What are you trying to find?'}</h3>
              <p>{contextItem ? 'I’ll use this item and the patterns across your library to find connections, explain it, or discover unusually good matches online.' : 'I can connect things you’ve kept, look beyond your library, and prepare additions, edits, or removals for your approval.'}</p>
              <div className="assistant-capabilities"><span><Library size={14} /> Search memory</span><span><Globe2 size={14} /> Explore the web</span><span><Sparkles size={14} /> Compare visually</span></div>
              <div className="assistant-prompts">
                {contextItem ? <>
                  <button onClick={() => void send('Find exceptional things like this on the web. Use what you know from my Kept library to rank them for my taste, and explain why each fits me.')}><span><Globe2 size={15} /></span><div><strong>Find similar online</strong><small>Personalised by your saved taste</small></div><ChevronRight size={15} /></button>
                  <button onClick={() => void send('Find related items in my own library and explain the strongest connections.')}><span><Library size={15} /></span><div><strong>Connect to my library</strong><small>Surface related memories and themes</small></div><ChevronRight size={15} /></button>
                  <button onClick={() => void send('Tell me what is distinctive about this and why it may have caught my attention.')}><span><Sparkles size={15} /></span><div><strong>Help me see it</strong><small>Visual and contextual interpretation</small></div><ChevronRight size={15} /></button>
                </> : <>
                  <button onClick={() => void send('Find the strongest furniture references in my library')}><span><Library size={15} /></span><div><strong>Find something I saved</strong><small>“My strongest furniture references”</small></div><ChevronRight size={15} /></button>
                  <button onClick={() => void send('Show me surprising connections between my recent items')}><span><Sparkles size={15} /></span><div><strong>Connect the dots</strong><small>Find themes across recent memories</small></div><ChevronRight size={15} /></button>
                  <button onClick={() => setAttachmentOpen(true)}><span><Globe2 size={15} /></span><div><strong>Find something similar</strong><small>Attach an item, then search web or library</small></div><ChevronRight size={15} /></button>
                </>}
              </div>
              <p className="assistant-privacy">Device attachments are used for this conversation only.</p>
            </div>
          ) : (
            <div className="assistant-thread">
              {messages.map((message) => {
                const resultItems = (message.itemIds ?? []).map((id) => items.find((item) => item.id === id)).filter((item): item is MemoryItem => Boolean(item))
                return <article key={message.id} className={`assistant-message ${message.role}`}>
                  {message.role === 'assistant' && <div className="assistant-avatar"><Sparkles size={13} /></div>}
                  <div className="message-body">
                    {message.attachmentLabels?.length ? <div className="message-attachments">{message.attachmentLabels.map((label) => <span key={label}><Paperclip size={11} />{label}</span>)}</div> : null}
                    {message.streaming && !message.text ? <div className="assistant-thinking"><div><span /><span /><span /></div><p>{/similar|like this|for my taste|personal/i.test(messages.at(-2)?.text ?? '') ? 'Using your saved taste to search the web…' : /web|online|internet|net/i.test(messages.at(-2)?.text ?? '') ? 'Searching your memory and the web…' : 'Looking through your memory…'}</p></div> : <p>{message.role === 'assistant' ? formattedMessage(message.text) : message.text}{message.streaming ? <span className="assistant-stream-cursor" aria-hidden="true" /> : null}</p>}
                    {message.activities?.length ? <div className="assistant-activity">{message.activities.map((activity) => <span key={activity}><Check size={11} />{activity}</span>)}</div> : null}
                    {resultItems.length ? <div className="assistant-results">
                      {resultItems.map((item) => <button key={item.id} onClick={() => onOpenItem(item.id)}>{itemThumb(item)}<div><strong>{item.title}</strong><small>{item.space} · {item.kind}</small></div><ChevronRight size={14} /></button>)}
                    </div> : null}
                    {message.sources?.length ? <div className="assistant-discovery"><div className="assistant-discovery-intro"><span><ImageIcon size={15} /></span><div><strong>I also found these visual matches</strong><small>Open one to compare it with what you saved.</small></div></div><div className="assistant-sources">{message.sources.map((source, index) => <SourceCard key={source.url} source={source} fallback={`Result ${index + 1}`} />)}</div></div> : null}
                    {message.proposedAction ? <ActionReview action={message.proposedAction} onApplied={(result) => applied(message.id, result)} /> : null}
                    {message.receipt ? <div className="assistant-receipt"><Check size={13} /><span>{message.receipt}</span></div> : null}
                    {message.role === 'assistant' && !message.streaming && message.id === messages.at(-1)?.id && !message.proposedAction ? <div className="assistant-followups">
                      {message.itemIds?.length ? <button onClick={() => void send('Find the best similar options online, personalised using my wider Kept library.')}><Globe2 size={14} /><span><strong>Find similar online</strong><small>Use these items as the starting point</small></span></button> : null}
                      {message.sources?.length ? <button onClick={() => void send('Compare these web matches and rank them against my saved taste. Explain the most important trade-offs.')}><Sparkles size={14} /><span><strong>Compare these matches</strong><small>Rank their fit and key differences</small></span></button> : null}
                      <button onClick={() => void send(message.sources?.length ? 'Refine this search and find fewer, closer visual matches.' : 'Explore another useful angle and tell me what I may be overlooking.')}><Search size={14} /><span><strong>{message.sources?.length ? 'Find closer matches' : 'Explore another angle'}</strong><small>{message.sources?.length ? 'Narrow the search visually' : 'Surface what I may be overlooking'}</small></span></button>
                    </div> : null}
                  </div>
                </article>
              })}
            </div>
          )}
        </div>

        {!historyOpen && <footer className="assistant-compose">
          {(attachedItems.length > 0 || deviceFile) && <div className="compose-attachments">
            {attachedItems.map((item) => <span key={item.id}>{itemThumb(item)}<em>{item.title}</em><button onClick={() => setAttachedIds((ids) => ids.filter((id) => id !== item.id))} aria-label={`Remove ${item.title}`}><X size={11} /></button></span>)}
            {deviceFile && <span>{devicePreview && <img src={devicePreview} alt="" />}<em>{deviceFile.name}</em><button onClick={() => { setDeviceFile(null); setDevicePreview('') }} aria-label="Remove device attachment"><X size={11} /></button></span>}
          </div>}
          {error && <div className="assistant-error-row" role="alert"><p className="assistant-error">{error}</p>{retryPrompt && <button onClick={() => void send(retryPrompt)}>Try again</button>}</div>}
          <div className="compose-box">
            <textarea ref={inputRef} rows={1} value={value} onChange={(event) => setValue(event.target.value)} onInput={(event) => {
              event.currentTarget.style.height = 'auto'
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 96)}px`
            }} placeholder="Ask about anything you’ve kept…" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} />
            <div className="compose-tools">
              <div className="attach-wrap">
                <button className={attachmentOpen ? 'active' : ''} onClick={() => setAttachmentOpen((value) => !value)} aria-label="Attach something"><Paperclip size={17} /></button>
                {attachmentOpen && <div className="attach-menu"><button onClick={() => { setPickerOpen(true); setAttachmentOpen(false) }}><Library size={15} /><div><strong>From your library</strong><small>Attach up to four saved items</small></div></button><button onClick={() => fileRef.current?.click()}><ImageIcon size={15} /><div><strong>From this device</strong><small>Image · up to 12 MB</small></div></button></div>}
              </div>
              <span>Attach or ask naturally</span>
              {sending ? <button className="send-button stop" onClick={stop} aria-label="Stop response" title="Stop"><Square size={12} fill="currentColor" /></button> : <button className="send-button" onClick={() => void send()} disabled={!value.trim()} aria-label="Send message"><Send size={15} /></button>}
            </div>
          </div>
          <input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => chooseDeviceFile(event.target.files?.[0])} />
          <p className="assistant-disclaimer">Kept can make mistakes. Library changes always require your confirmation.</p>
        </footer>}
      </aside>
      {pickerOpen && <LibraryPicker items={items} selected={attachedIds} onDone={setAttachedIds} onClose={() => setPickerOpen(false)} />}
    </div>
  )
}

export function AssistantButton({ onClick }: { onClick: () => void }) {
  return <button className="assistant-launch" onClick={onClick}><span><Sparkles size={16} /></span><strong>Ask Kept</strong></button>
}
