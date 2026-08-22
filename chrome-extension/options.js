const form = document.querySelector('form')
const connected = document.querySelector('#connected')
const errorNode = document.querySelector('#error')
const instanceInput = document.querySelector('#instance')

function normaliseApiBase(value) {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http:// or https:// Kept URL.')
  return url.href.replace(/\/+$/, '')
}

async function settings(base) {
  const response = await fetch(`${base}/api/extension/config`)
  if (!response.ok) throw new Error('Kept is currently unavailable.')
  const value = { ...await response.json(), apiBase: base }
  await chrome.storage.local.set({ keptConfig: value })
  return value
}

function render(session, base = '') {
  form.hidden = Boolean(session)
  connected.hidden = !session
  connected.style.display = session ? 'flex' : 'none'
  document.querySelector('#account').textContent = session?.user?.email || ''
  document.querySelector('#connected-instance').textContent = base
}

function prettyShortcut(value) {
  return value
    ? value.replace('Command', '⌘').replace('MacCtrl', '⌃').replace('Ctrl', '⌃').replace('Alt', '⌥').replace('Shift', '⇧').replaceAll('+', ' ')
    : 'Not assigned'
}

async function renderShortcuts() {
  const commands = await chrome.commands.getAll()
  const save = commands.find(({ name }) => name === 'save-current-page')?.shortcut || ''
  const pick = commands.find(({ name }) => name === 'pick-element')?.shortcut || ''
  document.querySelector('#save-shortcut').textContent = prettyShortcut(save)
  document.querySelector('#pick-shortcut').textContent = prettyShortcut(pick)
  document.querySelector('#save-status').classList.toggle('missing', !save)
  document.querySelector('#pick-status').classList.toggle('missing', !pick)
  const missing = [save, pick].filter((value) => !value).length
  const summary = document.querySelector('#shortcut-summary')
  summary.textContent = missing ? `${missing} needs setup` : 'Ready'
  summary.classList.toggle('needs-attention', Boolean(missing))
  document.querySelector('#arc-help').hidden = !missing
}

form.addEventListener('submit', async (event) => {
  event.preventDefault(); errorNode.style.display = 'none'
  const button = document.querySelector('#connect'); button.disabled = true; button.textContent = 'Connecting…'
  try {
    const base = normaliseApiBase(instanceInput.value)
    const previous = await chrome.storage.local.get('keptApiBase')
    if (previous.keptApiBase !== base) await chrome.storage.local.remove(['keptConfig', 'keptSession'])
    await chrome.storage.local.set({ keptApiBase: base })
    const config = await settings(base)
    const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: document.querySelector('#email').value.trim(), password: document.querySelector('#password').value }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error_description || result.msg || 'Could not sign in.')
    await chrome.storage.local.set({ keptSession: result })
    document.querySelector('#password').value = ''
    render(result, base)
  } catch (error) { errorNode.textContent = error.message; errorNode.style.display = 'block' }
  finally { button.disabled = false; button.textContent = 'Connect extension' }
})

document.querySelector('#disconnect').addEventListener('click', async () => { await chrome.storage.local.remove('keptSession'); render(null) })
document.querySelector('#change-instance').addEventListener('click', async () => {
  await chrome.storage.local.remove(['keptSession', 'keptConfig'])
  render(null)
  instanceInput.focus()
})
document.querySelector('#open-shortcuts').addEventListener('click', async () => {
  try { await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }
  catch { document.querySelector('.shortcut-address').style.fontWeight = '700' }
})
chrome.storage.local.get(['keptSession', 'keptApiBase']).then(({ keptSession, keptApiBase }) => {
  instanceInput.value = keptApiBase || 'http://localhost:8787'
  render(keptSession, keptApiBase)
})
void renderShortcuts()
