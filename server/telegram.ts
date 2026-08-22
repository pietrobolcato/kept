import crypto from 'node:crypto'
import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { captureImageItem, captureTextItem, captureVideoItem } from './capture.js'
import { createServiceClient, type AuthContext } from './supabase.js'

type TelegramUser = { id: number; first_name?: string; username?: string }
type TelegramMessage = {
  message_id: number
  from?: TelegramUser
  chat: { id: number; type: string }
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number; thumbnail?: { file_id: string; file_size?: number }; thumb?: { file_id: string; file_size?: number } }
}
type TelegramUpdate = { update_id?: number; message?: TelegramMessage }

class TelegramStatusReportedError extends Error {}

const pairLifetimeMs = 10 * 60 * 1000
const telegramFileLimit = 20 * 1024 * 1024

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function configured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME && process.env.TELEGRAM_WEBHOOK_SECRET && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function auth(response: express.Response) {
  return response.locals.auth as AuthContext
}

function safeSecretEqual(received: string, expected: string) {
  const left = Buffer.from(received)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function firstUrl(value: string) {
  const match = value.match(/https?:\/\/[^\s<>"']+/i)
  return match?.[0].replace(/[),.;!?\]}]+$/, '')
}

async function sendMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return undefined
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  })
  if (!response.ok) {
    console.warn('Telegram reply failed:', response.status)
    return undefined
  }
  const result = await response.json() as { ok?: boolean; result?: { message_id?: number } }
  return result.ok && Number.isSafeInteger(result.result?.message_id) ? result.result!.message_id : undefined
}

async function editMessage(chatId: number, messageId: number | undefined, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || !messageId) return false
  const response = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true }),
  })
  if (!response.ok) console.warn('Telegram status edit failed:', response.status)
  return response.ok
}

function messageImage(message: TelegramMessage) {
  if (message.photo?.length) {
    const photo = [...message.photo].sort((left, right) => (right.width * right.height) - (left.width * left.height))[0]
    return { fileId: photo.file_id, fileSize: photo.file_size, mimeType: 'image/jpeg', filename: 'telegram-photo.jpg' }
  }
  const document = message.document
  if (document?.mime_type?.startsWith('image/')) {
    return {
      fileId: document.file_id,
      fileSize: document.file_size,
      mimeType: document.mime_type,
      filename: document.file_name || 'telegram-image',
    }
  }
  return undefined
}

function messageVideo(message: TelegramMessage) {
  const video = message.video ?? (message.document?.mime_type?.startsWith('video/') ? message.document : undefined)
  if (!video) return undefined
  const thumbnail = message.video?.thumbnail ?? message.video?.thumb
  return {
    fileId: video.file_id,
    fileSize: video.file_size,
    mimeType: video.mime_type || 'video/mp4',
    filename: video.file_name || 'telegram-video.mp4',
    thumbnail,
  }
}

async function downloadTelegramFile(fileId: string, announcedSize?: number) {
  if (announcedSize && announcedSize > telegramFileLimit) throw new Error('That image is over Telegram’s 20 MB bot download limit.')
  const token = process.env.TELEGRAM_BOT_TOKEN!
  const metadataResponse = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(15_000),
  })
  const metadata = await metadataResponse.json() as { ok?: boolean; description?: string; result?: { file_path?: string; file_size?: number } }
  if (!metadataResponse.ok || !metadata.ok || !metadata.result?.file_path) throw new Error(metadata.description || 'Telegram could not prepare that image.')
  if (metadata.result.file_size && metadata.result.file_size > telegramFileLimit) throw new Error('That image is over Telegram’s 20 MB bot download limit.')
  const fileResponse = await fetch(`https://api.telegram.org/file/bot${token}/${metadata.result.file_path}`, { signal: AbortSignal.timeout(25_000) })
  if (!fileResponse.ok) throw new Error('Telegram could not download that image.')
  const contentLength = Number(fileResponse.headers.get('content-length') || 0)
  if (contentLength > telegramFileLimit) throw new Error('That image is over Telegram’s 20 MB bot download limit.')
  const buffer = Buffer.from(await fileResponse.arrayBuffer())
  if (!buffer.length || buffer.length > telegramFileLimit) throw new Error('That image is empty or too large.')
  return buffer
}

async function connectPairing(client: SupabaseClient, message: TelegramMessage, code: string) {
  const { data: pairing, error } = await client
    .from('telegram_pairing_codes')
    .select('id,user_id,expires_at,used_at')
    .eq('code_hash', digest(code))
    .maybeSingle()
  if (error) throw new Error(`Pairing lookup failed: ${error.message}`)
  if (!pairing || pairing.used_at || new Date(pairing.expires_at).getTime() <= Date.now()) return false
  if (!message.from) return false

  await client.from('telegram_connections').delete().eq('telegram_user_id', message.from.id)
  const { error: connectionError } = await client.from('telegram_connections').upsert({
    user_id: pairing.user_id,
    telegram_user_id: message.from.id,
    chat_id: message.chat.id,
    username: message.from.username ?? null,
    first_name: message.from.first_name ?? null,
    last_used_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })
  if (connectionError) throw new Error(`Pairing failed: ${connectionError.message}`)
  const { error: usedError } = await client.from('telegram_pairing_codes').update({ used_at: new Date().toISOString() }).eq('id', pairing.id).is('used_at', null)
  if (usedError) throw new Error(`Pairing finalisation failed: ${usedError.message}`)
  return true
}

async function processUpdate(update: TelegramUpdate) {
  const message = update.message
  if (!message || message.chat.type !== 'private') return
  const client = createServiceClient()
  const content = (message.text ?? message.caption ?? '').trim()
  const startCode = content.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})$/)?.[1]
  if (startCode) {
    const connected = await connectPairing(client, message, startCode)
    await sendMessage(message.chat.id, connected
      ? 'Connected to Kept ✓\n\nSend me any link, photo, video or note and I’ll organise it into your library.'
      : 'That pairing link has expired or was already used. Create a fresh one in Kept.')
    return
  }
  if (/^\/start(?:@\w+)?\s*$/i.test(content)) {
    await sendMessage(message.chat.id, 'Open Kept → Add from phone → Connect Telegram to securely pair this chat.')
    return
  }

  const { data: connection, error } = await client.from('telegram_connections').select('user_id').eq('chat_id', message.chat.id).maybeSingle()
  if (error) throw new Error(`Telegram connection lookup failed: ${error.message}`)
  if (!connection) {
    await sendMessage(message.chat.id, 'This chat is not connected yet. Open Kept → Add from phone → Connect Telegram.')
    return
  }
  const image = messageImage(message)
  const video = messageVideo(message)
  if (message.document && !image && !video) {
    await sendMessage(message.chat.id, 'I can keep links, notes, photos and videos, but not that file type yet.')
    return
  }
  if (!content && !image && !video) {
    await sendMessage(message.chat.id, 'Send me a web link, photo, video or note and I’ll keep it for you.')
    return
  }

  const url = image || video ? undefined : firstUrl(content)
  const statusId = await sendMessage(message.chat.id, video ? 'Reading the video…' : image ? 'Reading the photo…' : url ? 'Reading the link…' : 'Reading your note…')
  try {
    const item = video
      ? await captureVideoItem({
        client,
        userId: connection.user_id,
        videoBuffer: await downloadTelegramFile(video.fileId, video.fileSize),
        posterBuffer: video.thumbnail ? await downloadTelegramFile(video.thumbnail.file_id, video.thumbnail.file_size).catch(() => undefined) : undefined,
        videoMimeType: ['video/mp4', 'video/quicktime', 'video/webm'].includes(video.mimeType) ? video.mimeType : 'video/mp4',
        filename: video.filename,
        hint: content,
      })
      : image
      ? await captureImageItem({
        client,
        userId: connection.user_id,
        buffer: await downloadTelegramFile(image.fileId, image.fileSize),
        mimeType: image.mimeType,
        filename: image.filename,
        hint: content,
      })
      : await captureTextItem({
        client,
        userId: connection.user_id,
        type: url ? 'link' : 'note',
        value: url ?? content,
        context: url ? content.replace(url, '').trim() : undefined,
      })
    await client.from('telegram_connections').update({ last_used_at: new Date().toISOString() }).eq('user_id', connection.user_id)
    const place = item.location?.name ? ` · ${item.location.name}` : ''
    await editMessage(message.chat.id, statusId, 'Understood ✓')
    const finalText = item.duplicate
      ? `Already kept ✓\n${item.title}\nIn ${item.space}${place}`
      : `Saved ✓\n${item.title}\nFiled in ${item.space}${place}`
    await sendMessage(message.chat.id, finalText)
  } catch (error) {
    const failure = 'Couldn’t save this one. Please try sending it again.'
    if (!await editMessage(message.chat.id, statusId, failure)) await sendMessage(message.chat.id, failure)
    throw new TelegramStatusReportedError(error instanceof Error ? error.message : 'Telegram capture failed.')
  }
}

export function createTelegramPublicRouter() {
  const router = express.Router()
  router.post('/telegram/webhook', async (request, response) => {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? ''
    const received = request.header('x-telegram-bot-api-secret-token') ?? ''
    if (!expected || !safeSecretEqual(received, expected)) return response.status(401).json({ error: 'Invalid Telegram webhook signature.' })
    const update = request.body as TelegramUpdate
    if (!Number.isSafeInteger(update.update_id)) return response.status(200).json({ ok: true })
    const client = createServiceClient()
    const { error: claimError } = await client.from('telegram_updates').insert({ update_id: update.update_id })
    if (claimError?.code === '23505') return response.status(200).json({ ok: true })
    if (claimError) return response.status(503).json({ error: 'Could not claim Telegram update.' })
    try {
      await processUpdate(update)
      await client.from('telegram_updates').update({ processed_at: new Date().toISOString() }).eq('update_id', update.update_id)
    } catch (error) {
      await client.from('telegram_updates').delete().eq('update_id', update.update_id)
      console.warn('Telegram capture failed:', error instanceof Error ? error.message : 'Unknown error')
      if (update.message && !(error instanceof TelegramStatusReportedError)) await sendMessage(update.message.chat.id, 'I couldn’t save that just now. Please send it again in a moment.')
    }
    response.json({ ok: true })
  })
  return router
}

export function createTelegramPrivateRouter() {
  const router = express.Router()
  router.get('/integrations/telegram', async (_request, response) => {
    const { client } = auth(response)
    const { data, error } = await client.from('telegram_connections').select('username,first_name,created_at,last_used_at').maybeSingle()
    if (error) return response.status(503).json({ error: `Could not load Telegram connection: ${error.message}` })
    response.json({ enabled: configured(), botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null, connected: Boolean(data), connection: data ?? null })
  })
  router.post('/integrations/telegram/pairing', async (_request, response) => {
    if (!configured()) return response.status(503).json({ error: 'The Telegram bot is not configured yet.' })
    const { client, user } = auth(response)
    const code = crypto.randomBytes(18).toString('base64url')
    const expiresAt = new Date(Date.now() + pairLifetimeMs).toISOString()
    await client.from('telegram_pairing_codes').delete().eq('user_id', user.id).is('used_at', null)
    const { error } = await client.from('telegram_pairing_codes').insert({ user_id: user.id, code_hash: digest(code), expires_at: expiresAt })
    if (error) return response.status(503).json({ error: `Could not create Telegram pairing: ${error.message}` })
    const botUsername = process.env.TELEGRAM_BOT_USERNAME!
    response.status(201).json({ botUsername, deepLink: `https://t.me/${botUsername}?start=${code}`, expiresAt })
  })
  router.delete('/integrations/telegram', async (_request, response) => {
    const { client, user } = auth(response)
    const { error } = await client.from('telegram_connections').delete().eq('user_id', user.id)
    if (error) return response.status(503).json({ error: `Could not disconnect Telegram: ${error.message}` })
    response.status(204).end()
  })
  return router
}
