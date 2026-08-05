// 调用上下文(call context):集群连接 + 身份的统一抽象(T1)。
// 一个 call context = { apiServer(URL), authHeader, ca, cert, key, insecure, dispatcher }。
// 浏览器/平台 session、API-key 请求都经 buildCallContext() 构造 → 6 条 kube 调用路径
// (requestKubernetes / 流式 watch-follow / buildKubeConfig→exec·attach·portforward)共用同一形状。
// 身份是参数(authHeader),不全局 baked;TLS(dispatcher)按集群连接缓存共享。
import { Agent as UndiciAgent } from 'undici'
import { createHash } from 'node:crypto'

let allowedHosts = new Set((process.env.K8S_ALLOWED_HOSTS || '').split(',').map(v => v.trim()).filter(Boolean))
// 仅测试用:覆盖 allowedHosts(避免测试受部署环境 K8S_ALLOWED_HOSTS 影响)
export function _setAllowedHostsForTest(set) { allowedHosts = set }

export function normalizeServer(value) {
  const url = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Server 必须使用 http 或 https')
  if (allowedHosts.size && !allowedHosts.has(url.hostname)) throw new Error(`API Server 主机 ${url.hostname} 不在允许列表中`)
  url.pathname = url.pathname.replace(/\/$/, '')
  return url
}

const _dispatcherCache = new Map() // sig -> UndiciAgent
export function _clearDispatcherCacheForTest() { _dispatcherCache.clear() }
export function _dispatcherCacheSizeForTest() { return _dispatcherCache.size }
function _dispatcherSig({ ca, cert, key, insecure }) {
  return createHash('sha256').update(`${insecure ? 1 : 0}\n${ca || ''}\n${cert || ''}\n${key || ''}`).digest('hex')
}

// 取(并缓存)undici dispatcher:承载 mTLS(client cert+key+CA)与 insecure 开关。
// 缓存按 TLS 配置签名——同集群连接的多身份共享 agent(身份差异在每请求 Authorization 头,非连接级);
// client-cert 身份(cert/key 不同)自然分到不同 agent。API-key 高频调用不重复 new agent。
export function getDispatcher(opts) {
  const sig = _dispatcherSig(opts)
  let agent = _dispatcherCache.get(sig)
  if (!agent) {
    const connect = { rejectUnauthorized: !opts.insecure }
    if (opts.ca) connect.ca = opts.ca
    if (opts.cert) connect.cert = opts.cert
    if (opts.key) connect.key = opts.key
    agent = new UndiciAgent({ connect })
    _dispatcherCache.set(sig, agent)
    if (_dispatcherCache.size > 64) _dispatcherCache.delete(_dispatcherCache.keys().next().value) // 简单上限防泄漏
  }
  return agent
}

// 构造调用上下文。apiServer 传 URL(原样保留)或字符串(规范化,含 allowedHosts 校验)。
// 浏览器 session、平台 connect-cluster、API-key 请求都经此构造 → 统一形状,6 条 kube 路径零改动。
export function buildCallContext({ apiServer, authHeader, ca, cert, key, insecure }) {
  return {
    apiServer: apiServer instanceof URL ? apiServer : normalizeServer(apiServer),
    authHeader: authHeader || null,
    ca: ca || null, cert: cert || null, key: key || null,
    insecure: !!insecure,
    dispatcher: getDispatcher({ ca, cert, key, insecure }),
  }
}
