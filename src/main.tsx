import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const startupUrl = new URL(window.location.href)
if (startupUrl.searchParams.has('_kept_reload')) {
  startupUrl.searchParams.delete('_kept_reload')
  window.history.replaceState({}, '', `${startupUrl.pathname}${startupUrl.search}${startupUrl.hash}`)
}
window.sessionStorage.removeItem('kept-asset-recovery')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
