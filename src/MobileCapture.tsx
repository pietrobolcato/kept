import { useCallback, useEffect, useState } from 'react'
import { Apple, Check, Copy, Download, ExternalLink, LoaderCircle, Send, Share2, Smartphone, Trash2, X } from 'lucide-react'
import { apiFetch } from './lib/api'

type TelegramStatus = {
  enabled: boolean
  botUsername: string | null
  connected: boolean
  connection: { username: string | null; first_name: string | null; created_at: string; last_used_at: string; default_owner_user_id: string | null } | null
  destinations: Array<{ ownerUserId: string; label: string; personal: boolean }>
  destination: { ownerUserId: string; label: string; personal: boolean } | null
}

type ShortcutStatus = {
  enabled: boolean
  connected: boolean
  connections: Array<{ id: string; device_name: string; created_at: string; last_used_at: string | null }>
}

type ShortcutPairing = { runUrl: string; installUrl: string; expiresAt: string }

function compactDate(value: string | null) {
  if (!value) return 'Never used'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(value))
}

export function MobileCaptureDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [deepLink, setDeepLink] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [shortcutStatus, setShortcutStatus] = useState<ShortcutStatus | null>(null)
  const [shortcutPairing, setShortcutPairing] = useState<ShortcutPairing | null>(null)
  const [shortcutLoading, setShortcutLoading] = useState(false)
  const [shortcutError, setShortcutError] = useState('')
  const standalone = window.matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone))

  const refresh = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = await apiFetch('/api/integrations/telegram')
      const data = await response.json() as TelegramStatus & { error?: string }
      if (!response.ok) throw new Error(data.error || 'Could not load phone capture.')
      setStatus(data)
      if (data.connected) setDeepLink('')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not load phone capture.')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshShortcut = useCallback(async () => {
    setShortcutLoading(true); setShortcutError('')
    try {
      const response = await apiFetch('/api/integrations/apple-shortcut')
      const data = await response.json() as ShortcutStatus & { error?: string }
      if (!response.ok) throw new Error(data.error || 'Could not load Apple Shortcut connections.')
      setShortcutStatus(data)
      if (data.connected) setShortcutPairing(null)
    } catch (nextError) {
      setShortcutError(nextError instanceof Error ? nextError.message : 'Could not load Apple Shortcut connections.')
    } finally {
      setShortcutLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) { void refresh(); void refreshShortcut() }
    else { setDeepLink(''); setError(''); setCopied(false); setShortcutPairing(null); setShortcutError('') }
  }, [open, refresh, refreshShortcut])

  useEffect(() => {
    if (!open) return
    const returned = () => { if (document.visibilityState === 'visible') void refreshShortcut() }
    document.addEventListener('visibilitychange', returned)
    window.addEventListener('focus', returned)
    return () => { document.removeEventListener('visibilitychange', returned); window.removeEventListener('focus', returned) }
  }, [open, refreshShortcut])

  const connectShortcut = async () => {
    setShortcutLoading(true); setShortcutError('')
    try {
      const response = await apiFetch('/api/integrations/apple-shortcut/pairing', { method: 'POST' })
      const data = await response.json() as ShortcutPairing & { error?: string }
      if (!response.ok || !data.runUrl) throw new Error(data.error || 'Could not start Shortcut pairing.')
      setShortcutPairing(data)
      window.location.assign(data.runUrl)
    } catch (nextError) {
      setShortcutError(nextError instanceof Error ? nextError.message : 'Could not start Shortcut pairing.')
    } finally {
      setShortcutLoading(false)
    }
  }

  const revokeShortcut = async (connectionId: string) => {
    setShortcutLoading(true); setShortcutError('')
    try {
      const response = await apiFetch(`/api/integrations/apple-shortcut/${connectionId}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error || 'Could not revoke that Shortcut connection.')
      }
      await refreshShortcut()
    } catch (nextError) {
      setShortcutError(nextError instanceof Error ? nextError.message : 'Could not revoke that Shortcut connection.')
      setShortcutLoading(false)
    }
  }

  const pair = async () => {
    setLoading(true); setError('')
    try {
      const response = await apiFetch('/api/integrations/telegram/pairing', { method: 'POST' })
      const data = await response.json() as { deepLink?: string; error?: string }
      if (!response.ok || !data.deepLink) throw new Error(data.error || 'Could not create a Telegram pairing link.')
      setDeepLink(data.deepLink)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not create a Telegram pairing link.')
    } finally {
      setLoading(false)
    }
  }

  const disconnect = async () => {
    setLoading(true); setError('')
    try {
      const response = await apiFetch('/api/integrations/telegram', { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not disconnect Telegram.')
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not disconnect Telegram.')
      setLoading(false)
    }
  }

  const changeDestination = async (ownerUserId: string) => {
    setLoading(true); setError('')
    try {
      const response = await apiFetch('/api/integrations/telegram', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerUserId }),
      })
      const data = await response.json() as Pick<TelegramStatus, 'connection' | 'destination' | 'destinations'> & { error?: string }
      if (!response.ok || !data.destination) throw new Error(data.error || 'Could not change the Telegram destination.')
      setStatus((current) => current ? { ...current, connection: data.connection, destination: data.destination, destinations: data.destinations } : current)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not change the Telegram destination.')
    } finally {
      setLoading(false)
    }
  }

  const copyLink = async () => {
    await navigator.clipboard.writeText(deepLink)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  if (!open) return null
  return <div className="mobile-capture-layer" role="dialog" aria-modal="true" aria-labelledby="mobile-capture-title">
    <button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close phone capture" />
    <section className="mobile-capture-dialog">
      <header>
        <div><p className="eyebrow">Capture anywhere</p><h2 id="mobile-capture-title">Add from your phone</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>

      <div className="mobile-capture-content">
        <article className="capture-channel featured shortcut-channel">
          <div className="capture-channel-icon apple"><Apple size={20} /></div>
          <div className="capture-channel-copy">
            <span className="channel-kicker">Native iPhone share sheet</span>
            <h3>Keep it with one share</h3>
            <p>Install once, connect this device, then share links, photos, videos or text straight from any app. You choose a personal or shared space each time.</p>

            {shortcutLoading && !shortcutStatus ? <div className="capture-channel-status"><LoaderCircle className="spin" size={14} /> Checking connection…</div> : shortcutStatus?.connected ? <>
              <div className="capture-channel-status connected"><Check size={14} /> Apple Shortcut connected</div>
              <div className="shortcut-connections">
                {shortcutStatus.connections.map((connection) => <div className="shortcut-connection" key={connection.id}>
                  <span><strong>{connection.device_name}</strong><small>{connection.last_used_at ? `Last used ${compactDate(connection.last_used_at)}` : `Connected ${compactDate(connection.created_at)}`}</small></span>
                  <button type="button" onClick={() => void revokeShortcut(connection.id)} disabled={shortcutLoading} aria-label={`Revoke ${connection.device_name}`}><Trash2 size={14} /></button>
                </div>)}
              </div>
              <div className="shortcut-actions">
                <a className="secondary-button" href="/downloads/Keep-in-Kept.shortcut"><Download size={14} /> Install again</a>
                <button type="button" className="text-button" onClick={() => void connectShortcut()} disabled={shortcutLoading}>Reconnect</button>
              </div>
            </> : shortcutStatus?.enabled ? <>
              <div className="shortcut-steps">
                <div><i>1</i><span><strong>Install</strong><small>Apple asks you to confirm Add Shortcut.</small></span></div>
                <div><i>2</i><span><strong>Connect</strong><small>Pairs it securely with this Kept account.</small></span></div>
              </div>
              <div className="shortcut-actions">
                <a className="primary-button" href="/downloads/Keep-in-Kept.shortcut"><Download size={14} /> Install Shortcut</a>
                <button type="button" className="secondary-button" onClick={() => void connectShortcut()} disabled={shortcutLoading}>{shortcutLoading ? <LoaderCircle className="spin" size={14} /> : <Apple size={14} />} Connect</button>
              </div>
              {shortcutPairing && <p className="shortcut-return">If Shortcuts did not open, <a href={shortcutPairing.runUrl}>tap here to continue pairing</a>. The connection link expires in 10 minutes.</p>}
            </> : <div className="capture-channel-status pending">Apple Shortcut capture needs service access configured on this Kept server.</div>}
            {shortcutError && <p className="form-error" role="alert">{shortcutError}</p>}
          </div>
        </article>

        <article className="capture-channel featured">
          <div className="capture-channel-icon telegram"><Send size={19} /></div>
          <div className="capture-channel-copy">
            <span className="channel-kicker">Fastest from any app</span>
            <h3>Send it to Kept on Telegram</h3>
            <p>Share a webpage to Telegram, choose your Kept chat, and it will be read, filed and indexed automatically.</p>
            {loading && !status ? <div className="capture-channel-status"><LoaderCircle className="spin" size={14} /> Checking connection…</div> : status?.connected ? <>
              <div className="capture-channel-status connected"><Check size={14} /> Connected as {status.connection?.username ? `@${status.connection.username}` : status.connection?.first_name || 'Telegram user'}</div>
              <label className="telegram-destination">Save new items to
                <select value={status.destination?.ownerUserId ?? ''} onChange={(event) => void changeDestination(event.target.value)} disabled={loading}>
                  {status.destinations.map((destination) => <option key={destination.ownerUserId} value={destination.ownerUserId}>{destination.label}</option>)}
                </select>
                <small>The bot remembers this choice. You can also send <strong>/destination</strong> in Telegram.</small>
              </label>
              <button type="button" className="text-button danger" onClick={() => void disconnect()} disabled={loading}>Disconnect</button>
            </> : deepLink ? <div className="telegram-pairing">
              <a className="primary-button" href={deepLink} target="_blank" rel="noreferrer">Open Telegram <ExternalLink size={14} /></a>
              <button type="button" className="secondary-button" onClick={() => void copyLink()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy link'}</button>
              <p>Tap <strong>Start</strong> in Telegram. This private link expires in 10 minutes and works once.</p>
              <button type="button" className="text-button" onClick={() => void refresh()}>I’ve connected it</button>
            </div> : status?.enabled ? <button type="button" className="primary-button" onClick={() => void pair()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />} Connect Telegram</button> : <div className="capture-channel-status pending">Telegram is ready in the app; the bot token still needs to be connected on the server.</div>}
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
        </article>

        <article className="capture-channel">
          <div className="capture-channel-icon"><Smartphone size={19} /></div>
          <div className="capture-channel-copy">
            <span className="channel-kicker">Feels like an app</span>
            <h3>{standalone ? 'Kept is installed' : 'Add Kept to your Home Screen'}</h3>
            {standalone ? <p>Kept is running as a standalone web app. Capture is always one tap away.</p> : <ol><li>Open Kept in Safari.</li><li>Tap <Share2 size={13} /> <strong>Share</strong>.</li><li>Choose <strong>Add to Home Screen</strong>, then enable <strong>Open as Web App</strong>.</li></ol>}
          </div>
        </article>

        <div className="direct-share-note"><Share2 size={16} /><p><strong>Two good ways to capture.</strong> Use the Apple Shortcut when you want to choose the destination in the moment. Use Telegram when you prefer sending quickly to a remembered default.</p></div>
      </div>
    </section>
  </div>
}
