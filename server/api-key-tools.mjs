// API-key 工具链(T8 walking skeleton):resolveApiKey + get_pod_logs,
// 串起 call-context / auth-keys / authorize / sa-binding / audit 的端到端链。
// 接线:index.mjs 注入 { db, requestFn(= requestKubernetes) },路由挂 /api/key/*(MCP 包装在 T12)。
import { lookupKey, isActive } from './auth-keys.mjs'
import { authorize, PermissionDeniedError } from './authorize.mjs'
import { createSaBinding } from './sa-binding.mjs'
import { reserveAudit, finalizeAudit } from './audit.mjs'
import { buildCallContext } from './call-context.mjs'

const LOG_TAIL_MAX = 500 // 有界(codex #11;T10 再加 byte/token 上限)

// 解析 API key(Authorization: Bearer)。有效→row;无效/已吊销/空→null。
export function resolveApiKey(db, req) {
  const token = req.headers?.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const row = lookupKey(db, token)
  return isActive(row) ? row : null
}

// 发现 apiserver issuer(= token audience,prefund 验证),按 apiServer 缓存。
const _issuerCache = new Map()
export function _clearIssuerCacheForTest() { _issuerCache.clear() }
async function getIssuer(requestFn, callCtx) {
  const key = callCtx.apiServer.toString()
  if (_issuerCache.has(key)) return _issuerCache.get(key)
  const { body } = await requestFn(callCtx, '/.well-known/openid-configuration')
  const issuer = body?.issuer || null
  if (issuer) _issuerCache.set(key, issuer)
  return issuer
}

export function createApiKeyTools({ db, requestFn }) {
  // get_pod_logs:有界只读。
  // 链:authorize → ns 作用域 → reserve 审计 → 现签 SA token → 拉 log(有界)→ finalize 审计。
  async function getPodLogs(keyRow, cluster, { namespace, pod, container, tail }) {
    const intent = { keyId: keyRow.id, owner: keyRow.owner, clusterId: keyRow.clusterId, namespace,
      verb: 'get', resource: `Pod/${pod}`, tool: 'get_pod_logs',
      requestSummary: `ns=${namespace} pod=${pod} container=${container || ''} tail=${tail || LOG_TAIL_MAX}` }

    const decision = authorize(keyRow, 'get_pod_logs')
    if (!decision.allowed) {
      finalizeAudit(db, intent, { result: 'denied', reason: decision.reason })
      throw new PermissionDeniedError(decision.reason, { tool: 'get_pod_logs' })
    }
    // namespace 作用域(MVP:SA 只在自己 ns 内操作;越界 → policy 拒,免得到 kube 才被 RBAC 挡)
    if (namespace !== keyRow.boundSA_namespace) {
      finalizeAudit(db, intent, { result: 'denied', reason: 'policy' })
      throw new PermissionDeniedError('policy', { tool: 'get_pod_logs', detail: 'namespace 超出绑定 SA 作用域' })
    }

    reserveAudit(db, intent) // started(崩溃可追溯)
    try {
      // bootstrap ctx = 集群主凭据(决策 A)→ 签 SA token
      const bootstrapCtx = buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader,
        ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure })
      const audience = await getIssuer(requestFn, bootstrapCtx)
      const token = await createSaBinding({ requestFn, audience })(bootstrapCtx,
        { namespace: keyRow.boundSA_namespace, name: keyRow.boundSA_name })
      // SA-token ctx:ca+insecure(同集群连接),authHeader=SA bearer,**不带 cert/key**(那是主凭据身份,会盖掉 SA token)
      const saCtx = buildCallContext({ apiServer: cluster.apiServer, authHeader: `Bearer ${token}`, ca: cluster.ca, insecure: !!cluster.insecure })
      const tailN = Math.min(Math.max(Number(tail) || LOG_TAIL_MAX, 1), LOG_TAIL_MAX)
      const q = new URLSearchParams({ tailLines: String(tailN) })
      if (container) q.set('container', container)
      const { body } = await requestFn(saCtx, `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${q}`)
      finalizeAudit(db, intent, { result: 'ok' })
      return { logs: typeof body === 'string' ? body : String(body ?? ''), tail: tailN }
    } catch (e) {
      if (e.code === 'PERMISSION_DENIED') throw e // 上面的 gate 拒绝已审计,不重复
      finalizeAudit(db, intent, { result: 'error', reason: e.status ? `http${e.status}` : (e.reason || 'error') })
      throw e
    }
  }
  return { getPodLogs }
}
