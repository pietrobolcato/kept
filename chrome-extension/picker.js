(() => {
  if (window.__keptPickerInstalled) return
  window.__keptPickerInstalled = true
  let active = false
  let target = null
  const outline = document.createElement('div')
  const label = document.createElement('div')
  const toast = document.createElement('div')
  for (const node of [outline, label, toast]) node.dataset.keptPicker = 'true'
  Object.assign(outline.style, { position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', border: '2px solid #b9dc45', borderRadius: '6px', boxShadow: '0 0 0 9999px rgba(20,22,18,.12)', transition: 'all 70ms ease', display: 'none' })
  Object.assign(label.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', padding: '7px 10px', borderRadius: '8px', background: '#252620', color: '#fff', font: '600 12px -apple-system,BlinkMacSystemFont,sans-serif', boxShadow: '0 7px 24px rgba(0,0,0,.22)', display: 'none' })
  Object.assign(toast.style, { position: 'fixed', zIndex: '2147483647', left: '50%', bottom: '24px', transform: 'translateX(-50%)', padding: '11px 15px', borderRadius: '10px', background: '#252620', color: '#fff', font: '600 13px -apple-system,BlinkMacSystemFont,sans-serif', boxShadow: '0 10px 30px rgba(0,0,0,.25)', display: 'none' })
  document.documentElement.append(outline, label, toast)

  const showToast = (text) => { toast.textContent = text; toast.style.display = 'block'; setTimeout(() => { toast.style.display = 'none' }, 2400) }
  const stop = () => { active = false; target = null; outline.style.display = 'none'; label.style.display = 'none'; document.documentElement.style.cursor = '' }
  const move = (event) => {
    if (!active) return
    const next = event.target.closest?.('[data-kept-picker]') ? null : event.target
    if (!(next instanceof Element) || next === document.documentElement || next === document.body) return
    target = next
    const rect = next.getBoundingClientRect()
    Object.assign(outline.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    label.textContent = `${next.tagName.toLowerCase()} · click to keep`
    Object.assign(label.style, { display: 'block', left: `${Math.max(8, Math.min(innerWidth - 145, rect.left))}px`, top: `${Math.max(8, rect.top - 36)}px` })
  }
  const click = (event) => {
    if (!active || !target) return
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
    const rect = target.getBoundingClientRect()
    const payload = { type: 'kept-capture-element', rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, viewportWidth: innerWidth, viewportHeight: innerHeight, pageTitle: document.title, pageUrl: location.href, text: (target.innerText || target.alt || '').replace(/\s+/g, ' ').trim().slice(0, 700) }
    stop(); showToast('Keeping your selection…')
    chrome.runtime.sendMessage(payload, (result) => showToast(result?.ok ? `${result.duplicate ? 'Already kept' : 'Kept'} · ${result.title}` : result?.error || 'Could not keep this selection'))
  }
  const key = (event) => { if (active && event.key === 'Escape') { event.preventDefault(); stop(); showToast('Selection cancelled') } }
  addEventListener('mousemove', move, true)
  addEventListener('click', click, true)
  addEventListener('keydown', key, true)
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'kept-start-picker') return
    active = true; document.documentElement.style.cursor = 'crosshair'; showToast('Choose anything · Esc to cancel')
  })
})()
