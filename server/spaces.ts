import type { SupabaseClient } from '@supabase/supabase-js'

type SpaceRow = {
  id: string
  user_id: string
  name: string
  color: string
  description: string
  position: number
  created_at: string
}

export type LibrarySpace = {
  id: string
  ownerId: string
  name: string
  color: string
  description: string
  position: number
  createdAt: string
}

const columns = 'id,user_id,name,color,description,position,created_at'

function fromRow(row: SpaceRow): LibrarySpace {
  return { id: row.id, ownerId: row.user_id, name: row.name, color: row.color, description: row.description, position: row.position, createdAt: row.created_at }
}

function cleanName(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
}

function cleanColor(value: unknown) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined
}

function cleanDescription(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
}

export async function listSpaces(client: SupabaseClient, ownerId?: string) {
  let query = client.from('spaces').select(columns).order('position').order('created_at')
  if (ownerId) query = query.eq('user_id', ownerId)
  const { data, error } = await query
  if (error) throw new Error(`Could not load spaces: ${error.message}`)
  return ((data ?? []) as SpaceRow[]).map(fromRow)
}

export async function createSpace(client: SupabaseClient, input: { name?: unknown; color?: unknown; description?: unknown }, ownerId: string) {
  const name = cleanName(input.name)
  if (!name) throw new Error('Give the space a name.')
  const existing = await listSpaces(client, ownerId)
  if (existing.some((space) => space.name.toLowerCase() === name.toLowerCase())) throw new Error('A space with that name already exists.')
  const { data, error } = await client.from('spaces').insert({ user_id: ownerId, name, color: cleanColor(input.color) ?? '#d6ef65', description: cleanDescription(input.description), position: existing.length }).select(columns).single()
  if (error) throw new Error(`Could not create that space: ${error.message}`)
  return fromRow(data as SpaceRow)
}

export async function updateSpace(client: SupabaseClient, id: string, input: { name?: unknown; color?: unknown; description?: unknown }, ownerId: string) {
  const { data: current, error: currentError } = await client.from('spaces').select(columns).eq('id', id).eq('user_id', ownerId).maybeSingle()
  if (currentError) throw new Error(`Could not inspect that space: ${currentError.message}`)
  if (!current) return undefined
  const row = current as SpaceRow
  const patch: Record<string, unknown> = {}
  const name = input.name === undefined ? row.name : cleanName(input.name)
  if (!name) throw new Error('Give the space a name.')
  if (name !== row.name) {
    const { data: duplicate, error: duplicateError } = await client.from('spaces').select('id').eq('user_id', ownerId).ilike('name', name).neq('id', id).maybeSingle()
    if (duplicateError) throw new Error(`Could not check that space name: ${duplicateError.message}`)
    if (duplicate) throw new Error('A space with that name already exists.')
    const { error: itemError } = await client.from('memory_items').update({ space: name }).eq('user_id', ownerId).eq('space', row.name)
    if (itemError) throw new Error(`Could not move the items into the renamed space: ${itemError.message}`)
    patch.name = name
  }
  const color = input.color === undefined ? row.color : cleanColor(input.color)
  if (!color) throw new Error('Choose a valid space colour.')
  if (color !== row.color) patch.color = color
  const description = input.description === undefined ? row.description : cleanDescription(input.description)
  if (description !== row.description) patch.description = description
  if (!Object.keys(patch).length) return fromRow(row)
  const { data, error } = await client.from('spaces').update(patch).eq('id', id).eq('user_id', ownerId).select(columns).single()
  if (error) throw new Error(`Could not update that space: ${error.message}`)
  return fromRow(data as SpaceRow)
}

export async function reorderSpaces(client: SupabaseClient, ids: string[], ownerId: string) {
  const spaces = await listSpaces(client, ownerId)
  const known = new Set(spaces.map(({ id }) => id))
  if (ids.length !== spaces.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) throw new Error('The new space order is incomplete.')
  const results = await Promise.all(ids.map((id, position) => client.from('spaces').update({ position }).eq('id', id).eq('user_id', ownerId)))
  const failed = results.find(({ error }) => error)
  if (failed?.error) throw new Error(`Could not reorder spaces: ${failed.error.message}`)
  return listSpaces(client, ownerId)
}

export async function deleteSpace(client: SupabaseClient, id: string, moveToId: string | undefined, ownerId: string) {
  const spaces = await listSpaces(client, ownerId)
  const current = spaces.find((space) => space.id === id)
  if (!current) return false
  if (current.name === 'Inbox') throw new Error('Inbox is Kept’s fallback space and cannot be deleted.')
  const target = spaces.find((space) => space.id === moveToId) ?? spaces.find((space) => space.name === 'Inbox')
  if (!target || target.id === id) throw new Error('Choose another space for the items first.')
  const { error: moveError } = await client.from('memory_items').update({ space: target.name }).eq('user_id', ownerId).eq('space', current.name)
  if (moveError) throw new Error(`Could not move the items before deleting the space: ${moveError.message}`)
  const { data, error } = await client.from('spaces').delete().eq('id', id).eq('user_id', ownerId).select('id').maybeSingle()
  if (error) throw new Error(`Could not delete that space: ${error.message}`)
  return Boolean(data)
}
