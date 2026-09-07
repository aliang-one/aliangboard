// W3 Task 6(2026-09-07 Wave 3 加固 §5.6):个人 kubeconfig。
//   GET /api/my/kubeconfig?clusterId=  → kubeconfig YAML 文本(text/plain;token=当前平台 token);
//   /api/k8s-proxy/:clusterId/<k8s-path> → kubectl 凭据面:平台 token 兑换该用户该集群的
//   活跃 K8s 会话(platform_sessions.k8sSessionToken 链),子路径重写后**复用 index.mjs 既有
//   /api/k8s 透传管线**(handlePassthrough 注入 —— 裁决 R3 复用优先:ns 授权门/流式 watch/
//   缓冲透传/namespaces 响应过滤全部自然生效,零拷贝)。
//   review round 1 I1 裁决例外:四个 discovery 根(GET /api、/apis、/api/v1、/apis/<g>/<v>)
//   仅在此代理面放行,kubectl 的先决条件(见下方分支注释)。
// 本模块薄:平台鉴权走 ROUTE_AUTH(platform)+注入的 requirePlatform 兜底;K8s 侧授权由
// 透传管线内的 k8sGate 执法,本模块只对 discovery 根直读上游。
import { msg } from '../messages.mjs'
import { sessionOwnerValid } from '../session-guard.mjs'
import { tombstoneSession } from '../window-records.mjs'

// kubeconfig YAML 构造(纯函数)。标量安全:非 [A-Za-z0-9._-] 一律双引号(JSON 字符串是
// 合法 YAML 流标量,", \ 转义由 JSON.stringify 处理)——集群名/用户名含空格、冒号不破 YAML。
function y(s) { return /^[A-Za-z0-9._-]+$/.test(s) ? s : JSON.stringify(s) }

export function buildKubeconfigYaml({ clusterName, serverUrl, username, token }) {
  const ctx = `aliangboard-${clusterName}`
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- cluster:',
    `    server: ${y(serverUrl)}`,
    `  name: ${y(ctx)}`,
    'contexts:',
    '- context:',
    `    cluster: ${y(ctx)}`,
    `    user: ${y(username)}`,
    '    namespace: default',
    `  name: ${y(ctx)}`,
    `current-context: ${y(ctx)}`,
    'users:',
    `- name: ${y(username)}`,
    '  user:',
    `    token: ${y(token)}`,
    '',
  ].join('\n')
}

// 平台 token → 该用户「活跃 K8s 会话」解析(两路端点共用):
//   该用户 platform_sessions 带 k8sSessionToken 的最新行(COALESCE(lastSeenAt,createdAt) 降序)
//   → sessions Map 取会话对象。错误码:
//     'no-cluster-session' 无带 k8sSessionToken 的行(从未连接/已级联吊销);
//     'session-expired'     行在而 sessions Map 无(过期/重启丢失),或命中后逐请求复检不过
//                           (review round 1 I3:与 sessionFromRequest 同语义守卫——TTL 过期先落
//                           轮换墓碑、归属失效[禁用/删除/失去集群分配]不落墓碑,两者都当场从
//                           内存 Map + 持久层移除,不留僵尸凭据);
//     'cluster-mismatch'    会话属于别的集群(请求的 clusterId 与当前连接不符)。
export function resolveProxyK8sSession({ db, sessions, sessionTtl, removePersistedSession }, userId, clusterId) {
  let row = null
  try {
    row = db.prepare('SELECT k8sSessionToken FROM platform_sessions WHERE userId=? AND k8sSessionToken IS NOT NULL ORDER BY COALESCE(lastSeenAt, createdAt) DESC LIMIT 1').get(userId)
  } catch { return { error: 'no-cluster-session' } }
  if (!row?.k8sSessionToken) return { error: 'no-cluster-session' }
  const session = sessions?.get(row.k8sSessionToken)
  if (!session) return { error: 'session-expired' }
  // TTL 复检与 sessionFromRequest 同款算术:createdAt 缺失 → NaN 比较 false = 不过期(存量行为)。
  const expired = Date.now() - session.createdAt > sessionTtl
  if (expired || !sessionOwnerValid(db, session)) {
    if (expired) { try { tombstoneSession(db, row.k8sSessionToken, session.userId, Date.now()) } catch { /* noop */ } }
    sessions?.delete(row.k8sSessionToken)
    try { removePersistedSession?.(row.k8sSessionToken) } catch { /* noop */ }
    return { error: 'session-expired' }
  }
  if (clusterId != null && session.clusterId !== clusterId) return { error: 'cluster-mismatch' }
  return { session }
}

// review round 1 I1(controller ruling):discovery 根判定。GET /api、/apis、/api/v1、
// /apis/<group>/<version> 四个形状是集群元数据读(资源目录,非对象数据)——kubectl 的
// 先决条件,任何持活跃集群会话的平台用户可读,与 Rancher/OpenShift 对 discovery 的处理同口径。
// 仅 k8s-proxy 面放行:parseApiPath 不认这些形状(→ null),若交给透传门必 403
// unparseable-path;浏览器 /api/k8s/* 面维持拒绝(前端从不调 discovery,收紧面不变)。
function isDiscoveryRoot(method, subPath) {
  return method === 'GET'
    && (subPath === '/api' || subPath === '/apis' || /^\/api\/v1\/?$/.test(subPath) || /^\/apis\/[^/]+\/[^/]+\/?$/.test(subPath))
}

export function createK8sProxyRoutes(deps) {
  const { db, sendJson, sendText, requirePlatform, sessions, handlePassthrough, extractPlatformToken,
    requestKubernetes, sessionTtl, removePersistedSession } = deps
  const resolve = (userId, clusterId) => resolveProxyK8sSession({ db, sessions, sessionTtl, removePersistedSession }, userId, clusterId)

  async function handle(req, res, url) {
    // ====== GET /api/my/kubeconfig?clusterId= —— 生成(平台 token 明文入 users[].user.token)======
    if (url.pathname === '/api/my/kubeconfig' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const clusterId = url.searchParams.get('clusterId') || ''
      const cluster = clusterId ? db.prepare('SELECT id,name FROM clusters WHERE id=?').get(clusterId) : null
      if (!cluster) { sendJson(res, 404, { message: msg(req, 'kubecfg.clusterNotFound') }); return true }
      // 分配校验与 connect-cluster 同语义:admin 全放,普通用户须 user_clusters 直配。
      if (ps.role !== 'admin') {
        const assigned = db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(ps.userId, clusterId)
        if (!assigned) { sendJson(res, 403, { message: msg(req, 'auth.clusterForbidden') }); return true }
      }
      // 须有「该集群」的活跃 K8s 会话(未连接/连的是别的集群 → 同一 409 文案引导先连接)。
      const r = resolve(ps.userId, clusterId)
      if (r.error) { sendJson(res, 409, { message: msg(req, 'kubecfg.noClusterSession') }); return true }
      // scheme:host 直连 TLS 判定 + 请求 Host 头(kubeconfig 在哪个网关域名下生成就用哪个)。
      const scheme = req.socket?.encrypted ? 'https' : 'http'
      const host = req.headers.host || 'localhost'
      const yaml = buildKubeconfigYaml({
        clusterName: cluster.name || cluster.id,
        serverUrl: `${scheme}://${host}/api/k8s-proxy/${clusterId}`,
        username: ps.username,
        token: extractPlatformToken(req) || '',
      })
      // 凭据响应禁缓存(review round 1 I2):token 是活的平台登录凭据,不得进任何中间层缓存。
      sendText(res, 200, yaml, { 'cache-control': 'no-store' })
      return true
    }

    // ====== /api/k8s-proxy/:clusterId/<k8s-path> —— kubectl 凭据面 ======
    if (url.pathname.startsWith('/api/k8s-proxy/')) {
      const ps = requirePlatform(req, res); if (!ps) return true
      const rest = url.pathname.slice('/api/k8s-proxy/'.length)
      const slash = rest.indexOf('/')
      const clusterId = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))
      const r = resolve(ps.userId, clusterId)
      if (r.error === 'no-cluster-session') { sendJson(res, 401, { message: msg(req, 'kubecfg.noClusterSession') }); return true }
      if (r.error === 'session-expired') { sendJson(res, 401, { message: msg(req, 'kubecfg.sessionExpired') }); return true }
      if (r.error === 'cluster-mismatch') { sendJson(res, 404, { message: msg(req, 'kubecfg.clusterMismatch') }); return true }
      // 子路径重写:/api/k8s-proxy/:clusterId<sub> → <sub>(与 /api/k8s/* 透传同参语义:
      // 整段 decodeURIComponent + 原样 query)。
      const kubernetesPath = decodeURIComponent(slash === -1 ? '/' : rest.slice(slash)) + (url.search || '')
      // I1 裁决:discovery 根不走透传门(parseApiPath null → 403),直读上游缓冲透传 body。
      // 非 GET 的同形状路径不放行(照旧交给透传门拒)。
      if (isDiscoveryRoot(req.method, kubernetesPath.split('?')[0])) {
        try {
          const result = await requestKubernetes(r.session, kubernetesPath)
          return sendJson(res, result.status, result.body ?? {})
        } catch (error) {
          return sendJson(res, error.status || 502, { message: error.message || msg(req, 'api.k8sRequestFailed'), details: error.details })
        }
      }
      await handlePassthrough(req, res, r.session, kubernetesPath)
      return true
    }

    return false // 无匹配
  }

  return { handle }
}
