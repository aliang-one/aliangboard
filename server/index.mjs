import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import { loadAll as yamlLoadAll } from 'js-yaml'

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
const sessions = new Map()
const discoveryCache = new Map()
const sessionTtl = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000)
const allowedHosts = new Set((process.env.K8S_ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean))

if (process.env.K8S_INSECURE_SKIP_TLS_VERIFY === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  console.warn('WARNING: Kubernetes TLS certificate verification is disabled')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': process.env.CORS_ORIGIN || '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sessionFromRequest(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const session = token ? sessions.get(token) : null
  if (session && Date.now() - session.createdAt > sessionTtl) {
    sessions.delete(token)
    return null
  }
  return session
}

function normalizeServer(value) {
  const url = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Server 必须使用 http 或 https')
  if (allowedHosts.size && !allowedHosts.has(url.hostname)) throw new Error(`API Server 主机 ${url.hostname} 不在允许列表中`)
  url.pathname = url.pathname.replace(/\/$/, '')
  return url
}

async function requestKubernetes(session, path, init = {}) {
  const target = new URL(path, session.apiServer)
  const headers = { accept: 'application/json', ...(init.headers || {}) }
  if (session.authHeader) headers.authorization = session.authHeader
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'

  const response = await fetch(target, {
    ...init,
    headers,
    signal: AbortSignal.timeout(Number(process.env.K8S_REQUEST_TIMEOUT || 15000)),
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) {
    const message = body?.message || body?.reason || `Kubernetes API 返回 HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.details = body
    throw error
  }
  return { status: response.status, headers: response.headers, body }
}

async function discoverResource(session, object) {
  const apiVersion = String(object.apiVersion || '')
  const [group, version] = apiVersion.includes('/') ? apiVersion.split('/', 2) : ['', apiVersion]
  if (!version) throw new Error('YAML 缺少 apiVersion')
  const cacheKey = `${session.apiServer}:${apiVersion}`
  let resources = discoveryCache.get(cacheKey)
  if (!resources) {
    const discoveryPath = group ? `/apis/${group}/${version}` : `/api/${version}`
    resources = (await requestKubernetes(session, discoveryPath)).body?.resources || []
    discoveryCache.set(cacheKey, resources)
  }
  const resource = resources.find(item => item.kind === object.kind && !item.name.includes('/'))
  if (!resource) throw new Error(`集群未发现资源类型 ${object.kind} (${apiVersion})`)
  return { group, version, resource }
}

async function applyYaml(session, yaml) {
  const objects = []
  yamlLoadAll(yaml, object => { if (object) objects.push(object) })
  if (!objects.length) throw new Error('YAML 中没有可应用的资源')
  const results = []
  for (const object of objects) {
    if (!object?.kind || !object?.metadata?.name) throw new Error('YAML 缺少 kind 或 metadata.name')
    const { group, version, resource } = await discoverResource(session, object)
    const prefix = group ? `/apis/${group}/${version}` : `/api/${version}`
    const namespacePart = resource.namespaced
      ? `/namespaces/${encodeURIComponent(object.metadata.namespace || 'default')}`
      : ''
    const path = `${prefix}${namespacePart}/${resource.name}/${encodeURIComponent(object.metadata.name)}?fieldManager=aliangboard&force=true`
    const document = JSON.stringify(object)
    const result = await requestKubernetes(session, path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/apply-patch+yaml' },
      body: document,
    })
    results.push(result.body)
  }
  return results
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {})
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'aliangboard-api', time: new Date().toISOString() })
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    try {
      const input = await readBody(req)
      const apiServer = normalizeServer(input.apiServer)
      const authHeader = input.authMethod === 'basic'
        ? `Basic ${Buffer.from(`${input.username || ''}:${input.password || ''}`).toString('base64')}`
        : `Bearer ${String(input.token || '')}`
      if (input.authMethod === 'basic' && (!input.username || !input.password)) {
        return sendJson(res, 400, { message: '用户名和密码不能为空' })
      }
      if (input.authMethod !== 'basic' && !input.token) return sendJson(res, 400, { message: 'Bearer Token 不能为空' })
      const sessionId = randomUUID()
      const session = { apiServer, authHeader, createdAt: Date.now() }
      const probe = await requestKubernetes(session, '/version')
      session.version = probe.body?.gitVersion || 'unknown'
      sessions.set(sessionId, session)
      return sendJson(res, 200, {
        token: sessionId,
        cluster: { apiServer: apiServer.toString().replace(/\/$/, ''), version: session.version },
      })
    } catch (error) {
      return sendJson(res, error.status || 400, { message: error.message || '连接 Kubernetes 集群失败' })
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    return sendJson(res, 200, {
      cluster: { apiServer: session.apiServer.toString().replace(/\/$/, ''), version: session.version || 'unknown' },
    })
  }

  if (req.method === 'DELETE' && url.pathname === '/api/session') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (token) sessions.delete(token)
    return sendJson(res, 204, {})
  }

  if (req.method === 'POST' && url.pathname === '/api/apply') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    try {
      const input = await readBody(req)
      const resources = await applyYaml(session, String(input.yaml || ''))
      return sendJson(res, 200, { resources })
    } catch (error) {
      return sendJson(res, error.status || 422, { message: error.message || '应用 YAML 失败', details: error.details })
    }
  }

  if (!url.pathname.startsWith('/api/k8s/')) return sendJson(res, 404, { message: 'Not found' })
  const session = sessionFromRequest(req)
  if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })

  const kubernetesPath = decodeURIComponent(url.pathname.slice('/api/k8s'.length)) + (url.search || '')
  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(await readBody(req)) : undefined
    const result = await requestKubernetes(session, kubernetesPath, { method: req.method, body })
    return sendJson(res, result.status, result.body ?? {})
  } catch (error) {
    return sendJson(res, error.status || 502, { message: error.message || 'Kubernetes API 请求失败', details: error.details })
  }
}

createServer((req, res) => {
  handle(req, res).catch(error => sendJson(res, 500, { message: error.message || '服务器错误' }))
}).listen(port, host, () => {
  console.log(`AliangBoard API listening on http://${host}:${port}`)
})
