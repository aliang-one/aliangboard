const baseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const sessionKey = 'aliangboard.session'

function getSessionToken() {
  return sessionStorage.getItem(sessionKey) || localStorage.getItem(sessionKey) || ''
}

async function request(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  const token = getSessionToken()
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) {
    const error = new Error(body?.message || `请求失败：HTTP ${response.status}`)
    error.status = response.status
    error.details = body
    throw error
  }
  return body
}

export function saveSession(token, remember = false) {
  sessionStorage.removeItem(sessionKey)
  localStorage.removeItem(sessionKey)
  ;(remember ? localStorage : sessionStorage).setItem(sessionKey, token)
}

export function clearSession() {
  sessionStorage.removeItem(sessionKey)
  localStorage.removeItem(sessionKey)
}

export function getSession() {
  return getSessionToken()
}

export const api = {
  connect: payload => request('/api/session', { method: 'POST', body: JSON.stringify(payload) }),
  session: () => request('/api/session'),
  logout: () => request('/api/session', { method: 'DELETE' }),
  health: () => request('/api/health'),
  applyYaml: yaml => request('/api/apply', { method: 'POST', body: JSON.stringify({ yaml }) }),
  k8s: (path, options) => request(`/api/k8s${path}`, options),
}
