import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Copy, Link2, LoaderCircle, LockKeyhole, Share2, Trash2, UserRoundPlus, Users, X } from 'lucide-react'
import { apiFetch } from './lib/api'
import './space-sharing.css'

export type SpacePermissions = {
  canAdd: boolean
  canEdit: boolean
  canDelete: boolean
}

export type SharedSpace = {
  ownerUserId: string
  name: string
  permissions: SpacePermissions
  library?: boolean
  ownerLabel?: string
}

type Collaborator = {
  id: string
  label: string
  permissions: SpacePermissions
  joinedAt: string
}

type Invitation = {
  id: string
  permissions: SpacePermissions
  expiresAt: string
}

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const raw = await response.text()
  let result: { error?: string } & T
  try {
    result = raw ? JSON.parse(raw) as { error?: string } & T : {} as { error?: string } & T
  } catch {
    throw new Error(fallback)
  }
  if (!response.ok) throw new Error(result.error || fallback)
  return result
}

function permissionLabel(value: SpacePermissions) {
  if (value.canAdd && value.canEdit && value.canDelete) return 'Full editor'
  const capabilities = [value.canAdd && 'add', value.canEdit && 'edit', value.canDelete && 'delete'].filter(Boolean)
  return capabilities.length ? `Can ${capabilities.join(', ')}` : 'View only'
}

function PermissionControls({ value, onChange, disabled = false }: {
  value: SpacePermissions
  onChange: (next: SpacePermissions) => void
  disabled?: boolean
}) {
  const options: Array<[keyof SpacePermissions, string]> = [
    ['canAdd', 'Add'],
    ['canEdit', 'Edit'],
    ['canDelete', 'Delete'],
  ]
  return (
    <div className="share-permissions" aria-label="Access permissions">
      {options.map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={value[key]}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, [key]: event.target.checked })}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  )
}

function ShareAccessDialog({ open, onClose, spaceName, currentUserId, scope }: {
  open: boolean
  onClose: () => void
  spaceName: string
  currentUserId: string
  scope: 'space' | 'library'
}) {
  const wholeLibrary = scope === 'library'
  const [members, setMembers] = useState<Collaborator[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [nextPermissions, setNextPermissions] = useState<SpacePermissions>({ canAdd: true, canEdit: true, canDelete: true })
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [generatedLink, setGeneratedLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!open || (!spaceName && !wholeLibrary)) return
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch(wholeLibrary ? '/api/library/sharing' : `/api/spaces/${currentUserId}/${encodeURIComponent(spaceName)}/sharing`)
      const data = await responseJson<{ members: Collaborator[]; invitations: Invitation[] }>(response, 'Sharing details could not be loaded.')
      setMembers(data.members)
      setInvitations(data.invitations)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sharing details could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [currentUserId, open, spaceName, wholeLibrary])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!open) {
      setGeneratedLink('')
      setCopied(false)
      setError('')
    }
  }, [open])

  const generate = async () => {
    setCreating(true)
    setError('')
    try {
      const response = await apiFetch(wholeLibrary ? '/api/library/invitations' : `/api/spaces/${encodeURIComponent(spaceName)}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: nextPermissions, expiresInDays: 7 }),
      })
      const data = await responseJson<{ invitation: Invitation; token: string }>(response, 'An invitation could not be created.')
      const url = new URL(window.location.href)
      url.search = ''
      url.hash = ''
      url.searchParams.set(wholeLibrary ? 'libraryInvite' : 'invite', data.token)
      setGeneratedLink(url.toString())
      setInvitations((current) => [data.invitation, ...current])
      setCopied(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'An invitation could not be created.')
    } finally {
      setCreating(false)
    }
  }

  const copy = async () => {
    if (!generatedLink) return
    await navigator.clipboard.writeText(generatedLink)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  const updateMember = async (member: Collaborator, next: SpacePermissions) => {
    const previous = members
    setMembers((current) => current.map((entry) => entry.id === member.id ? { ...entry, permissions: next } : entry))
    setError('')
    try {
      const response = await apiFetch(wholeLibrary ? `/api/library/members/${member.id}` : `/api/spaces/${encodeURIComponent(spaceName)}/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: next }),
      })
      await responseJson(response, 'Permissions could not be updated.')
    } catch (cause) {
      setMembers(previous)
      setError(cause instanceof Error ? cause.message : 'Permissions could not be updated.')
    }
  }

  const removeMember = async (member: Collaborator) => {
    setError('')
    try {
      const response = await apiFetch(wholeLibrary ? `/api/library/members/${member.id}` : `/api/spaces/${encodeURIComponent(spaceName)}/members/${member.id}`, { method: 'DELETE' })
      if (!response.ok) await responseJson(response, 'That collaborator could not be removed.')
      setMembers((current) => current.filter((entry) => entry.id !== member.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That collaborator could not be removed.')
    }
  }

  const revoke = async (invitation: Invitation) => {
    setError('')
    try {
      const response = await apiFetch(wholeLibrary ? `/api/library-invitations/${invitation.id}` : `/api/space-invitations/${invitation.id}`, { method: 'DELETE' })
      if (!response.ok) await responseJson(response, 'That invitation could not be revoked.')
      setInvitations((current) => current.filter((entry) => entry.id !== invitation.id))
      setGeneratedLink('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That invitation could not be revoked.')
    }
  }

  if (!open) return null
  return (
    <div className="share-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
        <header className="share-dialog-head">
          <div className="share-dialog-mark"><Share2 size={19} /></div>
          <div><p>Personal space</p><h2 id="share-dialog-title">{wholeLibrary ? 'Share your whole library' : `Share “${spaceName}”`}</h2></div>
          <button onClick={onClose} aria-label="Close sharing"><X size={19} /></button>
        </header>

        <div className="share-dialog-body">
          <div className="share-security-note"><LockKeyhole size={15} /><span>{wholeLibrary ? 'This includes every current and future space. ' : ''}Anyone with a fresh link can accept it once. Links expire after 7 days.</span></div>

          <section className="share-invite-builder">
            <div className="share-section-title"><div><h3>Invite with a link</h3><p>Choose exactly what this person may do.</p></div></div>
            <PermissionControls value={nextPermissions} onChange={setNextPermissions} />
            {generatedLink ? (
              <div className="share-generated-link">
                <Link2 size={16} />
                <input readOnly value={generatedLink} aria-label="Invitation link" />
                <button onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied' : 'Copy'}</button>
              </div>
            ) : (
              <button className="share-primary-button" onClick={() => void generate()} disabled={creating}>
                {creating ? <LoaderCircle className="spin" size={16} /> : <UserRoundPlus size={16} />}
                Create invitation link
              </button>
            )}
          </section>

          {error && <p className="share-error" role="alert">{error}</p>}

          <section className="share-people-section">
            <div className="share-section-title">
              <div><h3>People with access</h3><p>{members.length ? `${members.length} collaborator${members.length === 1 ? '' : 's'}` : 'Only you for now'}</p></div>
              <Users size={17} />
            </div>
            {loading ? <div className="share-loading"><LoaderCircle className="spin" size={18} /> Loading access…</div> : members.map((member) => (
              <div className="share-member" key={member.id}>
                <div className="share-avatar">{member.label.slice(0, 2).toUpperCase()}</div>
                <div className="share-member-copy"><strong>{member.label}</strong><span>{permissionLabel(member.permissions)}</span></div>
                <PermissionControls value={member.permissions} onChange={(next) => void updateMember(member, next)} />
                <button className="share-remove" onClick={() => void removeMember(member)} aria-label={`Remove ${member.label}`}><Trash2 size={15} /></button>
              </div>
            ))}
          </section>

          {invitations.length > 0 && (
            <section className="share-pending-section">
              <div className="share-section-title"><div><h3>Pending links</h3><p>Revoke links you no longer want used.</p></div></div>
              {invitations.map((invitation) => (
                <div className="share-pending" key={invitation.id}>
                  <Link2 size={15} /><span>{permissionLabel(invitation.permissions)} · expires {new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(new Date(invitation.expiresAt))}</span>
                  <button onClick={() => void revoke(invitation)}>Revoke</button>
                </div>
              ))}
            </section>
          )}
        </div>
      </section>
    </div>
  )
}

export function ShareSpaceDialog(props: { open: boolean; onClose: () => void; spaceName: string; currentUserId: string }) {
  return <ShareAccessDialog {...props} scope="space" />
}

export function ShareLibraryDialog({ open, onClose, currentUserId }: { open: boolean; onClose: () => void; currentUserId: string }) {
  return <ShareAccessDialog open={open} onClose={onClose} currentUserId={currentUserId} spaceName="" scope="library" />
}

export function SpaceInvitationGate({ onAccepted, onLibraryAccepted }: { onAccepted: (space: SharedSpace) => void; onLibraryAccepted: (library: { ownerUserId: string; permissions: SpacePermissions }) => void }) {
  const invitation = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const libraryToken = params.get('libraryInvite')
    return libraryToken ? { token: libraryToken, scope: 'library' as const } : params.get('invite') ? { token: params.get('invite')!, scope: 'space' as const } : undefined
  }, [])
  const token = invitation?.token
  const wholeLibrary = invitation?.scope === 'library'
  const [preview, setPreview] = useState<{ spaceName?: string; permissions: SpacePermissions; expiresAt: string }>()
  const [loading, setLoading] = useState(Boolean(token))
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token) return
    void (async () => {
      try {
        const response = await apiFetch(wholeLibrary ? `/api/library-invitations/preview/${encodeURIComponent(token)}` : `/api/space-invitations/preview/${encodeURIComponent(token)}`)
        const result = await responseJson<{ invitation: { spaceName?: string; permissions: SpacePermissions; expiresAt: string } }>(response, 'That invitation could not be opened.')
        setPreview(result.invitation)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'That invitation could not be opened.')
      } finally {
        setLoading(false)
      }
    })()
  }, [token, wholeLibrary])

  const close = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('invite')
    url.searchParams.delete('libraryInvite')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    setPreview(undefined)
    setError('')
  }

  const accept = async () => {
    if (!token) return
    setAccepting(true)
    setError('')
    try {
      const response = await apiFetch(wholeLibrary ? `/api/library-invitations/${encodeURIComponent(token)}/accept` : `/api/space-invitations/${encodeURIComponent(token)}/accept`, { method: 'POST' })
      const result = await responseJson<{ space?: SharedSpace; library?: { ownerUserId: string; permissions: SpacePermissions } }>(response, 'That invitation could not be accepted.')
      close()
      if (wholeLibrary && result.library) onLibraryAccepted(result.library)
      else if (result.space) onAccepted(result.space)
      else throw new Error('That invitation did not return access details.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That invitation could not be accepted.')
    } finally {
      setAccepting(false)
    }
  }

  if (!token) return null
  return (
    <div className="share-modal-backdrop invite-gate-backdrop">
      <section className="share-dialog invite-gate" role="dialog" aria-modal="true" aria-labelledby="invite-gate-title">
        <button className="invite-gate-close" onClick={close} aria-label="Close invitation"><X size={18} /></button>
        <div className="invite-gate-icon">{loading ? <LoaderCircle className="spin" size={24} /> : <Users size={24} />}</div>
        {loading ? <><h2 id="invite-gate-title">Opening invitation…</h2><p>Checking that this private link is still valid.</p></> : preview ? (
          <>
            <p className="invite-eyebrow">You’re invited</p>
            <h2 id="invite-gate-title">{wholeLibrary ? 'Join this Kept library' : `Join “${preview.spaceName}”`}</h2>
            <p>You’ll be able to browse everything in {wholeLibrary ? 'all current and future spaces' : 'this space'}. <strong>{permissionLabel(preview.permissions)}.</strong></p>
            <div className="invite-permission-summary">
              <Check size={15} /> View saved items
              {preview.permissions.canAdd && <><Check size={15} /> Add new items</>}
              {preview.permissions.canEdit && <><Check size={15} /> Edit items</>}
              {preview.permissions.canDelete && <><Check size={15} /> Delete items</>}
            </div>
            <button className="share-primary-button" onClick={() => void accept()} disabled={accepting}>
              {accepting ? <LoaderCircle className="spin" size={17} /> : <Users size={17} />}
              {wholeLibrary ? 'Accept and open library' : 'Accept and open space'}
            </button>
          </>
        ) : <><h2 id="invite-gate-title">Invitation unavailable</h2><p>{error || 'This link may have expired or already been used.'}</p></>}
        {error && preview && <p className="share-error" role="alert">{error}</p>}
      </section>
    </div>
  )
}
