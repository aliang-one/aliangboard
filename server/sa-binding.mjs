// SA 绑定 / TokenRequest(T6):为绑定 SA 现签短期 token(audience=apiserver issuer, ≥600s),per-SA 缓存 + 单飞。
// preflight 已验证:audience=issuer、TTL 下限 600s、read 通、RBAC 边界生效、bootstrap 需 create serviceaccounts/token。
// codex #7/#8:缓存键含 cluster+ns+SA+audience;单飞防并行风暴;吊销 key 不靠 token 失效,靠每次 authorize(查 revoked)。

export const MIN_TTL_SECONDS = 600   // apiserver 下限(prefund 实测:may not be less than 10 minutes)
export const DEFAULT_TTL_SECONDS = 600

// 构造 TokenRequest body(纯函数,可单测)。TTL 钳到下限;audience 给则数组,不给则省略(apiserver 默认)。
export function buildTokenRequestBody({ audience, expirationSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const exp = Math.max(Number(expirationSeconds) || DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS)
  const spec = { expirationSeconds: exp }
  if (audience) spec.audiences = [audience]
  return JSON.stringify({ kind: 'TokenRequest', apiVersion: 'authentication.k8s.io/v1', spec })
}

const _cache = new Map()       // sig -> { token, mintedAt, expiresAt }
const _inflight = new Map()    // sig -> Promise<token>(单飞)

export function _clearSaTokenCacheForTest() { _cache.clear(); _inflight.clear() }

function _sig(apiServer, namespace, name, audience) {
  return `${apiServer.toString()}|${namespace}|${name}|${audience || ''}`
}

// 工厂:requestFn = (callCtx, path, init) => Promise<{body}>(= index.mjs 的 requestKubernetes)。
// audience = apiserver issuer(从 /.well-known/openid-configuration 发现)。reuseFraction = 复用寿命比例。
export function createSaBinding({ requestFn, audience, ttlSeconds = DEFAULT_TTL_SECONDS, reuseFraction = 0.8 }) {
  async function mint(callCtx, namespace, name) {
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts/${encodeURIComponent(name)}/token`
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: buildTokenRequestBody({ audience, expirationSeconds: ttlSeconds }) }
    const { body } = await requestFn(callCtx, path, init)
    if (!body?.status?.token) {
      throw new Error('TokenRequest 未返回 token(检查 bootstrap 凭据是否有 create serviceaccounts/token,或 audience 是否被 apiserver 认可)')
    }
    const expiresAt = body.status.expirationTimestamp ? Date.parse(body.status.expirationTimestamp) : Date.now() + ttlSeconds * 1000
    return { token: body.status.token, mintedAt: Date.now(), expiresAt }
  }
  return async function getSaToken(callCtx, { namespace, name }) {
    const sig = _sig(callCtx.apiServer, namespace, name, audience)
    const now = Date.now()
    const cached = _cache.get(sig)
    if (cached) {
      const lifetime = cached.expiresAt - cached.mintedAt
      if (lifetime > 0 && now - cached.mintedAt < reuseFraction * lifetime) return cached.token // 复用窗口内
    }
    if (_inflight.has(sig)) return _inflight.get(sig) // 单飞:同 SA 并发只 mint 一次
    const p = (async () => {
      try { const entry = await mint(callCtx, namespace, name); _cache.set(sig, entry); return entry.token }
      finally { _inflight.delete(sig) } // 失败也清,下次可重试
    })()
    _inflight.set(sig, p)
    return p
  }
}
