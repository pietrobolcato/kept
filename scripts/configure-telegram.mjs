#!/usr/bin/env node

import 'dotenv/config'

const appUrl = process.argv[2]?.replace(/\/+$/, '')
const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET

if (!appUrl || !/^https:\/\//i.test(appUrl)) {
  throw new Error('Usage: npm run telegram:webhook -- https://your-kept-domain.example')
}
if (!token || !secret) {
  throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env first.')
}

const telegram = async (method, body) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram ${method} failed.`)
  return result.result
}

const bot = await telegram('getMe', {})
await telegram('setMyCommands', {
  commands: [
    { command: 'destination', description: 'Choose where new saves go' },
  ],
})
await telegram('setWebhook', {
  url: `${appUrl}/api/telegram/webhook`,
  secret_token: secret,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: false,
})

console.log(`Telegram capture is ready for @${bot.username}.`)
console.log(`Webhook: ${appUrl}/api/telegram/webhook`)
