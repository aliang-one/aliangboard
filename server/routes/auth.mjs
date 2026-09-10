// 平台认证 + 集群接入 HTTP 端点从 server/index.mjs 抽出(handler/dispatcher 模式)。零行为变更。
// health / login / me / logout / my-clusters / connect-cluster 逐字搬迁,仅依赖引用改走 deps 注入。
// 用户可见消息走 ../messages.mjs 双语表(msg(req,'auth.xxx'));zh 默认与原文逐字一致。
import { msg } from '../messages.mjs'
import { tombstoneSession } from '../window-records.mjs'
import { buildImpersonation, impersonateDisplaynameFor } from '../impersonate.mjs'
import { APP_VERSION } from '../version.mjs'
import { resolvePasswordPolicy, firstFailedRule } from '../password-policy.mjs'
import { queryAuditLog } from '../audit.mjs'
import { effectiveGrants } from '../authz.mjs'
import { generateTotpSecret, otpauthUri, verifyTotp, generateRecoveryCodes, hashRecoveryCode } from '../totp.mjs'
import { oidcSubjectOf, upsertOidcUser, syncGroupsFromClaims } from '../oidc-provision.mjs'
import { WB_APPROVAL_MODES } from '../wb-approval-mode.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ===== Wave 3 MFA(§1.3):内存态票据/待落库密钥(模块级;单进程网关不变式,重启即失效=重走密码步) =====
// mfaTickets:login 密码步通过后签发 → login/mfa 第二步消费。5min TTL,单次(读即删);
//   导出仅供测试播种(过期票据用例),生产代码只经 login/login-mfa 两处触碰。
// mfaPendingSecrets:setup 生成的待验证密钥(不落库),5min,重复调用覆盖=轮换;
//   enable 以 body 传入的 secret 验码(此 Map 仅记录最近一次 pending,便于将来做绑定校验)。
export const mfaTickets = new Map()        // ticket -> { userId, username, exp }
export const mfaPendingSecrets = new Map() // userId  -> { secret, exp }
const MFA_TICKET_TTL_MS = 5 * 60_000
const MFA_PENDING_SECRET_TTL_MS = 5 * 60_000
const STEP_UP_MAX_AGE_MS = 10 * 60_000

// ===== Wave 4 OIDC(SSO):模块级单次票据(单进程网关不变式,与 mfaTickets 同政策) =====
// oidcStates:login 起跳签发 → callback 消费(读即删)。10min TTL、单次;nonce / PKCE verifier /
//   redirectUri 绑定在 entry 上(state 不是裸游标——防错绑与 redirect_uri 篡改)。
// oidcCodes:callback 成功签发 → exchange 消费(读即删)。60s TTL、单次、绑 IP——兑换码经浏览器 302
//   落地(可能进 Referrer),换 IP 即失效。导出仅供测试播种(过期用例),生产只经三端点触碰。
export const oidcStates = new Map() // state -> { nonce, verifier, redirectUri, exp }

// ===== 2026-09-08 性能批:/version 探活 TTL 缓存(模块级) =====
// connect-cluster 串行 await /version 是「首次连接慢」的直接构成(网关→apiserver 冷连接
// 实测 ~687ms);版本仅展示用,重连(应用重开/token 轮换)走 10min 缓存即可。
// 必须 module 级:createAuthRoutes 构造在每请求 handle() 内(见 index.mjs SP4 注释),
// 闭包级 Map 每请求重建=永不命中——与 mfaTickets/oidcStates 同款「单进程网关不变式」。
// 凭据签名(apiServer+authHeader+TLS 材料)入值,换凭据自然失效重探;凭据失效的暴露时点
// 从 connect 顺延到首个资源请求(hydrate 已有清晰错误面),TTL 过期即自愈。
const VERSION_CACHE_TTL_MS = 10 * 60_000
const versionCache = new Map() // clusterId -> { sig, version, at }
function versionCacheSig(cluster) {
  return createHash('sha256').update(JSON.stringify([
    cluster.apiServer, cluster.authHeader, cluster.ca, cluster.cert, cluster.key, !!cluster.insecure,
  ])).digest('hex')
}

export const oidcCodes = new Map()  // code  -> { userId, username, role, ip, exp }
const OIDC_STATE_TTL_MS = 10 * 60_000
const OIDC_CODE_TTL_MS = 60_000

// 回调地址从请求推导:socket 直连事实(encrypted→https),不信任 X-Forwarded-* 系头(与限流 IP 同口径);
// 反向代理场景由代理层保证 Host 正确(部署文档职责)。
function deriveOidcRedirectUri(req) {
  return `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host || 'localhost'}/api/auth/oidc/callback`
}

export function createAuthRoutes(deps) {
  const {
    // 首管一次性凭证文件所在目录(默认 <repo>/data;改密成功即删,CSO #13)
    dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data'),
    db, sendJson, readBody, requirePlatform,
    platformSessions, sessions, persistSession,
    verifyPassword, randomUUID, normalizeServer, buildCallContext, requestKubernetes,
    checkLoginRate, writeAudit,
    enforceSessionCap, maxPlatformSessionsPerUser,
    getSetting,
    removeSessionRecord,
    hashPassword, extractPlatformToken,
    impersonationProbe, // W2 Phase E(可选):connect-cluster 成功后 fire-and-forget 探测集群 impersonate 能力
    oidcProvider, // W4 OIDC:index.mjs 注入的 provider 单例(discovery/JWKS/exchange;缺省=端点回 disabled)
  } = deps

  // 读用户 prefs:SELECT/parse 全程容错——存量库无 prefs 列、坏 JSON 均回 {}(node:sqlite 拒绝非法绑定,这里只读标量)。
  function readPrefs(db, userId) {
    try {
      const row = db.prepare('SELECT prefs FROM platform_users WHERE id=?').get(userId)
      return JSON.parse(row?.prefs || '{}') || {}
    } catch { return {} }
  }

  // ===== Wave 3 MFA helpers =====
  // 恢复码校验:归一化后按哈希查(容错:存量库无表视作未命中)。命中未用码 → true;
  // consume=true 即焚(仅登录第二步消费——裁决 R2:disable/step-up 验过不消费,因用户已持完整会话)。
  function checkRecoveryCode(userId, code, { consume = false } = {}) {
    const hash = hashRecoveryCode(String(code))
    let row
    try { row = db.prepare('SELECT usedAt FROM mfa_recovery_codes WHERE userId=? AND codeHash=?').get(userId, hash) } catch { return false }
    if (!row || row.usedAt) return false
    if (consume) db.prepare('UPDATE mfa_recovery_codes SET usedAt=? WHERE userId=? AND codeHash=?').run(Date.now(), userId, hash)
    return true
  }

  // step-up 守卫(W3 §2):会话最近强认证(stepUpAt)距今 >10min(或从未)→ 409 {stepUpRequired:true},
  // 前端拦截该形状弹 TOTP 窗重放。守卫仅账户安全面(disable / setup-重置 / enable-重置 / 改密),
  // 普通操作不受约束。
  function requireStepUp(req, ps, res) {
    const last = Number(ps?.stepUpAt || 0)
    if (!last || Date.now() - last > STEP_UP_MAX_AGE_MS) {
      sendJson(res, 409, { stepUpRequired: true, message: msg(req, 'auth.stepUpRequired') })
      return false
    }
    return true
  }

  // login 成功尾段(W3 起两处共用,防漂移:密码直接通过 / login/mfa 二步通过):
  // 建平台会话(内存+DB,stepUpAt=now——刚完成密码/MFA 认证)+ 会话上限 + 审计 + token/user/prefs 响应。
  // W3 §1.5:admin 强制开关(auth.mfa.required='1')开 + 用户未启用 MFA → 受限 token(mfaPending=1,
  // platformUserFromRequest 仅放行 MFA 引导白名单);MFA 用户二步通过即完整会话。开关关 → 恒 0(零感知)。
  function finishLogin(req, res, user, ip, auditOk) {
    const token = randomUUID()
    const psNow = Date.now()
    const userAgent = String(req.headers['user-agent'] || '')
    const mfaPending = getSetting?.('auth.mfa.required') === '1' && !user.totpSecret ? 1 : 0
    const ps = { token, userId: user.id, username: user.username, role: user.role, createdAt: psNow, k8sSessionToken: null, ip, userAgent, lastSeenAt: psNow, mfaPending, stepUpAt: psNow }
    platformSessions.set(token, ps)
    db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt,ip,userAgent,lastSeenAt,mfaPending,stepUpAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(token, user.id, user.username, user.role, psNow, ip, userAgent, psNow, mfaPending, psNow)
    // 会话数量上限(2026-08-30 设计 §3.2):超出踢最久未活跃的旧会话,刚建的本会话永不踢;
    // 被踢会话的 K8s 凭据由 enforceSessionCap 一并回收。强制失败不阻断登录(降级不踢)。
    try {
      enforceSessionCap?.({ platformSessions, db, sessions, userId: user.id, owner: user.username,
        max: maxPlatformSessionsPerUser, keepToken: token, now: psNow, writeAudit })
    } catch (e) { console.error('[auth] 会话上限强制失败(降级不踢):', e?.message || e) }
    auditOk()
    // totpEnabled(W3 Task 4):前端安全卡/登录页据渲染二步态;!! 化避免明文 secret 出响应。
    sendJson(res, 200, { token, user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName, createdAt: user.createdAt, totpEnabled: !!user.totpSecret }, prefs: readPrefs(db, user.id) })
  }

  // OIDC 会话落成(W4 §D3):响应形状与 finishLogin 一致(token/user/prefs)+ stepUpAt=now(IdP 认证即
  // 最近一次强认证)。**不设 mfaPending(裁决 R1)**——OIDC 用户已由 IdP 完成认证,本地 MFA 强制开关
  // (auth.mfa.required)是「本地口令 + 本地第二因子」的配对语义,对外部身份不适用;恒 0。
  // disabled 用户拒绝(W4-A 前瞻裁决 1):upsert 建户 ≠ 放行——禁用的 OIDC 用户不得获得会话;返 false
  // 由调用方按各自面(302 错误码 / 401)处理。
  function finishOidcSession(req, res, user, ip, auditOk) {
    if (!user || user.disabled) return false
    const token = randomUUID()
    const psNow = Date.now()
    const userAgent = String(req.headers['user-agent'] || '')
    const ps = { token, userId: user.id, username: user.username, role: user.role, createdAt: psNow, k8sSessionToken: null, ip, userAgent, lastSeenAt: psNow, mfaPending: 0, stepUpAt: psNow }
    platformSessions.set(token, ps)
    db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt,ip,userAgent,lastSeenAt,mfaPending,stepUpAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(token, user.id, user.username, user.role, psNow, ip, userAgent, psNow, 0, psNow)
    try {
      enforceSessionCap?.({ platformSessions, db, sessions, userId: user.id, owner: user.username,
        max: maxPlatformSessionsPerUser, keepToken: token, now: psNow, writeAudit })
    } catch (e) { console.error('[auth] 会话上限强制失败(降级不踢):', e?.message || e) }
    auditOk()
    sendJson(res, 200, { token, user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName, createdAt: user.createdAt, totpEnabled: !!user.totpSecret }, prefs: readPrefs(db, user.id) })
    return true
  }

  // 匹配 auth 路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  async function handle(req, res, url) {
    // GET /api/health — 无鉴权健康检查(负载均衡/存活探针)
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'aliangboard-api', time: new Date().toISOString(), version: APP_VERSION })
      return true
    }

    // POST /api/auth/login — 平台登录(用户名/密码 → 平台 session)
    // 安全(2026-08-28 CSO 审计 #3):按 IP+用户名限流(防无限速暴力破解,checkRate 此前只挂 /api/key/*);
    // 失败/成功均写审计(tool=platform_login)——用户名不存在同样消耗预算,防枚举式并行爆破。
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        const { username, password } = await readBody(req)
        if (!username || !password) { sendJson(res, 400, { message: msg(req, 'auth.emptyCredentials') }); return true }
        const ip = req.socket?.remoteAddress || 'unknown'
        const rl = checkLoginRate(`${ip}|${username}`)
        if (!rl.allowed) {
          writeAudit?.(db, { owner: String(username), verb: 'login', tool: 'platform_login', result: 'ratelimited', reason: 'too-many-attempts', requestSummary: `ip=${ip}`, source: 'platform' })
          sendJson(res, 429, { message: msg(req, 'auth.rateLimited'), retryAfter: rl.retryAfter })
          return true
        }
        const auditLogin = (result, reason = null) => writeAudit?.(db, { owner: String(username), verb: 'login', tool: 'platform_login', result, reason, requestSummary: `ip=${ip}`, source: 'platform' })
        const user = db.prepare('SELECT * FROM platform_users WHERE username=?').get(username)
        if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
          auditLogin('denied', 'bad-credentials')
          sendJson(res, 401, { message: msg(req, 'auth.badCredentials') }); return true
        }
        // W3 §1.3(TOTP 二步):已启用 MFA → 不发 token,签发 5min 单次 mfaTicket(密码步=第一步通过);
        // 第二步 POST /api/auth/login/mfa。未启用者路径零变化(裁决 R5 回归锚钉死)。
        if (user.totpSecret) {
          const ticket = randomUUID()
          mfaTickets.set(ticket, { userId: user.id, username: user.username, exp: Date.now() + MFA_TICKET_TTL_MS })
          auditLogin('ok', 'mfa-required')
          sendJson(res, 200, { mfaRequired: true, mfaTicket: ticket })
          return true
        }
        finishLogin(req, res, user, ip, () => auditLogin('ok'))
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.loginFailed') }); return true }
    }

    // POST /api/auth/login/mfa — 登录二步第二步(W3 §1.3):mfaTicket(密码步签发,5min 单次)+ TOTP/恢复码。
    // ROUTE_AUTH class none,但自身独立限流(键 `mfa|ip|username`,防 ticket 5min 有效期内对 6 位码暴力)。
    if (url.pathname === '/api/auth/login/mfa' && req.method === 'POST') {
      try {
        const { username, mfaTicket, code } = await readBody(req)
        if (!username || !mfaTicket || !code) { sendJson(res, 400, { message: msg(req, 'auth.mfaInputRequired') }); return true }
        const ip = req.socket?.remoteAddress || 'unknown'
        const rl = checkLoginRate(`mfa|${ip}|${username}`)
        if (!rl.allowed) {
          writeAudit?.(db, { owner: String(username), verb: 'login', tool: 'platform_login', result: 'ratelimited', reason: 'too-many-attempts-mfa', requestSummary: `ip=${ip}`, source: 'platform' })
          sendJson(res, 429, { message: msg(req, 'auth.rateLimited'), retryAfter: rl.retryAfter })
          return true
        }
        const auditMfa = (result, reason = null) => writeAudit?.(db, { owner: String(username), verb: 'login', tool: 'platform_login', result, reason, requestSummary: `ip=${ip}`, source: 'platform' })
        // 票据:读即删(单次);过期/未签发/用户名错绑同报 invalid——不泄漏票据存在性。
        const ticket = mfaTickets.get(mfaTicket)
        mfaTickets.delete(mfaTicket)
        if (!ticket || ticket.exp < Date.now() || ticket.username !== String(username) || ticket.userId == null) {
          auditMfa('denied', 'bad-mfa-ticket')
          sendJson(res, 401, { message: msg(req, 'auth.mfaTicketInvalid') }); return true
        }
        const user = db.prepare('SELECT * FROM platform_users WHERE id=?').get(ticket.userId)
        if (!user || user.disabled || !user.totpSecret || user.username !== String(username)) {
          auditMfa('denied', 'bad-mfa-ticket')
          sendJson(res, 401, { message: msg(req, 'auth.mfaTicketInvalid') }); return true
        }
        // 验码:TOTP 或恢复码(恢复码即焚——仅此处消费,裁决 R2)。
        let via = null
        if (verifyTotp(user.totpSecret, String(code))) via = 'totp'
        else if (checkRecoveryCode(user.id, code, { consume: true })) via = 'recovery'
        if (!via) {
          auditMfa('denied', 'bad-mfa-code')
          sendJson(res, 401, { message: msg(req, 'auth.mfaCodeInvalid') }); return true
        }
        finishLogin(req, res, user, ip, () => auditMfa('ok', `via=${via}`))
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.loginFailed') }); return true }
    }

    // ===== Wave 4 OIDC(SSO)三端点(ROUTE_AUTH class none,精确登记;302 一律 writeHead+end 不经 sendJson) =====
    // GET /api/auth/oidc/login — SSO 起跳:未启用(开关缺省关=存量零感知)回 302 oidcError=disabled
    // (前端按钮恒显示,零配置探测);启用则 discovery→签 state/nonce/PKCE→302 授权 URL。
    if (url.pathname === '/api/auth/oidc/login' && req.method === 'GET') {
      try {
        // W4-B 审 2:匿名 GET 先限流(键 `oidcl|<ip>`,容量 5)——先于任何审计写入/Map 插入
        // (否则匿名扫描可无界刷 denied 审计行 + 堆 oidcStates)。
        const ip = req.socket?.remoteAddress || 'unknown'
        const rl = checkLoginRate(`oidcl|${ip}`)
        if (!rl.allowed) {
          writeAudit?.(db, { owner: null, verb: 'login', tool: 'oidc_login', result: 'denied', reason: 'ratelimited', requestSummary: `ip=${ip}`, source: 'platform' })
          res.writeHead(302, { location: '/login?oidcError=ratelimited' }); res.end()
          return true
        }
        if (!oidcProvider?.isEnabled()) {
          writeAudit?.(db, { owner: null, verb: 'login', tool: 'oidc_login', result: 'denied', reason: 'disabled', requestSummary: `ip=${ip}`, source: 'platform' })
          res.writeHead(302, { location: '/login?oidcError=disabled' }); res.end()
          return true
        }
        const cfg = oidcProvider.getFullConfig()
        // 授权 URL 需要 authorization_endpoint → discovery;上游不可用统一回 token(白名单码里上游网络面的归属)
        const doc = await oidcProvider.discovery(cfg.issuer)
        const state = randomUUID()
        const nonce = randomUUID()
        const verifier = randomBytes(32).toString('base64url') // RFC 7636 code_verifier:43-128 字符
        const codeChallenge = createHash('sha256').update(verifier).digest('base64url')
        const redirectUri = deriveOidcRedirectUri(req)
        oidcStates.set(state, { nonce, verifier, redirectUri, exp: Date.now() + OIDC_STATE_TTL_MS })
        // W4-B 审 2:廉价上界——签发时 Map 超 1000 条顺手清过期项(正常流量远达不到;防匿名堆积)
        if (oidcStates.size > 1000) {
          const nowMs = Date.now()
          for (const [k, v] of oidcStates) if (v.exp < nowMs) oidcStates.delete(k)
        }
        res.writeHead(302, { location: oidcProvider.buildAuthUrl({ doc, clientId: cfg.clientId, redirectUri, state, nonce, codeChallenge, scopes: cfg.scopes }) })
        res.end()
        return true
      } catch (e) {
        // W4-B 审 4:discovery 失败不再静默 302——留 denied/token 审计行(排障面)
        writeAudit?.(db, { owner: null, verb: 'login', tool: 'oidc_login', result: 'denied', reason: 'token', requestSummary: `error=${e?.message || 'unknown'}`, source: 'platform' })
        res.writeHead(302, { location: '/login?oidcError=token' }); res.end()
        return true
      }
    }

    // GET /api/auth/oidc/callback — IdP 回跳。顺序:匿名限流(oidcl|ip)→ kill-switch(开关已关 → disabled,
    // state 作废)→ IdP error 参数(用户在 IdP 侧拒绝)→ denied → state 消费(读即删,过期/未知/缺 code →
    // state)→ PKCE 兑换(网络/端点面失败 → token)→ id_token 全验(nonce 显式传入;验签/claims 面 →
    // verify)→ JIT 建户(usernameTaken 拒接管;建库面异常 → jit)→ disabled 拒(W4-A 裁决 1)→ 组同步 →
    // 签 60s 单次兑换码 → 302 /login?oidcCode=<code>。
    if (url.pathname === '/api/auth/oidc/callback' && req.method === 'GET') {
      try {
        const ip = req.socket?.remoteAddress || 'unknown'
        const q = url.searchParams
        const auditOidc = (result, reason = null, summary = `ip=${ip}`, owner = null) =>
          writeAudit?.(db, { owner, verb: 'login', tool: 'oidc_login', result, reason, requestSummary: summary, source: 'platform' })
        // W4-B 审 2:匿名 GET 先限流(键 `oidcl|<ip>`,与 login 同键同桶)——先于任何审计副作用/Map 触碰
        const rl = checkLoginRate(`oidcl|${ip}`)
        if (!rl.allowed) {
          auditOidc('denied', 'ratelimited')
          res.writeHead(302, { location: '/login?oidcError=ratelimited' }); res.end()
          return true
        }
        // W4-B 审 1(kill-switch 尾巴):起跳后开关被关 → 在途回调即刻止血(不再触 IdP 兑换);state 即行作废
        if (!oidcProvider?.isEnabled()) {
          const ksState = q.get('state')
          if (ksState) oidcStates.delete(ksState)
          auditOidc('denied', 'disabled')
          res.writeHead(302, { location: '/login?oidcError=disabled' }); res.end()
          return true
        }
        // IdP 侧拒绝(用户取消授权等):不进兑换流程;state 若带回即行作废(单次语义)
        const idpError = q.get('error')
        if (idpError) {
          const errState = q.get('state')
          if (errState) oidcStates.delete(errState)
          auditOidc('denied', 'denied', `ip=${ip} idpError=${idpError}`)
          res.writeHead(302, { location: '/login?oidcError=denied' }); res.end()
          return true
        }
        const state = q.get('state'), code = q.get('code')
        const st = state ? oidcStates.get(state) : null
        if (state) oidcStates.delete(state) // 读即删(单次;未知 state 同报 state——不泄漏存在性)
        if (!code || !st || st.exp < Date.now()) {
          auditOidc('denied', 'state')
          res.writeHead(302, { location: '/login?oidcError=state' }); res.end()
          return true
        }
        const cfg = oidcProvider.getFullConfig()
        let claims
        try {
          const doc = await oidcProvider.discovery(cfg.issuer)
          const { idToken } = await oidcProvider.exchangeCode({ doc, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: st.redirectUri, code, codeVerifier: st.verifier })
          // W4-A 前瞻裁决 2:nonce 恒显式传入——undefined 会让 verifyIdToken 跳过 nonce 校验(重放洞)
          ;({ claims } = await oidcProvider.verifyCallbackIdToken(idToken, cfg.issuer, cfg.clientId, st.nonce))
        } catch (e) {
          // 错误码映射:discovery/exchange/jwks 面(上游网络与端点不可用,W4-B 审 3:jwks 停摆≠验签失败)
          // → token;id_token 验签/claims 面(jwt-verify 各码)→ verify
          const rc = e?.message === 'token' || e?.message === 'discovery' || e?.message === 'jwks' ? 'token' : 'verify'
          auditOidc('denied', rc)
          res.writeHead(302, { location: `/login?oidcError=${rc}` }); res.end()
          return true
        }
        // claims 提取:usernameClaim 缺省 preferred_username,claim 缺失回退 sub;groups claim 缺失视为 []
        // (裁决 R3);present 但非 string[] → 整次登录拒(→ verify:claims 形状校验失败,先于建户防半拉供给)。
        const username = String(claims[cfg.usernameClaim || 'preferred_username'] ?? claims.sub ?? '')
        const displayName = typeof claims.name === 'string' ? claims.name : null
        const rawGroups = claims[cfg.groupsClaim || 'groups']
        const groups = rawGroups === undefined || rawGroups === null ? [] : rawGroups
        if (!claims.sub || typeof claims.sub !== 'string' || !username || !Array.isArray(groups) || !groups.every((g) => typeof g === 'string')) {
          auditOidc('denied', 'verify', `sub=${claims?.sub ?? '?'} reason=claims-shape`)
          res.writeHead(302, { location: '/login?oidcError=verify' }); res.end()
          return true
        }
        // JIT 建户 + 组同步(upsert 三路:已知 subject 更新 / username 被占拒接管 / 新建;组全量对齐)
        const existed = !!db.prepare('SELECT id FROM platform_users WHERE oidcSubject=?').get(oidcSubjectOf(cfg.issuer, claims.sub))
        let user
        try {
          const out = upsertOidcUser(db, { issuer: cfg.issuer, sub: claims.sub, username, displayName }, { hashPassword, randomUUID })
          if (out.error === 'usernameTaken') {
            auditOidc('denied', 'usernameTaken', `sub=${claims.sub} username=${username}`)
            res.writeHead(302, { location: '/login?oidcError=usernameTaken' }); res.end()
            return true
          }
          user = out.user
          syncGroupsFromClaims(db, user.id, groups) // 形状已在前置校验;此处 throw 只剩 DB 面 → jit
        } catch (e) {
          auditOidc('denied', 'jit', `sub=${claims.sub} reason=${e?.message || 'error'}`)
          res.writeHead(302, { location: '/login?oidcError=jit' }); res.end()
          return true
        }
        // W4-A 前瞻裁决 1:disabled 检查在 upsert 之后——建户 ≠ 放行,禁用的 OIDC 用户不得进入会话轨道
        if (user.disabled) {
          auditOidc('denied', 'disabled', `sub=${claims.sub} created=${existed ? 0 : 1}`)
          res.writeHead(302, { location: '/login?oidcError=disabled' }); res.end()
          return true
        }
        // 兑换码(60s 单次、绑 IP):浏览器经 302 拿码 → 前端 POST exchange 换平台会话
        const exchangeCode = randomUUID()
        oidcCodes.set(exchangeCode, { userId: user.id, username: user.username, role: user.role, ip, exp: Date.now() + OIDC_CODE_TTL_MS })
        auditOidc('ok', null, `sub=${claims.sub} created=${existed ? 0 : 1} groups=${groups.length}`, user.username)
        res.writeHead(302, { location: `/login?oidcCode=${exchangeCode}` }); res.end()
        return true
      } catch (e) {
        // 未预期异常兜底:不给 500(登录页期望 302),落 jit 码 + 审计
        writeAudit?.(db, { owner: null, verb: 'login', tool: 'oidc_login', result: 'denied', reason: 'jit', requestSummary: `error=${e?.message || 'unknown'}`, source: 'platform' })
        res.writeHead(302, { location: '/login?oidcError=jit' }); res.end()
        return true
      }
    }

    // POST /api/auth/oidc/exchange {code} — 兑换码换平台会话。独立限流键 `oidcx|<ip>`(容量 5/10s 回 1,
    // 复用 checkLoginRate 桶但键空间隔离);kill-switch 已关 → 401 同错码文案(W4-B 审 1);码读即删=单次
    // (重放 401)、绑 IP(经 Referrer 泄漏到他处失效)。
    if (url.pathname === '/api/auth/oidc/exchange' && req.method === 'POST') {
      try {
        const { code } = await readBody(req)
        if (!code) { sendJson(res, 400, { message: msg(req, 'auth.oidcCodeRequired') }); return true }
        const ip = req.socket?.remoteAddress || 'unknown'
        const rl = checkLoginRate(`oidcx|${ip}`)
        if (!rl.allowed) {
          writeAudit?.(db, { owner: null, verb: 'login', tool: 'oidc_login', result: 'ratelimited', reason: 'too-many-attempts', requestSummary: `ip=${ip}`, source: 'platform' })
          sendJson(res, 429, { message: msg(req, 'auth.rateLimited'), retryAfter: rl.retryAfter })
          return true
        }
        // W4-B 审 1(kill-switch 尾巴):兑换前开关已关 → 401 与错码同文案(不泄漏码存在性);
        // 码呈现即消费(单次语义),重开开关也救不回已呈现过的码。
        if (!oidcProvider?.isEnabled()) {
          oidcCodes.delete(String(code))
          writeAudit?.(db, { owner: null, verb: 'login', tool: 'oidc_login', result: 'denied', reason: 'disabled', requestSummary: 'via=exchange kill-switch', source: 'platform' })
          sendJson(res, 401, { message: msg(req, 'auth.oidcCodeInvalid') })
          return true
        }
        const entry = typeof code === 'string' ? oidcCodes.get(code) : null
        oidcCodes.delete(String(code)) // 读即删(单次;未知码同 401——不泄漏存在性)
        if (!entry || entry.exp < Date.now() || entry.ip !== ip) {
          writeAudit?.(db, { owner: null, verb: 'login', tool: 'oidc_login', result: 'denied', reason: 'bad-code', requestSummary: `ip=${ip}`, source: 'platform' })
          sendJson(res, 401, { message: msg(req, 'auth.oidcCodeInvalid') })
          return true
        }
        const user = db.prepare('SELECT * FROM platform_users WHERE id=?').get(entry.userId)
        if (!user) {
          writeAudit?.(db, { owner: entry.username, verb: 'login', tool: 'oidc_login', result: 'denied', reason: 'bad-code', requestSummary: 'user-gone', source: 'platform' })
          sendJson(res, 401, { message: msg(req, 'auth.oidcCodeInvalid') })
          return true
        }
        // 纵深:callback 已拒 disabled;60s 兑换窗口内被禁用的兜底(finishOidcSession 内再核)
        if (user.disabled) {
          writeAudit?.(db, { owner: user.username, verb: 'login', tool: 'oidc_login', result: 'denied', reason: 'disabled', requestSummary: 'via=exchange', source: 'platform' })
          sendJson(res, 401, { message: msg(req, 'auth.oidcAccountDisabled') })
          return true
        }
        // ok 审计在 callback 已写(sub/created/groups 口径);exchange 成功不重复计数
        if (!finishOidcSession(req, res, user, ip, () => {})) {
          writeAudit?.(db, { owner: user.username, verb: 'login', tool: 'oidc_login', result: 'denied', reason: 'disabled', requestSummary: 'via=exchange', source: 'platform' })
          sendJson(res, 401, { message: msg(req, 'auth.oidcAccountDisabled') })
        }
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.loginFailed') }); return true }
    }

    // POST /api/auth/mfa/setup — 生成待验证密钥(W3 §1.3):不落库;同会话重复调用轮换(覆盖);
    // 已启用者需 step-up(重置场景)。响应含 base32 secret + otpauth URI(认证器扫码/手输)。
    if (url.pathname === '/api/auth/mfa/setup' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const user = db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get(ps.userId)
        const auditSetup = (result, reason = null) => writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'platform_mfa_setup', result, reason, source: 'platform' })
        // 已启用者重置密钥需 step-up;409 同样写 denied 审计(review round 1:与 enable/disable 的 denied 口径一致)
        if (user?.totpSecret && !requireStepUp(req, ps, res)) { auditSetup('denied', 'step-up-required'); return true }
        const secret = generateTotpSecret()
        mfaPendingSecrets.set(ps.userId, { secret, exp: Date.now() + MFA_PENDING_SECRET_TTL_MS })
        auditSetup('ok')
        sendJson(res, 200, { secret, otpauthUri: otpauthUri(secret, ps.username) })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.mfaFailed') }); return true }
    }

    // POST /api/auth/mfa/enable {secret, code} — 验码通过 → totpSecret 落库 + 10 恢复码哈希入库(单事务:
    // 部分失败整体回滚)+ stepUpAt=now(刚验过码);恢复码明文仅此次下发(刷新后不可再取)。
    // review round 1(controller 裁决补录):已启用账户再 enable = 同时替换两个因子(TOTP 密钥+恢复码组),
    // 落在 step-up 禁改面内——与 disable/setup 同周界,先于验码执行。
    if (url.pathname === '/api/auth/mfa/enable' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const { secret, code } = await readBody(req)
        if (!secret || !code) { sendJson(res, 400, { message: msg(req, 'auth.mfaInputRequired') }); return true }
        const auditEnable = (result, reason = null) => writeAudit?.(db, { owner: ps.username, verb: 'change', tool: 'platform_mfa_enable', result, reason, source: 'platform' })
        const existing = db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get(ps.userId)
        if (existing?.totpSecret && !requireStepUp(req, ps, res)) { auditEnable('denied', 'step-up-required'); return true }
        if (!verifyTotp(String(secret), String(code))) {
          auditEnable('denied', 'bad-code')
          sendJson(res, 400, { message: msg(req, 'auth.mfaCodeInvalid') }); return true
        }
        const codes = generateRecoveryCodes(10)
        const now = Date.now()
        const token = extractPlatformToken(req)
        db.exec('BEGIN')
        try {
          db.prepare('UPDATE platform_users SET totpSecret=? WHERE id=?').run(String(secret), ps.userId)
          db.prepare('DELETE FROM mfa_recovery_codes WHERE userId=?').run(ps.userId) // 重复启用=换码组,旧恢复码全作废
          const ins = db.prepare('INSERT INTO mfa_recovery_codes (userId,codeHash,usedAt) VALUES (?,?,NULL)')
          for (const c of codes) ins.run(ps.userId, c.hash)
          // W3 §1.5:受限 token 在此转正(mfaPending=0);stepUpAt=now(刚验过码)
          if (token) db.prepare('UPDATE platform_sessions SET stepUpAt=?, mfaPending=0 WHERE token=?').run(now, token)
          db.exec('COMMIT')
        } catch (e) { db.exec('ROLLBACK'); throw e }
        ps.stepUpAt = now
        ps.mfaPending = 0
        mfaPendingSecrets.delete(ps.userId)
        auditEnable('ok', `codes=${codes.length}`)
        sendJson(res, 200, { ok: true, recoveryCodes: codes.map(c => c.plaintext) })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.mfaFailed') }); return true }
    }

    // POST /api/auth/mfa/disable {code} — TOTP 或恢复码验过 → 清 totpSecret + 恢复码(事务);必须 step-up
    // (W3 §1.3)。恢复码在此不消费(R2:仅登录即焚)。未启用 400 先于 409(review round 1:未启用账户
    // 不存在「账户安全面」可言,先告知状态再谈重验)。
    if (url.pathname === '/api/auth/mfa/disable' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const { code } = await readBody(req)
        const user = db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get(ps.userId)
        if (!user?.totpSecret) { sendJson(res, 400, { message: msg(req, 'auth.mfaNotEnabled') }); return true }
        if (!requireStepUp(req, ps, res)) return true
        const auditDisable = (result, reason = null) => writeAudit?.(db, { owner: ps.username, verb: 'change', tool: 'platform_mfa_disable', result, reason, source: 'platform' })
        if (!code || (!verifyTotp(user.totpSecret, String(code)) && !checkRecoveryCode(ps.userId, code))) {
          auditDisable('denied', 'bad-code')
          sendJson(res, 401, { message: msg(req, 'auth.mfaCodeInvalid') }); return true
        }
        db.exec('BEGIN')
        try {
          db.prepare('UPDATE platform_users SET totpSecret=NULL WHERE id=?').run(ps.userId)
          db.prepare('DELETE FROM mfa_recovery_codes WHERE userId=?').run(ps.userId)
          db.exec('COMMIT')
        } catch (e) { db.exec('ROLLBACK'); throw e }
        auditDisable('ok')
        sendJson(res, 200, { ok: true })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.mfaFailed') }); return true }
    }

    // POST /api/auth/step-up {code} — 重认证(W3 §2):TOTP/恢复码验过 → 会话 stepUpAt=now(内存+DB),
    // 10min 内账户安全操作(改密/MFA disable/setup-重置/enable-重置)免再验。恢复码不即焚(裁决 R2:
    // 用户已持完整会话,step-up 防的是 CSRF/偷拍屏,非首次身份证明;即焚仅在登录第二步)。
    if (url.pathname === '/api/auth/step-up' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const { code } = await readBody(req)
        const user = db.prepare('SELECT totpSecret FROM platform_users WHERE id=?').get(ps.userId)
        if (!user?.totpSecret) { sendJson(res, 400, { message: msg(req, 'auth.mfaNotEnabled') }); return true }
        const auditStepUp = (result, reason = null) => writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'platform_step_up', result, reason, source: 'platform' })
        if (!code || (!verifyTotp(user.totpSecret, String(code)) && !checkRecoveryCode(ps.userId, code))) {
          auditStepUp('denied', 'bad-code')
          sendJson(res, 401, { message: msg(req, 'auth.mfaCodeInvalid') }); return true
        }
        const now = Date.now()
        const token = extractPlatformToken(req)
        if (token) db.prepare('UPDATE platform_sessions SET stepUpAt=? WHERE token=?').run(now, token)
        ps.stepUpAt = now
        auditStepUp('ok')
        sendJson(res, 200, { ok: true })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.mfaFailed') }); return true }
    }

    // GET /api/auth/me — 当前登录用户信息(含 grants 下发,仅展示)
    // W3 Task 4:user.totpEnabled(安全卡二步验证态;SELECT 加 totpSecret 但显式重建响应对象,
    // 明文 secret 永不出端点)+ 顶层 mfaPending(受限 token 判定:enable 成功后前端据此引导重新登录)。
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const row = db.prepare('SELECT id,username,role,displayName,createdAt,totpSecret FROM platform_users WHERE id=?').get(ps.userId)
      const user = { id: row.id, username: row.username, role: row.role, displayName: row.displayName, createdAt: row.createdAt, totpEnabled: !!row.totpSecret }
      const az = effectiveGrants(db, { userId: ps.userId, role: ps.role })
      const grants = az.role === 'admin'
        ? { role: 'admin' }
        : { role: 'user', clusters: Object.fromEntries([...az.clusters.entries()].map(([cid, { mode, ns }]) => [cid, { mode, namespaces: [...ns.entries()].map(([namespace, level]) => ({ namespace, level })) }])) }
      sendJson(res, 200, { user, prefs: readPrefs(db, ps.userId), grants, mfaPending: ps.mfaPending === 1 })
      return true
    }

    // GET /api/my/grantable-ns?clusterId= — 自助令牌可签发的 namespace 集(allowlist 集群 = 本人该集群授权;
    // open 集群无 ns 级自助限制语义,Phase C 一并裁,现恒 409)。
    if (url.pathname === '/api/my/grantable-ns' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const clusterId = url.searchParams.get('clusterId') || ''
      if (ps.role !== 'admin') {
        const assigned = db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(ps.userId, clusterId)
        if (!assigned) { sendJson(res, 403, { message: msg(req, 'auth.clusterForbidden') }); return true }
      }
      const cluster = db.prepare('SELECT nsAuthMode FROM clusters WHERE id=?').get(clusterId)
      if (!cluster) { sendJson(res, 403, { message: msg(req, 'auth.clusterForbidden') }); return true }
      if ((cluster.nsAuthMode || 'open') === 'open') { sendJson(res, 409, { message: msg(req, 'auth.grantableOpenCluster') }); return true }
      // admin 不受 ns 级限制(spec §6.1);effectiveGrants 对 admin 返回 clusters:'ALL' 无 Map 可 .get,须短路
      if (ps.role === 'admin') { sendJson(res, 200, { namespaces: [], mode: 'admin' }); return true }
      const az = effectiveGrants(db, { userId: ps.userId, role: ps.role })
      const entry = az.clusters.get(clusterId)
      sendJson(res, 200, { namespaces: entry ? [...entry.ns.entries()].map(([namespace, level]) => ({ namespace, level })) : [] })
      return true
    }

    // PATCH /api/auth/me — 自助资料(2026-08-29 设计;Wave1 §3.5 扩头像)。
    // 白名单:displayName / avatar(data URL) / avatarClear;username/role/passwordHash 静默忽略(防穿越)。
    // 头像:仅 png/jpeg/webp,解码后 ≤200KB,存 SQLite blob(单库不变式);响应 user 恒不含 avatar 本体。
    const AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp']
    const AVATAR_MAX_BYTES = 200 * 1024
    if (url.pathname === '/api/auth/me' && req.method === 'PATCH') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const input = await readBody(req)
      if (input.displayName == null && input.avatar == null && !input.avatarClear) {
        sendJson(res, 400, { message: msg(req, 'auth.noUpdateFields') }); return true
      }
      if (input.displayName != null) {
        const displayName = String(input.displayName).trim().slice(0, 64)
        db.prepare('UPDATE platform_users SET displayName=? WHERE id=?').run(displayName || null, ps.userId)
      }
      if (input.avatarClear) {
        db.prepare('UPDATE platform_users SET avatar=NULL, avatarMime=NULL WHERE id=?').run(ps.userId)
      }
      if (input.avatar != null) {
        const m = typeof input.avatar === 'string' ? input.avatar.match(/^data:([^;,]+);base64,(.*)$/s) : null
        const buf = m ? Buffer.from(m[2], 'base64') : null
        if (!m || !AVATAR_MIMES.includes(m[1]) || !buf.length || buf.length > AVATAR_MAX_BYTES) {
          sendJson(res, 400, { message: msg(req, 'auth.avatarInvalid') }); return true
        }
        db.prepare('UPDATE platform_users SET avatar=?, avatarMime=? WHERE id=?').run(buf, m[1], ps.userId)
      }
      const user = db.prepare('SELECT id,username,role,displayName,createdAt FROM platform_users WHERE id=?').get(ps.userId)
      sendJson(res, 200, { user })
      return true
    }

    // GET /api/auth/me/avatar — 头像读取(JSON dataUrl;header 鉴权,不走 <img> 裸链,Wave1 §3.5 裁决)
    if (url.pathname === '/api/auth/me/avatar' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const row = db.prepare('SELECT avatar, avatarMime FROM platform_users WHERE id=?').get(ps.userId)
      if (!row || !row.avatar) { sendJson(res, 404, { message: msg(req, 'auth.avatarNotFound') }); return true }
      const buf = Buffer.isBuffer(row.avatar) ? row.avatar : Buffer.from(row.avatar)
      sendJson(res, 200, { dataUrl: `data:${row.avatarMime || 'image/png'};base64,${buf.toString('base64')}` })
      return true
    }

    // PUT /api/auth/preferences — 自助偏好(language/theme;全有或全无校验,防半写)
    const PREF_LANGS = ['en', 'zh']
    // 'auto'=定时自动(07:00–19:00 亮色,判定在前端 theme.js/index.html 镜像;服务端只存值不判定)。
    // 'system' 已移除(旧存量行读取时由前端归一,服务端不再接受新写入)。
    const PREF_THEMES = ['light', 'dark', 'auto']
    if (url.pathname === '/api/auth/preferences' && req.method === 'PUT') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const input = await readBody(req)
      if (input.language != null && !PREF_LANGS.includes(input.language)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      if (input.theme != null && !PREF_THEMES.includes(input.theme)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      const PREF_LANDINGS = ['cluster', 'workbench', 'last']
      const PREF_ROWS = [10, 20, 50, 100]
      if (input.landingView !== undefined && input.landingView !== null && !PREF_LANDINGS.includes(input.landingView)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      if (input.defaultClusterId !== undefined && input.defaultClusterId !== null && (typeof input.defaultClusterId !== 'string' || input.defaultClusterId.length > 64)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      if (input.defaultNamespace !== undefined && input.defaultNamespace !== null && (typeof input.defaultNamespace !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(input.defaultNamespace))) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      if (input.rowsPerPage !== undefined && input.rowsPerPage !== null && !PREF_ROWS.includes(input.rowsPerPage)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      // 审批三档模式(2026-09-09):workbenchApprovalMode ∈ WB_APPROVAL_MODES(ask/writes/auto)。
      if (input.workbenchApprovalMode != null && !WB_APPROVAL_MODES.includes(input.workbenchApprovalMode)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      const prefs = readPrefs(db, ps.userId)
      if (input.language != null) prefs.language = input.language
      if (input.theme != null) prefs.theme = input.theme
      if (input.landingView !== undefined) prefs.landingView = input.landingView
      if (input.defaultClusterId !== undefined) prefs.defaultClusterId = input.defaultClusterId
      if (input.defaultNamespace !== undefined) prefs.defaultNamespace = input.defaultNamespace
      if (input.rowsPerPage !== undefined) prefs.rowsPerPage = input.rowsPerPage
      // 切档落审计行(仅值变化时:前端 persist 是全字段双写,值未变也记 = 刷屏);已验证合法才走到这里。
      const prevApprovalMode = prefs.workbenchApprovalMode ?? 'ask'
      if (input.workbenchApprovalMode != null) prefs.workbenchApprovalMode = input.workbenchApprovalMode
      if (input.workbenchApprovalMode != null && input.workbenchApprovalMode !== prevApprovalMode) {
        writeAudit?.(db, { owner: ps.username, verb: 'change', tool: 'platform_approval_mode', result: 'ok', requestSummary: `workbenchApprovalMode=${prevApprovalMode}->${input.workbenchApprovalMode}`, source: 'platform' })
      }
      db.prepare('UPDATE platform_users SET prefs=? WHERE id=?').run(JSON.stringify(prefs), ps.userId)
      sendJson(res, 200, { prefs })
      return true
    }

    // GET /api/auth/password-policy — 当前生效密码策略(前端改密表单做同规则预检,Wave1 §3.7)
    if (url.pathname === '/api/auth/password-policy' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      sendJson(res, 200, { policy: resolvePasswordPolicy(getSetting) })
      return true
    }

    // POST /api/auth/change-password — 自助改密(2026-08-29 设计:验旧密 → 新密 ≥8 → 吊销其他会话)
    if (url.pathname === '/api/auth/change-password' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const { currentPassword, newPassword } = await readBody(req)
        const user = db.prepare('SELECT * FROM platform_users WHERE id=?').get(ps.userId)
        const auditChange = (result, reason = null, summary = null) => writeAudit?.(db, { owner: ps.username, verb: 'change', tool: 'platform_change_password', result, reason, requestSummary: summary, source: 'platform' })
        // W3 §2:改密属账户安全面——已启用 MFA 的用户须 step-up ≤10min(409 由前端拦截弹 TOTP 窗重放);
        // 无 MFA 用户豁免(无码可验,当前密码本身即刚验证,spec §5.4)。
        if (user?.totpSecret && !requireStepUp(req, ps, res)) return true
        if (!user || !currentPassword || !verifyPassword(String(currentPassword), user.passwordHash)) {
          auditChange('denied', 'bad-current-password')
          sendJson(res, 401, { message: msg(req, 'auth.currentPasswordWrong') }); return true
        }
        const policy = resolvePasswordPolicy(getSetting)
        const rule = firstFailedRule(newPassword, policy)
        if (rule) {
          const key = rule === 'minLength' ? 'auth.passwordTooShort'
            : rule === 'mixed' ? 'auth.passwordNeedMixed'
            : rule === 'digit' ? 'auth.passwordNeedDigit' : 'auth.passwordNeedSymbol'
          sendJson(res, 400, { message: msg(req, key) }); return true
        }
        db.prepare('UPDATE platform_users SET passwordHash=? WHERE id=?').run(hashPassword(String(newPassword)), ps.userId)
        const currentToken = extractPlatformToken(req)
        let revoked = 0
        for (const [tok, s] of Array.from(platformSessions)) {
          if (s.userId === ps.userId && tok !== currentToken) {
            platformSessions.delete(tok)
            try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(tok) } catch { /* noop */ }
            // 吊销同时回收该会话接入的 K8s 凭据(2026-08-29 终审发现 4:否则被踢设备集群凭据存活至 TTL)
            const k8sTok = s.k8sSessionToken
            if (k8sTok) {
              sessions.delete(k8sTok)
              try { db.prepare('DELETE FROM sessions WHERE token=?').run(k8sTok) } catch { /* noop */ }
            }
            revoked++
          }
        }
        auditChange('ok', null, `revoked=${revoked}`)
        // CSO #13:改密成功即删首管一次性凭证文件(best-effort;不存在/无权限静默忽略)
        try { unlinkSync(join(dataDir, 'first-admin-credentials.txt')) } catch { /* noop */ }
        sendJson(res, 200, { ok: true, revoked })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.changePasswordFailed') }); return true }
    }

    // GET /api/auth/sessions — 当前用户活跃会话(权威源=内存 Map;token 仅回 8 位指纹)
    if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const currentToken = extractPlatformToken(req)
      const list = []
      for (const [tok, s] of platformSessions) {
        if (s.userId !== ps.userId) continue
        list.push({ fingerprint: tok.slice(0, 8), ip: s.ip || null, userAgent: s.userAgent || null, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt || s.createdAt, current: tok === currentToken })
      }
      list.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      sendJson(res, 200, { sessions: list })
      return true
    }

    // GET /api/my/activity — 我的活动(2026-09-04 Wave1 §3.2):audit_log 按本人 username 过滤的只读视图。
    // v1 固定 90 天窗口(服务端钳制,client 传 since/until 无效);只回 finalized 行(queryAuditLog 默认)。
    if (url.pathname === '/api/my/activity' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const q = url.searchParams
      const out = queryAuditLog(db, {
        owner: ps.username,
        tool: q.get('tool') || undefined, toolPrefix: q.get('toolPrefix') || undefined,
        result: q.get('result') || undefined, source: q.get('source') || undefined,
        since: Date.now() - 90 * 86400000,
        page: q.get('page') || undefined, size: q.get('size') || undefined,
      })
      sendJson(res, 200, { ...out, windowDays: 90 })
      return true
    }

    // DELETE /api/auth/sessions/others — 原子吊销除当前外全部(先于 :fingerprint 匹配)
    if (url.pathname === '/api/auth/sessions/others' && req.method === 'DELETE') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const currentToken = extractPlatformToken(req)
      let revoked = 0
      for (const [tok, s] of Array.from(platformSessions)) {
        if (s.userId !== ps.userId || tok === currentToken) continue
        platformSessions.delete(tok)
        try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(tok) } catch { /* noop */ }
        // 同步回收被吊会话的 K8s 凭据(当前会话的保留)
        const k8sTok = s.k8sSessionToken
        if (k8sTok) {
          sessions.delete(k8sTok)
          try { db.prepare('DELETE FROM sessions WHERE token=?').run(k8sTok) } catch { /* noop */ }
        }
        revoked++
      }
      writeAudit?.(db, { owner: ps.username, verb: 'revoke', tool: 'platform_session_revoke', result: 'ok', requestSummary: `revoked=${revoked}`, source: 'platform' })
      sendJson(res, 200, { ok: true, revoked })
      return true
    }

    // DELETE /api/auth/sessions/:fingerprint — 按 token 前缀指纹吊销指定会话;当前会话拒吊(防自锁)。
    // 'others' 精确分支在上面已先行返回,此处 [^/]+ 不会误吞;归属过滤(userId)保证只能吊自己的。
    const fpMatch = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/)
    if (fpMatch && req.method === 'DELETE') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const currentToken = extractPlatformToken(req)
      const fp = fpMatch[1]
      if (currentToken && currentToken.slice(0, 8) === fp) { sendJson(res, 400, { message: msg(req, 'auth.sessionCurrentNoRevoke') }); return true }
      let hit = null
      for (const [tok, s] of platformSessions) {
        if (s.userId === ps.userId && tok.slice(0, 8) === fp) { hit = tok; break }
      }
      if (!hit) { sendJson(res, 404, { message: msg(req, 'auth.sessionNotFound') }); return true }
      const revokedPs = platformSessions.get(hit)
      platformSessions.delete(hit)
      try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(hit) } catch { /* noop */ }
      // 同步回收被吊会话的 K8s 凭据(当前会话已在上文 400 拒吊,不会走到这里)
      const k8sTok = revokedPs?.k8sSessionToken
      if (k8sTok) {
        sessions.delete(k8sTok)
        try { db.prepare('DELETE FROM sessions WHERE token=?').run(k8sTok) } catch { /* noop */ }
      }
      writeAudit?.(db, { owner: ps.username, verb: 'revoke', tool: 'platform_session_revoke', result: 'ok', requestSummary: `fp=${fp}`, source: 'platform' })
      sendJson(res, 200, { ok: true })
      return true
    }

    // POST /api/auth/logout — 登出(三处同清:内存+platform_sessions+K8s 凭据,与 reaper/cap 共用 removeSessionRecord)
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = req.headers['x-platform-token']
      // CSO #11:logout 同时回收该平台会话派生的 K8s 凭据(removeSessionRecord 内含,与 reaper/cap 共用)
      if (token) removeSessionRecord(platformSessions, db, sessions, token)
      sendJson(res, 200, { ok: true })
      return true
    }

    // GET /api/my-clusters — 当前用户可接入的集群列表(Layer 2 集群选择)
    // 两分支均下发 nsAuthMode(全开由它表达);非 admin 追加 effective ns 概要
    // nsGrants(残余收尾 fix 4,2026-09-07):allowlist 集群合并 user 直授∪组授权取高档;
    // open / 已分配零有效授权 / admin 行省略该字段。合并语义复用 effectiveGrants 单一决策源。
    if (url.pathname === '/api/my-clusters' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      let rows
      if (ps.role === 'admin') {
        rows = db.prepare('SELECT id,name,apiServer,version,authMethod,nsAuthMode,createdAt FROM clusters ORDER BY name').all()
      } else {
        rows = db.prepare(`SELECT c.id,c.name,c.apiServer,c.version,c.authMethod,c.nsAuthMode,c.createdAt FROM clusters c
          JOIN user_clusters uc ON uc.clusterId=c.id WHERE uc.userId=? ORDER BY c.name`).all(ps.userId)
        const grants = effectiveGrants(db, { userId: ps.userId, role: ps.role })
        for (const row of rows) {
          if ((row.nsAuthMode || 'open') === 'open') continue // open:全开由 nsAuthMode 表达
          const ns = grants.clusters.get(row.id)?.ns
          if (!ns || !ns.size) continue // 已分配但零有效授权 → 省略
          row.nsGrants = [...ns.entries()]
            .map(([namespace, level]) => ({ namespace, level }))
            .sort((a, b) => a.namespace.localeCompare(b.namespace))
        }
      }
      sendJson(res, 200, { clusters: rows })
      return true
    }

    // POST /api/connect-cluster — 平台用户接入指定集群(经 buildCallContext 构造 K8s session → 探测 → 持久化)
    if (url.pathname === '/api/connect-cluster' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const { clusterId } = await readBody(req)
        const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(clusterId)
        if (!cluster) { sendJson(res, 404, { message: msg(req, 'auth.clusterNotFound') }); return true }
        if (ps.role !== 'admin') {
          const assigned = db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(ps.userId, clusterId)
          if (!assigned) { sendJson(res, 403, { message: msg(req, 'auth.clusterForbidden') }); return true }
        }
        // 从 clusters 行构造 K8s session（字段与 sessions 表完全一致;经 buildCallContext 统一形状）
        const apiServer = normalizeServer(cluster.apiServer)
        const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now(), userId: ps.userId, clusterId: cluster.id,
          // W2 Phase E:impersonation 身份归真(内存 session 对象携带,不持久化——sessions 表无此列;
          // 重启后 loadPersistedSessions 从 platform_sessions.userId 重建)。admin 平台用户同样携带(R3);
          // legacy ps(无 userId)→ 空数组 = 不注入。
          impersonate: buildImpersonation(db, ps.userId),
          impersonateDisplayname: impersonateDisplaynameFor(db, ps.userId) }
        // 2026-09-08 性能批:命中 TTL 缓存(凭据未变)则跳过 /version 往返;未命中仍同步探活验凭据
        const vsig = versionCacheSig(cluster)
        const vhit = versionCache.get(cluster.id)
        if (vhit && vhit.sig === vsig && Date.now() - vhit.at < VERSION_CACHE_TTL_MS) {
          k8sSession.version = vhit.version
        } else {
          const probe = await requestKubernetes(k8sSession, '/version')
          k8sSession.version = probe.body?.gitVersion || 'unknown'
          versionCache.set(cluster.id, { sig: vsig, version: k8sSession.version, at: Date.now() })
        }
        const k8sToken = randomUUID()
        // CSO #11:重连先吊销旧 k8s token(旧行为只覆盖单标量,旧行留存成孤儿活 8h、重启还复活)
        const oldTok = ps.k8sSessionToken
        if (oldTok) {
          // 轮换墓碑(2026-09-06 spec):先落 rotated_sessions 再删行,rekey 才认得刚轮换的 token
          try { tombstoneSession(db, oldTok, ps.userId, Date.now()) } catch { /* noop */ }
          sessions.delete(oldTok); try { db.prepare('DELETE FROM sessions WHERE token=?').run(oldTok) } catch { /* noop */ }
        }
        sessions.set(k8sToken, k8sSession)
        persistSession(k8sToken, k8sSession)
        // 更新平台会话的 k8sSessionToken
        ps.k8sSessionToken = k8sToken
        platformSessions.set(req.headers['x-platform-token'], ps)
        db.prepare('UPDATE platform_sessions SET k8sSessionToken=? WHERE token=?').run(k8sToken, req.headers['x-platform-token'])
        // W2 Phase E:连接成功后 fire-and-forget 探测该集群凭据的 impersonate 能力(不阻塞连接;
        // 结果按 clusterId 缓存,缓存后 egress 注入生效)。legacy ps 无身份不触发探测。
        if (k8sSession.impersonate.length) impersonationProbe?.ensureProbed?.(k8sSession)
        // cluster.name 下发(issue#8):前端集群身份展示以 name 为准,只回 apiServer 会逼出 hostname(=IP)兜底
        sendJson(res, 200, { token: k8sToken, cluster: { apiServer: apiServer.toString().replace(/\/$/, ''), version: k8sSession.version, name: cluster.name } })
        return true
      } catch (e) { sendJson(res, e.status || 502, { message: e?.message || msg(req, 'auth.connectFailed') }); return true }
    }

    return false // 无匹配
  }

  return { handle }
}
