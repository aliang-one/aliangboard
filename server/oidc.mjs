// Wave 4 OIDC Task 2:provider 模块——discovery/JWKS 缓存(模块级,单进程网关不变式)、
// 授权 URL 拼装、authorization_code 兑换、id_token 验签(kid 轮换强刷一次)。
// 零新依赖:HTTP 走注入的 fetchImpl(默认 globalThis.fetch,测试桩形状 { ok, status, json() });
// 验签复用 Task 1 jwt-verify.mjs。settings 键(oidc.*,platform_settings):
//   enabled('1'/缺省)/issuer/clientId/clientSecret(明文惯例同 LLM key,GET 永不回传)/
//   scopes(缺省 'openid profile email')/groupsClaim(缺省 'groups')/usernameClaim(缺省 'preferred_username')
// 错误约定:new Error('<code>'):discovery/jwks/token(网络与文档面),验签错误透传 jwt-verify 的码。
import { verifyIdToken } from './jwt-verify.mjs'

export const OIDC_CACHE_TTL_MS = 12 * 3600 * 1000
const DEFAULTS = { scopes: 'openid profile email', groupsClaim: 'groups', usernameClaim: 'preferred_username' }
const SETTING_KEYS = ['oidc.enabled', 'oidc.issuer', 'oidc.clientId', 'oidc.clientSecret', 'oidc.scopes', 'oidc.groupsClaim', 'oidc.usernameClaim']

// 模块级缓存(单进程不变式;多 provider 实例共享):discovery 按 issuer、jwks 按 jwks_uri。
const discoveryCache = new Map() // issuer -> { doc, at }
const jwksCache = new Map()      // jwksUri -> { jwks, at }
export function _clearOidcCacheForTest() { discoveryCache.clear(); jwksCache.clear() }

export function createOidcProvider({ getSetting, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const readRaw = () => {
    const raw = {}
    for (const k of SETTING_KEYS) raw[k] = getSetting(k)
    return raw
  }

  const configured = (raw) => !!raw['oidc.issuer'] && !!raw['oidc.clientId']

  // jwks 拉取 + 缓存(force=true 越过缓存——轮换强刷专用);keys 非数组/非 2xx/网络拒绝/响应体
  // 非 JSON → 统一编码化 throw 'jwks'(审 1-2)。
  async function fetchJwks(jwksUri, { force = false } = {}) {
    const cached = jwksCache.get(jwksUri)
    if (!force && cached && Date.now() - cached.at < OIDC_CACHE_TTL_MS) return cached.jwks
    let res, jwks
    try {
      res = await fetchImpl(jwksUri)
      if (!res?.ok) throw new Error('jwks')
      jwks = await res.json()
    } catch (e) {
      if (e?.message === 'jwks') throw e
      throw new Error('jwks') // 网络拒绝 / json() 解析炸 → 编码化
    }
    if (!jwks || !Array.isArray(jwks.keys)) throw new Error('jwks')
    jwksCache.set(jwksUri, { jwks, at: Date.now() })
    return jwks
  }

  return {
    // 开关三条件:enabled==='1' 且 issuer+clientId 齐(spec §配置;开关缺省关=存量零感知)。
    isEnabled() {
      const raw = readRaw()
      return raw['oidc.enabled'] === '1' && configured(raw)
    },

    // 面向前端/管理卡的配置视图:clientSecret 永不出现,只回 hasSecret。
    getPublicConfig() {
      const raw = readRaw()
      return {
        enabled: raw['oidc.enabled'] === '1' && configured(raw),
        issuer: raw['oidc.issuer'] || null,
        clientId: raw['oidc.clientId'] || null,
        scopes: raw['oidc.scopes'] || DEFAULTS.scopes,
        groupsClaim: raw['oidc.groupsClaim'] || DEFAULTS.groupsClaim,
        usernameClaim: raw['oidc.usernameClaim'] || DEFAULTS.usernameClaim,
        hasSecret: !!raw['oidc.clientSecret'],
      }
    },

    // 内部全量(含 clientSecret);issuer/clientId 缺(未配置)→ null。
    getFullConfig() {
      const raw = readRaw()
      if (!configured(raw)) return null
      return {
        enabled: raw['oidc.enabled'] === '1',
        issuer: raw['oidc.issuer'],
        clientId: raw['oidc.clientId'],
        clientSecret: raw['oidc.clientSecret'] || null,
        scopes: raw['oidc.scopes'] || DEFAULTS.scopes,
        groupsClaim: raw['oidc.groupsClaim'] || DEFAULTS.groupsClaim,
        usernameClaim: raw['oidc.usernameClaim'] || DEFAULTS.usernameClaim,
      }
    },

    // OIDC Discovery:GET <issuer>/.well-known/openid-configuration,四字段齐才收且 doc.issuer
    // 必须与请求 issuer 相符(防错配端点);缓存 12h。网络拒绝/响应体非 JSON 同样编码化 'discovery'
    // (审 1-2:不把 TypeError/SyntaxError 裸传给上层 302 分支)。
    async discovery(issuer) {
      const cached = discoveryCache.get(issuer)
      if (cached && Date.now() - cached.at < OIDC_CACHE_TTL_MS) return cached.doc
      const url = `${String(issuer).replace(/\/+$/, '')}/.well-known/openid-configuration`
      let res, doc
      try {
        res = await fetchImpl(url)
        if (!res?.ok) throw new Error('discovery')
        doc = await res.json()
      } catch (e) {
        if (e?.message === 'discovery') throw e
        throw new Error('discovery') // fetch 网络拒绝 / json() 解析炸 → 编码化
      }
      if (!doc || typeof doc !== 'object'
        || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer
        || doc.issuer !== issuer) throw new Error('discovery')
      discoveryCache.set(issuer, { doc, at: Date.now() })
      return doc
    },

    // JWKS:经 discovery 的 jwks_uri 拉取(缓存按 jwks_uri,12h);返回 { keys: [...] }(verifyIdToken 形状)。
    async jwksFor(issuer) {
      const doc = await this.discovery(issuer)
      return fetchJwks(doc.jwks_uri)
    },

    // 授权码流第一步:authorization_endpoint + response_type=code + PKCE(S256)+ scope。
    // URLSearchParams 编码(RFC 6749 form-urlencoded,空格 '+' 是规范形态)。
    // 畸形 endpoint(非 URL)编码化 'discovery'(审 1-6:不裸传 URL 构造异常)。
    buildAuthUrl({ doc, clientId, redirectUri, state, nonce, codeChallenge, scopes }) {
      let url
      try { url = new URL(doc.authorization_endpoint) } catch { throw new Error('discovery') }
      const q = url.searchParams
      q.set('response_type', 'code')
      q.set('client_id', clientId)
      q.set('redirect_uri', redirectUri)
      q.set('state', state)
      q.set('nonce', nonce)
      q.set('code_challenge', codeChallenge)
      q.set('code_challenge_method', 'S256')
      q.set('scope', scopes)
      return url.toString()
    },

    // 授权码兑换(PKCE verifier):POST token_endpoint form-urlencoded;取 id_token,缺失/非 2xx/
    // 网络拒绝/响应体非 JSON → throw 'token'(审 1-2:统一编码化,上层按 302 分支处理)。
    async exchangeCode({ doc, clientId, clientSecret, redirectUri, code, codeVerifier }) {
      const body = new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
        code, redirect_uri: redirectUri, code_verifier: codeVerifier,
      }).toString()
      let res, json
      try {
        res = await fetchImpl(doc.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        })
        if (!res?.ok) throw new Error('token')
        json = await res.json()
      } catch (e) {
        if (e?.message === 'token') throw e
        throw new Error('token') // 网络拒绝 / json() 解析炸 → 编码化
      }
      if (!json?.id_token) throw new Error('token')
      return { idToken: json.id_token }
    },

    // 回调 id_token 验签:缓存 JWKS 验;unknown-kid(IdP 密钥轮换窗口)→ 强刷一次再验,仍败则败。
    // { refreshJwks:false } 关闭强刷(测试/省一跳)。
    async verifyCallbackIdToken(idToken, issuer, clientId, nonce, { refreshJwks = true } = {}) {
      const doc = await this.discovery(issuer)
      const jwks = await fetchJwks(doc.jwks_uri)
      try {
        return verifyIdToken(idToken, { jwks, issuer, audience: clientId, nonce })
      } catch (e) {
        if (e?.message !== 'unknown-kid' || !refreshJwks) throw e
        const fresh = await fetchJwks(doc.jwks_uri, { force: true })
        return verifyIdToken(idToken, { jwks: fresh, issuer, audience: clientId, nonce })
      }
    },
  }
}
