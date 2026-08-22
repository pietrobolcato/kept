async function apiBase() {
  const { keptApiBase } = await chrome.storage.local.get('keptApiBase')
  if (!keptApiBase) throw new Error('Open the Kept extension options and enter your Kept URL first.')
  return keptApiBase.replace(/\/+$/, '')
}

async function config() {
  const base = await apiBase()
  const cached = await chrome.storage.local.get('keptConfig')
  if (cached.keptConfig?.apiBase === base) return cached.keptConfig
  const response = await fetch(`${base}/api/extension/config`)
  if (!response.ok) throw new Error('Kept is unavailable.')
  const value = { ...await response.json(), apiBase: base }
  await chrome.storage.local.set({ keptConfig: value })
  return value
}

async function session() {
  const stored = await chrome.storage.local.get('keptSession')
  const current = stored.keptSession
  if (!current?.refresh_token) throw new Error('Connect the extension to Kept first.')
  if (current.expires_at * 1000 > Date.now() + 60_000) return current
  const settings = await config()
  const response = await fetch(`${settings.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: settings.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: current.refresh_token }),
  })
  if (!response.ok) throw new Error('Reconnect the extension to Kept.')
  const refreshed = await response.json()
  await chrome.storage.local.set({ keptSession: refreshed })
  return refreshed
}

async function keptFetch(path, options = {}) {
  const auth = await session()
  const base = await apiBase()
  return fetch(`${base}${path}`, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${auth.access_token}` } })
}

async function pageContext(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({
    url: location.href,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content || '',
    selection: getSelection()?.toString().trim().slice(0, 800) || '',
  }) })
  return result
}

async function keepPage(tab) {
  const page = await pageContext(tab.id)
  if (!/^https?:/i.test(page.url)) throw new Error('This browser page cannot be saved.')
  const context = [page.description, page.selection ? `Selected text: ${page.selection}` : ''].filter(Boolean).join('\n').slice(0, 1200)
  const response = await keptFetch('/api/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'link', value: page.url, context }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'This page could not be kept.')
  return result
}

async function screenshotElement(tab, payload) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const source = await createImageBitmap(await (await fetch(dataUrl)).blob())
  const scaleX = source.width / payload.viewportWidth
  const scaleY = source.height / payload.viewportHeight
  const x = Math.max(0, Math.round(payload.rect.left * scaleX))
  const y = Math.max(0, Math.round(payload.rect.top * scaleY))
  const width = Math.max(2, Math.min(source.width - x, Math.round(payload.rect.width * scaleX)))
  const height = Math.max(2, Math.min(source.height - y, Math.round(payload.rect.height * scaleY)))
  const maxEdge = 1800
  const outputScale = Math.min(1, maxEdge / Math.max(width, height))
  const canvas = new OffscreenCanvas(Math.max(2, Math.round(width * outputScale)), Math.max(2, Math.round(height * outputScale)))
  canvas.getContext('2d').drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height)
  return canvas.convertToBlob({ type: 'image/webp', quality: .88 })
}

async function keepElement(tab, payload) {
  const blob = await screenshotElement(tab, payload)
  const body = new FormData()
  body.append('image', blob, `selected-${Date.now()}.webp`)
  body.append('hint', [`Selected from “${payload.pageTitle}”`, payload.text ? `Visible content: ${payload.text}` : '', `Source page: ${payload.pageUrl}`].filter(Boolean).join('\n').slice(0, 1200))
  body.append('sourceUrl', payload.pageUrl)
  const response = await keptFetch('/api/upload', { method: 'POST', body })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'That element could not be kept.')
  return result
}

async function notify(title, message) {
  await chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon-128.png', title, message })
}

async function activeTab() {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
}

async function run(command, providedTab) {
  const tab = providedTab || await activeTab()
  if (!tab?.id) throw new Error('No active page found.')
  if (command === 'pick-element') {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js'] })
    await chrome.tabs.sendMessage(tab.id, { type: 'kept-start-picker' })
    return
  }
  const result = await keepPage(tab)
  await notify(result.duplicate ? 'Already in Kept' : 'Kept ✓', `${result.title}\n${result.space}`)
}

chrome.commands.onCommand.addListener((command) => run(command).catch((error) => notify('Kept needs attention', error.message)))
chrome.action.onClicked.addListener(() => run('save-current-page').catch((error) => notify('Kept needs attention', error.message)))
async function installContextMenus() {
  await chrome.contextMenus.removeAll()
  chrome.contextMenus.create({ id: 'kept-save-page', title: 'Keep this page', contexts: ['page', 'selection', 'image', 'video', 'link'] })
  chrome.contextMenus.create({ id: 'kept-pick-element', title: 'Choose something to keep…', contexts: ['page', 'selection', 'image', 'video', 'link'] })
}
chrome.runtime.onInstalled.addListener(({ reason }) => {
  void installContextMenus()
  if (reason === 'install') void chrome.runtime.openOptionsPage()
})
chrome.runtime.onStartup.addListener(() => { void installContextMenus() })
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return
  const command = info.menuItemId === 'kept-pick-element' ? 'pick-element' : 'save-current-page'
  void run(command, tab).catch((error) => notify('Kept needs attention', error.message))
})
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'kept-capture-element' || !sender.tab) return false
  keepElement(sender.tab, message).then(async (result) => {
    await notify(result.duplicate ? 'Already in Kept' : 'Kept selection ✓', `${result.title}\n${result.space}`)
    sendResponse({ ok: true, title: result.title, space: result.space, duplicate: result.duplicate })
  }).catch((error) => sendResponse({ ok: false, error: error.message }))
  return true
})
