import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssistantReply, AssistantSource } from './assistant.js'

type ConversationRow = {
  id: string
  title: string
  created_at: string
  updated_at: string
}

type MessageRow = {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  item_ids: string[] | null
  sources: AssistantSource[] | null
  activities: string[] | null
  attachment_labels: string[] | null
  created_at: string
}

export type ConversationSummary = {
  id: string
  title: string
  preview: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

export type PersistedMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  itemIds: string[]
  sources: AssistantSource[]
  activities: string[]
  attachmentLabels: string[]
  createdAt: string
}

function cleanTitle(message: string) {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized.length > 58 ? `${normalized.slice(0, 57).trimEnd()}…` : normalized || 'New conversation'
}

function summary(row: ConversationRow, messages: MessageRow[]): ConversationSummary {
  const latest = messages[0]
  return {
    id: row.id,
    title: row.title,
    preview: latest?.content.replace(/\s+/g, ' ').trim().slice(0, 110) ?? 'No messages yet',
    messageCount: messages.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function persistedMessage(row: MessageRow): PersistedMessage {
  return {
    id: row.id,
    role: row.role,
    text: row.content,
    itemIds: row.item_ids ?? [],
    sources: Array.isArray(row.sources) ? row.sources : [],
    activities: row.activities ?? [],
    attachmentLabels: row.attachment_labels ?? [],
    createdAt: row.created_at,
  }
}

const conversationColumns = 'id,title,created_at,updated_at'
const messageColumns = 'id,conversation_id,role,content,item_ids,sources,activities,attachment_labels,created_at'

export async function listConversations(client: SupabaseClient): Promise<ConversationSummary[]> {
  const { data, error } = await client.from('assistant_conversations').select(conversationColumns).order('updated_at', { ascending: false }).limit(50)
  if (error) throw new Error(`Could not load chat history: ${error.message}`)
  const conversations = (data ?? []) as ConversationRow[]
  if (!conversations.length) return []
  const ids = conversations.map(({ id }) => id)
  const { data: messageData, error: messageError } = await client.from('assistant_messages').select(messageColumns).in('conversation_id', ids).order('created_at', { ascending: false }).limit(1000)
  if (messageError) throw new Error(`Could not load chat previews: ${messageError.message}`)
  const messagesByConversation = new Map<string, MessageRow[]>()
  for (const message of (messageData ?? []) as MessageRow[]) {
    const messages = messagesByConversation.get(message.conversation_id) ?? []
    messages.push(message)
    messagesByConversation.set(message.conversation_id, messages)
  }
  return conversations.map((conversation) => summary(conversation, messagesByConversation.get(conversation.id) ?? []))
}

export async function getConversation(client: SupabaseClient, id: string) {
  const { data, error } = await client.from('assistant_conversations').select(conversationColumns).eq('id', id).maybeSingle()
  if (error) throw new Error(`Could not load that conversation: ${error.message}`)
  if (!data) return undefined
  const { data: messageData, error: messageError } = await client.from('assistant_messages').select(messageColumns).eq('conversation_id', id).order('created_at', { ascending: true })
  if (messageError) throw new Error(`Could not load the conversation messages: ${messageError.message}`)
  const messages = ((messageData ?? []) as MessageRow[]).map(persistedMessage)
  return {
    conversation: summary(data as ConversationRow, [...((messageData ?? []) as MessageRow[])].reverse()),
    messages,
  }
}

export async function saveExchange(client: SupabaseClient, input: {
  conversationId?: string
  userMessage: string
  attachmentLabels: string[]
  reply: AssistantReply
}) {
  let conversation: ConversationRow | undefined
  let created = false
  if (input.conversationId) {
    const { data, error } = await client.from('assistant_conversations').select(conversationColumns).eq('id', input.conversationId).maybeSingle()
    if (error) throw new Error(`Could not continue that conversation: ${error.message}`)
    if (!data) throw new Error('That conversation no longer exists.')
    conversation = data as ConversationRow
  } else {
    const { data, error } = await client.from('assistant_conversations').insert({ title: cleanTitle(input.userMessage) }).select(conversationColumns).single()
    if (error) throw new Error(`Could not create a conversation: ${error.message}`)
    conversation = data as ConversationRow
    created = true
  }

  const userCreatedAt = new Date().toISOString()
  const assistantCreatedAt = new Date(Date.now() + 1).toISOString()
  const { error: messageError } = await client.from('assistant_messages').insert([
    {
      conversation_id: conversation.id,
      role: 'user',
      content: input.userMessage.slice(0, 8_000),
      item_ids: [],
      sources: [],
      activities: [],
      attachment_labels: input.attachmentLabels.slice(0, 8),
      created_at: userCreatedAt,
    },
    {
      conversation_id: conversation.id,
      role: 'assistant',
      content: input.reply.message.slice(0, 8_000),
      item_ids: input.reply.itemIds,
      sources: input.reply.sources,
      activities: input.reply.activities,
      attachment_labels: [],
      created_at: assistantCreatedAt,
    },
  ])
  if (messageError) {
    if (created) await client.from('assistant_conversations').delete().eq('id', conversation.id)
    throw new Error(`Could not save the conversation: ${messageError.message}`)
  }
  const { data: updated, error: updateError } = await client.from('assistant_conversations').update({ updated_at: assistantCreatedAt }).eq('id', conversation.id).select(conversationColumns).single()
  if (updateError) throw new Error(`Could not finish saving the conversation: ${updateError.message}`)
  const saved = await getConversation(client, conversation.id)
  return saved?.conversation ?? summary(updated as ConversationRow, [])
}

export async function deleteConversation(client: SupabaseClient, id: string) {
  const { data, error } = await client.from('assistant_conversations').delete().eq('id', id).select('id').maybeSingle()
  if (error) throw new Error(`Could not delete the conversation: ${error.message}`)
  return Boolean(data)
}
