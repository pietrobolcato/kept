import { createHash, randomBytes } from 'node:crypto'
import { Router, type Response } from 'express'
import { createServiceClient, type AuthContext } from './supabase.js'

type Permissions = {
  canAdd: boolean
  canEdit: boolean
  canDelete: boolean
}

interface MemberRow {
  owner_user_id: string
  space_name: string
  member_user_id: string
  member_label: string
  can_add: boolean
  can_edit: boolean
  can_delete: boolean
  created_at: string
}

interface InvitationRow {
  id: string
  space_name: string
  can_add: boolean
  can_edit: boolean
  can_delete: boolean
  expires_at: string
  revoked_at: string | null
  accepted_at: string | null
  created_at: string
}

interface LibraryMemberRow {
  owner_user_id: string
  member_user_id: string
  member_label: string
  can_add: boolean
  can_edit: boolean
  can_delete: boolean
  created_at: string
}

interface LibraryInvitationRow {
  id: string
  can_add: boolean
  can_edit: boolean
  can_delete: boolean
  expires_at: string
  revoked_at: string | null
  accepted_at: string | null
  created_at: string
}

function auth(response: Response) {
  return response.locals.auth as AuthContext
}

function permissions(row: { can_add: boolean; can_edit: boolean; can_delete: boolean }): Permissions {
  return { canAdd: row.can_add, canEdit: row.can_edit, canDelete: row.can_delete }
}

function parsePermissions(input: unknown): Permissions {
  if (!input || typeof input !== 'object') return { canAdd: false, canEdit: false, canDelete: false }
  const source = input as Record<string, unknown>
  return {
    canAdd: source.canAdd === true,
    canEdit: source.canEdit === true,
    canDelete: source.canDelete === true,
  }
}

function memberJson(row: MemberRow) {
  return {
    id: row.member_user_id,
    label: row.member_label,
    spaceName: row.space_name,
    permissions: permissions(row),
    joinedAt: row.created_at,
  }
}

function invitationJson(row: InvitationRow) {
  return {
    id: row.id,
    spaceName: row.space_name,
    permissions: permissions(row),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
  }
}

function libraryMemberJson(row: LibraryMemberRow) {
  return { id: row.member_user_id, label: row.member_label, permissions: permissions(row), joinedAt: row.created_at }
}

function libraryInvitationJson(row: LibraryInvitationRow) {
  return { id: row.id, permissions: permissions(row), expiresAt: row.expires_at, revokedAt: row.revoked_at, acceptedAt: row.accepted_at, createdAt: row.created_at }
}

function validToken(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,180}$/.test(value) ? value : undefined
}

function report(response: Response, error: unknown, fallback: string, status = 503) {
  const message = error instanceof Error ? error.message : 'Unknown error'
  console.warn(`${fallback}:`, message)
  if (/jwt.*(?:future|expired|invalid)|issued at future/i.test(message)) {
    return response.status(401).json({ error: 'Your session needs to be refreshed.' })
  }
  response.status(status).json({ error: error instanceof Error ? error.message : fallback })
}

const ownerLabelCache = new Map<string, { label: string; expiresAt: number }>()

async function sharedOwnerLabels(ownerIds: string[]) {
  const uniqueIds = [...new Set(ownerIds)]
  const labels = new Map<string, string>()
  const missing: string[] = []
  for (const id of uniqueIds) {
    const cached = ownerLabelCache.get(id)
    if (cached && cached.expiresAt > Date.now()) labels.set(id, cached.label)
    else missing.push(id)
  }
  if (missing.length) {
    try {
      const service = createServiceClient()
      await Promise.all(missing.map(async (id) => {
        const { data } = await service.auth.admin.getUserById(id)
        const metadata = data.user?.user_metadata as { full_name?: unknown; name?: unknown } | undefined
        const profileName = typeof metadata?.full_name === 'string' ? metadata.full_name : typeof metadata?.name === 'string' ? metadata.name : undefined
        const label = profileName?.trim() || data.user?.email || 'Shared library'
        labels.set(id, label)
        ownerLabelCache.set(id, { label, expiresAt: Date.now() + 15 * 60_000 })
      }))
    } catch {
      // Sharing still works when an owner label cannot be enriched.
    }
  }
  return labels
}

/** Mount after Kept's /api authentication middleware. */
export function createSharingRouter() {
  const router = Router()

  router.get('/shared-spaces', async (_request, response) => {
    try {
      const { client, user } = auth(response)
      const query = () => client.from('space_members')
          .select('owner_user_id,space_name,member_user_id,member_label,can_add,can_edit,can_delete,created_at')
          .eq('member_user_id', user.id)
          .order('created_at', { ascending: false })
      let { data, error } = await query()
      if (error && /jwt.*(?:future|expired|invalid)|issued at future/i.test(error.message)) {
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        const retried = await query()
        data = retried.data
        error = retried.error
      }
      if (error) throw new Error(`Could not load shared spaces: ${error.message}`)
      const { data: libraryData, error: libraryError } = await client.from('library_members')
        .select('owner_user_id,member_user_id,member_label,can_add,can_edit,can_delete,created_at')
        .eq('member_user_id', user.id)
      if (libraryError) throw new Error(`Could not load shared libraries: ${libraryError.message}`)
      const libraryRows = (libraryData ?? []) as LibraryMemberRow[]
      const { data: librarySpaces, error: librarySpacesError } = libraryRows.length
        ? await client.from('spaces').select('user_id,name').in('user_id', libraryRows.map((row) => row.owner_user_id))
        : { data: [], error: null }
      if (librarySpacesError) throw new Error(`Could not load shared library spaces: ${librarySpacesError.message}`)
      const directSpaces = ((data ?? []) as MemberRow[]).map((row) => ({
          ownerUserId: row.owner_user_id,
          name: row.space_name,
          permissions: permissions(row),
          joinedAt: row.created_at,
          library: false,
        }))
      const wholeLibraries = libraryRows.flatMap((membership) => ((librarySpaces ?? []) as Array<{ user_id: string; name: string }>)
        .filter((space) => space.user_id === membership.owner_user_id)
        .map((space) => ({ ownerUserId: membership.owner_user_id, name: space.name, permissions: permissions(membership), joinedAt: membership.created_at, library: true })))
      const combined = new Map([...wholeLibraries, ...directSpaces].map((space) => [`${space.ownerUserId}:${space.name}`, space]))
      const ownerLabels = await sharedOwnerLabels([...combined.values()].map((space) => space.ownerUserId))
      response.json({ spaces: [...combined.values()].map((space) => ({ ...space, ownerLabel: ownerLabels.get(space.ownerUserId) })) })
    } catch (error) {
      report(response, error, 'Shared spaces are temporarily unavailable.')
    }
  })

  router.get('/library/sharing', async (_request, response) => {
    try {
      const { client, user } = auth(response)
      const [membersResult, invitationsResult] = await Promise.all([
        client.from('library_members').select('owner_user_id,member_user_id,member_label,can_add,can_edit,can_delete,created_at')
          .eq('owner_user_id', user.id).order('created_at', { ascending: true }),
        client.from('library_invitations').select('id,can_add,can_edit,can_delete,expires_at,revoked_at,accepted_at,created_at')
          .eq('owner_user_id', user.id).is('revoked_at', null).is('accepted_at', null).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }),
      ])
      if (membersResult.error) throw new Error(`Could not load library collaborators: ${membersResult.error.message}`)
      if (invitationsResult.error) throw new Error(`Could not load library invitations: ${invitationsResult.error.message}`)
      response.json({
        members: ((membersResult.data ?? []) as LibraryMemberRow[]).map(libraryMemberJson),
        invitations: ((invitationsResult.data ?? []) as LibraryInvitationRow[]).map(libraryInvitationJson),
      })
    } catch (error) {
      report(response, error, 'Library sharing details are temporarily unavailable.')
    }
  })

  router.post('/library/invitations', async (request, response) => {
    try {
      const { client, user } = auth(response)
      const parsed = parsePermissions(request.body?.permissions)
      const days = Math.min(Math.max(Number(request.body?.expiresInDays) || 7, 1), 30)
      const token = randomBytes(32).toString('base64url')
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const { data, error } = await client.from('library_invitations').insert({
        owner_user_id: user.id, token_hash: tokenHash,
        can_add: parsed.canAdd, can_edit: parsed.canEdit, can_delete: parsed.canDelete,
        expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      }).select('id,can_add,can_edit,can_delete,expires_at,revoked_at,accepted_at,created_at').single()
      if (error) throw new Error(`Could not create a library invitation: ${error.message}`)
      response.status(201).json({ invitation: libraryInvitationJson(data as LibraryInvitationRow), token })
    } catch (error) {
      report(response, error, 'That library invitation could not be created.')
    }
  })

  router.delete('/library-invitations/:id', async (request, response) => {
    try {
      const { client, user } = auth(response)
      const { data, error } = await client.from('library_invitations').update({ revoked_at: new Date().toISOString() })
        .eq('id', request.params.id).eq('owner_user_id', user.id).select('id').maybeSingle()
      if (error) throw new Error(`Could not revoke that library invitation: ${error.message}`)
      if (!data) return response.status(404).json({ error: 'That invitation no longer exists.' })
      response.status(204).end()
    } catch (error) { report(response, error, 'That library invitation could not be revoked.') }
  })

  router.patch('/library/members/:memberUserId', async (request, response) => {
    try {
      const { client, user } = auth(response)
      const next = parsePermissions(request.body?.permissions)
      const { data, error } = await client.from('library_members').update({
        can_add: next.canAdd, can_edit: next.canEdit, can_delete: next.canDelete, updated_at: new Date().toISOString(),
      }).eq('owner_user_id', user.id).eq('member_user_id', request.params.memberUserId)
        .select('owner_user_id,member_user_id,member_label,can_add,can_edit,can_delete,created_at').maybeSingle()
      if (error) throw new Error(`Could not update library permissions: ${error.message}`)
      if (!data) return response.status(404).json({ error: 'That collaborator no longer has access.' })
      response.json({ member: libraryMemberJson(data as LibraryMemberRow) })
    } catch (error) { report(response, error, 'Those library permissions could not be updated.') }
  })

  router.delete('/library/members/:memberUserId', async (request, response) => {
    try {
      const { client, user } = auth(response)
      const { data, error } = await client.from('library_members').delete().eq('owner_user_id', user.id)
        .eq('member_user_id', request.params.memberUserId).select('member_user_id').maybeSingle()
      if (error) throw new Error(`Could not remove that library collaborator: ${error.message}`)
      if (!data) return response.status(404).json({ error: 'That collaborator no longer has access.' })
      response.status(204).end()
    } catch (error) { report(response, error, 'That library collaborator could not be removed.') }
  })

  router.get('/spaces/:ownerUserId/:spaceName/sharing', async (request, response) => {
    try {
      const { client } = auth(response)
      const ownerUserId = request.params.ownerUserId
      const spaceName = request.params.spaceName.slice(0, 80)
      const [membersResult, invitationsResult] = await Promise.all([
        client.from('space_members')
          .select('owner_user_id,space_name,member_user_id,member_label,can_add,can_edit,can_delete,created_at')
          .eq('owner_user_id', ownerUserId).eq('space_name', spaceName)
          .order('created_at', { ascending: true }),
        client.from('space_invitations')
          .select('id,space_name,can_add,can_edit,can_delete,expires_at,revoked_at,accepted_at,created_at')
          .eq('owner_user_id', ownerUserId).eq('space_name', spaceName)
          .is('revoked_at', null).is('accepted_at', null)
          .gt('expires_at', new Date().toISOString())
          .order('created_at', { ascending: false }),
      ])
      if (membersResult.error) throw new Error(`Could not load collaborators: ${membersResult.error.message}`)
      if (invitationsResult.error) throw new Error(`Could not load invitations: ${invitationsResult.error.message}`)
      response.json({
        ownerUserId,
        spaceName,
        members: ((membersResult.data ?? []) as MemberRow[]).map(memberJson),
        invitations: ((invitationsResult.data ?? []) as InvitationRow[]).map(invitationJson),
      })
    } catch (error) {
      report(response, error, 'Sharing details are temporarily unavailable.')
    }
  })

  router.post('/spaces/:spaceName/invitations', async (request, response) => {
    try {
      const { client, user } = auth(response)
      const spaceName = request.params.spaceName.trim().slice(0, 80)
      const { data: ownedSpace, error: spaceError } = await client.from('spaces')
        .select('name').eq('user_id', user.id).eq('name', spaceName).maybeSingle()
      if (spaceError) throw new Error(`Could not verify that space: ${spaceError.message}`)
      if (!ownedSpace) return response.status(404).json({ error: 'Only the space owner can create an invitation.' })

      const parsed = parsePermissions(request.body?.permissions)
      const days = Math.min(Math.max(Number(request.body?.expiresInDays) || 7, 1), 30)
      const token = randomBytes(32).toString('base64url')
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const { data, error } = await client.from('space_invitations').insert({
        owner_user_id: user.id,
        space_name: spaceName,
        token_hash: tokenHash,
        can_add: parsed.canAdd,
        can_edit: parsed.canEdit,
        can_delete: parsed.canDelete,
        expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      }).select('id,space_name,can_add,can_edit,can_delete,expires_at,revoked_at,accepted_at,created_at').single()
      if (error) throw new Error(`Could not create an invitation: ${error.message}`)
      response.status(201).json({ invitation: invitationJson(data as InvitationRow), token })
    } catch (error) {
      report(response, error, 'That invitation could not be created.')
    }
  })

  router.delete('/space-invitations/:id', async (request, response) => {
    try {
      const { client, user } = auth(response)
      const { data, error } = await client.from('space_invitations')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', request.params.id).eq('owner_user_id', user.id)
        .select('id').maybeSingle()
      if (error) throw new Error(`Could not revoke that invitation: ${error.message}`)
      if (!data) return response.status(404).json({ error: 'That invitation no longer exists.' })
      response.status(204).end()
    } catch (error) {
      report(response, error, 'That invitation could not be revoked.')
    }
  })

  router.patch('/spaces/:spaceName/members/:memberUserId', async (request, response) => {
    try {
      const { client, user } = auth(response)
      const next = parsePermissions(request.body?.permissions)
      const { data, error } = await client.from('space_members').update({
        can_add: next.canAdd,
        can_edit: next.canEdit,
        can_delete: next.canDelete,
        updated_at: new Date().toISOString(),
      }).eq('owner_user_id', user.id)
        .eq('space_name', request.params.spaceName.slice(0, 80))
        .eq('member_user_id', request.params.memberUserId)
        .select('owner_user_id,space_name,member_user_id,member_label,can_add,can_edit,can_delete,created_at')
        .maybeSingle()
      if (error) throw new Error(`Could not update permissions: ${error.message}`)
      if (!data) return response.status(404).json({ error: 'That collaborator no longer has access.' })
      response.json({ member: memberJson(data as MemberRow) })
    } catch (error) {
      report(response, error, 'Those permissions could not be updated.')
    }
  })

  router.delete('/spaces/:spaceName/members/:memberUserId', async (request, response) => {
    try {
      const { client, user } = auth(response)
      const { data, error } = await client.from('space_members').delete()
        .eq('owner_user_id', user.id)
        .eq('space_name', request.params.spaceName.slice(0, 80))
        .eq('member_user_id', request.params.memberUserId)
        .select('member_user_id').maybeSingle()
      if (error) throw new Error(`Could not remove that collaborator: ${error.message}`)
      if (!data) return response.status(404).json({ error: 'That collaborator no longer has access.' })
      response.status(204).end()
    } catch (error) {
      report(response, error, 'That collaborator could not be removed.')
    }
  })

  router.delete('/shared-spaces/:ownerUserId/:spaceName', async (request, response) => {
    try {
      const { client, user } = auth(response)
      const { data, error } = await client.from('space_members').delete()
        .eq('owner_user_id', request.params.ownerUserId)
        .eq('space_name', request.params.spaceName.slice(0, 80))
        .eq('member_user_id', user.id)
        .select('member_user_id').maybeSingle()
      if (error) throw new Error(`Could not leave that space: ${error.message}`)
      if (!data) return response.status(404).json({ error: 'You no longer have access to that space.' })
      response.status(204).end()
    } catch (error) {
      report(response, error, 'That shared space could not be left.')
    }
  })

  router.get('/space-invitations/preview/:token', async (request, response) => {
    const token = validToken(request.params.token)
    if (!token) return response.status(404).json({ error: 'That invitation link is invalid.' })
    try {
      const { client } = auth(response)
      const { data, error } = await client.rpc('preview_space_invitation', { p_token: token })
      if (error) throw new Error(error.message)
      const invitation = Array.isArray(data) ? data[0] : undefined
      if (!invitation) return response.status(410).json({ error: 'This invitation is invalid, expired, or has already been used.' })
      response.json({
        invitation: {
          id: invitation.invitation_id,
          spaceName: invitation.space_name,
          permissions: permissions(invitation),
          expiresAt: invitation.expires_at,
        },
      })
    } catch (error) {
      report(response, error, 'That invitation could not be opened.', 400)
    }
  })

  router.post('/space-invitations/:token/accept', async (request, response) => {
    const token = validToken(request.params.token)
    if (!token) return response.status(404).json({ error: 'That invitation link is invalid.' })
    try {
      const { client } = auth(response)
      const { data, error } = await client.rpc('accept_space_invitation', { p_token: token })
      if (error) throw new Error(error.message)
      const membership = Array.isArray(data) ? data[0] : undefined
      if (!membership) return response.status(410).json({ error: 'This invitation is invalid, expired, or has already been used.' })
      response.json({
        space: {
          ownerUserId: membership.owner_user_id,
          name: membership.space_name,
          permissions: permissions(membership),
        },
      })
    } catch (error) {
      report(response, error, 'That invitation could not be accepted.', 400)
    }
  })

  router.get('/library-invitations/preview/:token', async (request, response) => {
    const token = validToken(request.params.token)
    if (!token) return response.status(404).json({ error: 'That invitation link is invalid.' })
    try {
      const { client } = auth(response)
      const { data, error } = await client.rpc('preview_library_invitation', { p_token: token })
      if (error) throw new Error(error.message)
      const invitation = Array.isArray(data) ? data[0] : undefined
      if (!invitation) return response.status(410).json({ error: 'This invitation is invalid, expired, or has already been used.' })
      response.json({ invitation: { permissions: permissions(invitation), expiresAt: invitation.expires_at } })
    } catch (error) { report(response, error, 'That library invitation could not be opened.', 400) }
  })

  router.post('/library-invitations/:token/accept', async (request, response) => {
    const token = validToken(request.params.token)
    if (!token) return response.status(404).json({ error: 'That invitation link is invalid.' })
    try {
      const { client } = auth(response)
      const { data, error } = await client.rpc('accept_library_invitation', { p_token: token })
      if (error) throw new Error(error.message)
      const membership = Array.isArray(data) ? data[0] : undefined
      if (!membership) return response.status(410).json({ error: 'This invitation is invalid, expired, or has already been used.' })
      response.json({ library: { ownerUserId: membership.owner_user_id, permissions: permissions(membership) } })
    } catch (error) { report(response, error, 'That library invitation could not be accepted.', 400) }
  })

  return router
}
