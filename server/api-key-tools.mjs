// API-key 工具链(T8 skeleton + T9 有界原语):resolveApiKey + 共用链 runBoundedTool + tools 注册表 + callTool 派发。
// 接线:index.mjs 注入 { db, requestFn(= requestKubernetes) },路由 /api/key/<cluster>/call(POST {tool,args})。
// callTool 是 T12(MCP server)的复用点:MCP tools/call → callTool;tools/list → listTools()。
import { lookupKey, isActive } from './auth-keys.mjs'
import { authorize, PermissionDeniedError, effectiveNamespaces } from './authorize.mjs'
import { createSaBinding } from './sa-binding.mjs'
import { reserveAudit, finalizeAudit } from './audit.mjs'
import { buildCallContext } from './call-context.mjs'
import { toExecArgv } from './exec-bounds.mjs'
import { dump as yamlDump, loadAll as yamlLoadAll } from 'js-yaml'
import { provisionSa, rbacTier } from './sa-provision.mjs'
import { normalizeKind, CANONICAL_KINDS } from './kindAlias.mjs'

const LOG_TAIL_MAX = 500
const LOG_BYTE_MAX = 32768 // 日志输出字节上限(codex #11:单行巨大也会撑爆;Claude Code >10k token 会告警,32KB ≈ 8k token 留余量)
const EXEC_TIMEOUT_MS = Number(process.env.MCP_EXEC_TIMEOUT_MS || 30000) // AI 一次性 exec 超时(审计 P1a:防 tail -f 挂死 MCP 调用)
const EXEC_STREAM_MAX = 262144 // exec 流式缓冲上限 256KB(最终 stdout 仍截 32KB;防 cat 大文件先吃满内存)
const LIST_MAX = 200
const REPLICA_MAX = 20 // scale 上限(eng-review 9C:禁 scale 到 0 + 范围 guardrail)
const SCALE_KINDS = ['deployments', 'statefulsets']
const RESTART_KINDS = ['deployments', 'statefulsets', 'daemonsets']
const enc = encodeURIComponent

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

// core 资源 kind → 路径(骨架覆盖最常用;CRD 等走 T12+ 的通用 discovery)。
const LIST_PATH = {
  pods: '/api/v1/namespaces/%ns%/pods',
  services: '/api/v1/namespaces/%ns%/services',
  configmaps: '/api/v1/namespaces/%ns%/configmaps',
  deployments: '/apis/apps/v1/namespaces/%ns%/deployments',
  statefulsets: '/apis/apps/v1/namespaces/%ns%/statefulsets',
  daemonsets: '/apis/apps/v1/namespaces/%ns%/daemonsets',
}
const GET_PATH = {
  pods: (ns, name) => `/api/v1/namespaces/${enc(ns)}/pods/${enc(name)}`,
  services: (ns, name) => `/api/v1/namespaces/${enc(ns)}/services/${enc(name)}`,
  configmaps: (ns, name) => `/api/v1/namespaces/${enc(ns)}/configmaps/${enc(name)}`,
  deployments: (ns, name) => `/apis/apps/v1/namespaces/${enc(ns)}/deployments/${enc(name)}`,
  statefulsets: (ns, name) => `/apis/apps/v1/namespaces/${enc(ns)}/statefulsets/${enc(name)}`,
  daemonsets: (ns, name) => `/apis/apps/v1/namespaces/${enc(ns)}/daemonsets/${enc(name)}`,
  // SP3 扩展:让 agent 的 get_resource/describe_resource 也支持这些 kind
  nodes: (_ns, name) => `/api/v1/nodes/${enc(name)}`,
  persistentvolumes: (_ns, name) => `/api/v1/persistentvolumes/${enc(name)}`,
  persistentvolumeclaims: (ns, name) => `/api/v1/namespaces/${enc(ns)}/persistentvolumeclaims/${enc(name)}`,
  storageclasses: (_ns, name) => `/apis/storage.k8s.io/v1/storageclasses/${enc(name)}`,
  networkpolicies: (ns, name) => `/apis/networking.k8s.io/v1/namespaces/${enc(ns)}/networkpolicies/${enc(name)}`,
  serviceaccounts: (ns, name) => `/api/v1/namespaces/${enc(ns)}/serviceaccounts/${enc(name)}`,
  ingresses: (ns, name) => `/apis/networking.k8s.io/v1/namespaces/${enc(ns)}/ingresses/${enc(name)}`,
  secrets: (ns, name) => `/api/v1/namespaces/${enc(ns)}/secrets/${enc(name)}`,
  namespaces: (_ns, name) => `/api/v1/namespaces/${enc(name)}`,
}
const WORKLOADS = ['deployments', 'statefulsets', 'daemonsets']
function slimPod(p) { return { name: p.metadata?.name, phase: p.status?.phase, ready: (p.status?.containerStatuses || []).map(c => ({ name: c.name, ready: c.ready })) } }
function slimWorkload(d) { return { name: d.metadata?.name, ready: d.status?.readyReplicas || 0, desired: d.spec?.replicas || 0, updated: d.status?.updatedReplicas || 0 } }
// 工作负载 template 的全容器镜像清单(['app=nginx:1.25', ...];审计 P3:单看 containers[0] 对多容器误导)
const imagesOf = (spec) => (spec?.template?.spec?.containers || []).map(c => `${c.name}=${c.image}`)

// pod 文件路径校验:只放行安全字符(防 shell 注入;admin 档虽已可信 exec,仍做纵深防御)
// 导出供 index.mjs buildWbCtx 的 wb_read_pod_file 复用(同一白名单语义)
export function safePodPath(p) {
  if (!p || typeof p !== 'string') throw new Error('路径为空')
  if (!/^[a-zA-Z0-9._/~: -]+$/.test(p)) throw new Error(`路径含非法字符(仅允许字母数字 . _ / ~ : - 空格): ${p.slice(0, 40)}`)
  return p
}

// JSON 体积上限(2026-08-14 审计 P1b):与 get_resource_yaml 的 32KB 对齐——原 JSON 版无上限,
// 大 ConfigMap/Secret 会整包塞进 AI 上下文。超限 → 截断 json 字符串 + 标志(截断 JSON 不可 parse,
// 但 AI 按文本消费足够);未超限 → null(调用方保持原 { resource } 形状,向后兼容)。
function oversizedJson(body) {
  const full = JSON.stringify(body)
  if (full == null || Buffer.byteLength(full, 'utf8') <= LOG_BYTE_MAX) return null
  const originalBytes = Buffer.byteLength(full, 'utf8')
  return {
    kind: body?.kind, name: body?.metadata?.name, apiVersion: body?.apiVersion,
    json: Buffer.from(full, 'utf8').subarray(0, LOG_BYTE_MAX).toString('utf8'),
    truncated: true, originalBytes, byteCap: LOG_BYTE_MAX,
    hint: '对象超过 32KB 上限已截断(保护 AI 上下文);可改查具体子字段,或用 get_resource_yaml 看同限 YAML',
  }
}

// path-ns 作用域:解析 path 的 /namespaces/<x>/,强制 <x> ∈ allowedNs(来自 effectiveNamespaces);集群级 path 或他 ns → policy 拒。
// delete_resource 旧实现只校验 namespace arg、不校验 path 实际 ns —— 本 helper 补 policy 层闭环。
export function assertPathInNs(path, allowedNs) {
  const m = String(path || '').match(/\/namespaces\/([^/]+)\//)
  if (!m) throw new PermissionDeniedError('policy', { detail: `path 非命名空间资源(集群级),ns 绑定 key 不允许: ${String(path).slice(0, 80)}` })
  if (!allowedNs.has(m[1])) throw new PermissionDeniedError('policy', { detail: `path 命名空间 '${m[1]}' 不在该 key 允许的 namespace 集([${[...allowedNs].join(', ')}])` })
}

export function createApiKeyTools({ db, requestFn, execFn, applyYamlFn, ephemeralFn }) {
  // 共用链:authorize → ns 作用域 → reserve 审计 → 现签 SA token → SA-token ctx → fn → finalize。
  // deny/error 各路径审计。fn 拿 saCtx(无原始 dispatcher 访问器,结构性 enforcement)。
  async function runBoundedTool({ keyRow, cluster, tool, namespace, verb, resource, summary, source, fn }) {
    const intent = { keyId: keyRow.id, owner: keyRow.owner, clusterId: keyRow.clusterId, namespace, verb, resource, tool, source, requestSummary: summary }
    const decision = authorize(keyRow, tool)
    if (!decision.allowed) { finalizeAudit(db, intent, { result: 'denied', reason: decision.reason }); throw new PermissionDeniedError(decision.reason, { tool, detail: `工具 '${tool}' 不在当前 API key 的允许工具集(tier='${keyRow.tier}'${keyRow.tool_overrides ? ' + tool_overrides 覆盖' : ''} 决定;在 平台管理 → API Keys 配置)` }) }
    const allowedNs = effectiveNamespaces(keyRow)
    if (!allowedNs.has(namespace)) { finalizeAudit(db, intent, { result: 'denied', reason: 'policy' }); throw new PermissionDeniedError('policy', { tool, detail: `namespace '${namespace}' 不在该 key 允许的 namespace 集([${[...allowedNs].join(', ')}]);绑定 ns + 额外 ns 在 平台管理 → API Keys 配置,SA 的各 ns RoleBinding 自建` }) }
    reserveAudit(db, intent)
    try {
      const bootstrapCtx = buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure })
      const audience = await getIssuer(requestFn, bootstrapCtx)
      const mint = () => createSaBinding({ requestFn, audience })(bootstrapCtx, { namespace: keyRow.boundSA_namespace, name: keyRow.boundSA_name })
      // SA 签 token 404(绑定身份被删,整 key 灭门根因):托管 key → 幂等重建一次再签(自愈);BYO → 说人话并引导去修复。
      let token, prov
      try {
        token = await mint()
      } catch (e) {
        if (e.status !== 404) throw e
        if (keyRow.saManaged) {
          prov = await provisionSa({ requestFn, callCtx: bootstrapCtx }, { keyId: keyRow.id, namespace: keyRow.boundSA_namespace, name: keyRow.boundSA_name, tier: rbacTier(keyRow), namespaces: [...effectiveNamespaces(keyRow)] })
          if (prov.ok) token = await mint()
        }
        if (!token) {
          const why = prov && !prov.ok ? `(自动重建失败: ${prov.failed[0]?.error || prov.failed[0]?.kind || 'unknown'})` : ''
          throw new Error(`SA_BINDING_ERROR: API key 的集群身份 ServiceAccount ${keyRow.boundSA_namespace}/${keyRow.boundSA_name} 不存在${why}。请到 平台管理 → API Keys 对该 key 点「${keyRow.saManaged ? '修复' : '接管并修复'}」${keyRow.saManaged ? '恢复使用' : '(平台将代建并后续自动维护该身份),或自行重建该 ServiceAccount'}`)
        }
      }
      const saCtx = buildCallContext({ apiServer: cluster.apiServer, authHeader: `Bearer ${token}`, ca: cluster.ca, insecure: !!cluster.insecure })
      const out = await fn(saCtx)
      finalizeAudit(db, intent, { result: 'ok' })
      return out
    } catch (e) {
      if (e.code === 'PERMISSION_DENIED') throw e
      finalizeAudit(db, intent, { result: 'error', reason: e.status ? `http${e.status}` : (e.reason || 'error') })
      throw e
    }
  }

  const tools = {
    get_pod_logs: async (keyRow, cluster, a, source) => {
      const tailN = Math.min(Math.max(Number(a.tail) || LOG_TAIL_MAX, 1), LOG_TAIL_MAX)
      return runBoundedTool({ keyRow, cluster, tool: 'get_pod_logs', source, namespace: a.namespace, verb: 'get', resource: `Pod/${a.pod}`,
        summary: `pod=${a.pod} container=${a.container || ''} tail=${tailN}${a.previous ? ' previous' : ''}${a.timestamps ? ' ts' : ''}`,
        fn: async (saCtx) => {
          const q = new URLSearchParams({ tailLines: String(tailN) }); if (a.container) q.set('container', a.container)
          if (a.previous) q.set('previous', 'true')
          if (a.timestamps) q.set('timestamps', 'true')
          const { body } = await requestFn(saCtx, `/api/v1/namespaces/${enc(a.namespace)}/pods/${enc(a.pod)}/log?${q}`)
          // 字节上限(codex #11):单行巨大的日志也会撑爆输出。截断 + 标志,让 AI 知道要更小 tail 重试。
          const buf = Buffer.from(typeof body === 'string' ? body : String(body ?? ''), 'utf8')
          const originalBytes = buf.length
          const truncated = originalBytes > LOG_BYTE_MAX
          const logs = truncated ? buf.subarray(0, LOG_BYTE_MAX).toString('utf8') : buf.toString('utf8')
          return { logs, tail: tailN, previous: !!a.previous, timestamps: !!a.timestamps, truncated, originalBytes, byteCap: LOG_BYTE_MAX }
        } })
    },
    list_resources: async (keyRow, cluster, a, source) => {
      if (a.path) {
        return runBoundedTool({ keyRow, cluster, tool: 'list_resources', source, namespace: a.namespace, verb: 'list', resource: a.path, summary: `path=${a.path.slice(0, 80)}`,
          fn: async (saCtx) => {
            assertPathInNs(a.path, effectiveNamespaces(keyRow))
            const { body } = await requestFn(saCtx, a.path)
            const all = body?.items || []
            const items = all.slice(0, LIST_MAX).map(it => ({ name: it.metadata?.name, kind: it.kind, apiVersion: it.apiVersion, path: `${a.path}/${it.metadata?.name}` }))
            return { kind: '(path)', count: all.length, returned: items.length, items }
          } })
      }
      const kind = normalizeKind(a.kind) || 'pods'
      const templ = LIST_PATH[kind]
      if (!templ) throw new PermissionDeniedError('policy', { tool: 'list_resources', detail: `不支持的 kind: ${kind}(支持:${CANONICAL_KINDS.join('/')},单数/缩写自动归一);或用 path 列任意 kind` })
      return runBoundedTool({ keyRow, cluster, tool: 'list_resources', source, namespace: a.namespace, verb: 'list', resource: kind, summary: `kind=${kind}`,
        fn: async (saCtx) => {
          const { body } = await requestFn(saCtx, templ.replace('%ns%', enc(a.namespace)))
          const all = body?.items || []
          const items = all.slice(0, LIST_MAX).map(it => kind === 'pods' ? slimPod(it) : WORKLOADS.includes(kind) ? slimWorkload(it) : { name: it.metadata?.name })
          return { kind, count: all.length, returned: items.length, items }
        } })
    },
    get_resource: async (keyRow, cluster, a, source) => {
      const kind = normalizeKind(a.kind) || 'pods'
      const getter = GET_PATH[kind]
      if (!getter) throw new PermissionDeniedError('policy', { tool: 'get_resource', detail: `不支持的 kind: ${kind}(支持:${CANONICAL_KINDS.join('/')},单数/缩写自动归一)` })
      return runBoundedTool({ keyRow, cluster, tool: 'get_resource', source, namespace: a.namespace, verb: 'get', resource: `${kind}/${a.name}`, summary: `kind=${kind} name=${a.name}`,
        fn: async (saCtx) => {
          const { body } = await requestFn(saCtx, getter(a.namespace, a.name))
          if (body?.metadata?.managedFields) delete body.metadata.managedFields // 去噪
          return oversizedJson(body) || { resource: body }
        } })
    },
    get_resource_yaml: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'get_resource_yaml', source, namespace: a.namespace, verb: 'get', resource: a.path || '?', summary: `get ${(a.path || '').slice(0, 80)}`,
      fn: async (saCtx) => {
        if (!a.path) throw new Error('get_resource_yaml 缺 path(K8s 资源路径,如 /apis/networking.k8s.io/v1/namespaces/default/ingresses/foo)')
        assertPathInNs(a.path, effectiveNamespaces(keyRow))
        const { body } = await requestFn(saCtx, a.path)
        if (body?.metadata?.managedFields) delete body.metadata.managedFields // 去噪
        const full = yamlDump(body)
        const originalBytes = Buffer.byteLength(full, 'utf8')
        const truncated = originalBytes > LOG_BYTE_MAX
        const yaml = truncated ? Buffer.from(full, 'utf8').subarray(0, LOG_BYTE_MAX).toString('utf8') : full
        return { kind: body?.kind, name: body?.metadata?.name, apiVersion: body?.apiVersion, yaml, truncated, originalBytes, byteCap: LOG_BYTE_MAX }
      } }),
    get_events: async (keyRow, cluster, a, source) => {
      return runBoundedTool({ keyRow, cluster, tool: 'get_events', source, namespace: a.namespace, verb: 'list', resource: 'events', summary: `for=${a.name || '(all)'}`,
        fn: async (saCtx) => {
          const url = a.name
            ? `/api/v1/namespaces/${enc(a.namespace)}/events?fieldSelector=${enc('involvedObject.name=' + a.name)}`
            : `/api/v1/namespaces/${enc(a.namespace)}/events`
          const { body } = await requestFn(saCtx, url)
          const all = body?.items || []
          const items = all.slice(0, LIST_MAX).map(e => ({ reason: e.reason, type: e.type, message: String(e.message || '').slice(0, 300), last: e.lastTimestamp }))
          return { count: all.length, returned: items.length, items }
        } })
    },
    describe_resource: async (keyRow, cluster, a, source) => {
      const kind = normalizeKind(a.kind) || 'pods'
      const getter = GET_PATH[kind]
      if (!getter) throw new PermissionDeniedError('policy', { tool: 'describe_resource', detail: `不支持的 kind: ${kind}(支持:${CANONICAL_KINDS.join('/')},单数/缩写自动归一)` })
      return runBoundedTool({ keyRow, cluster, tool: 'describe_resource', source, namespace: a.namespace, verb: 'get', resource: `${kind}/${a.name}`, summary: `describe ${kind}/${a.name}`,
        fn: async (saCtx) => {
          const { body: resBody } = await requestFn(saCtx, getter(a.namespace, a.name))
          if (resBody?.metadata?.managedFields) delete resBody.metadata.managedFields
          let events = []
          try {
            const eventsUrl = `/api/v1/namespaces/${enc(a.namespace)}/events?fieldSelector=${enc('involvedObject.name=' + a.name)}`
            const { body: evtBody } = await requestFn(saCtx, eventsUrl)
            events = (evtBody?.items || []).slice(0, 20).map(e => ({ reason: e.reason, type: e.type, message: String(e.message || '').slice(0, 300), last: e.lastTimestamp }))
          } catch { /* events 拉取失败不阻塞 */ }
          const eventsOut = { count: events.length, items: events }
          return oversizedJson(resBody) ? { ...oversizedJson(resBody), events: eventsOut } : { resource: resBody, events: eventsOut }
        } })
    },
    can_i: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'can_i', source, namespace: a.namespace, verb: 'can_i', resource: `${a.verb || '?'}/${a.resource || '?'}`,
      summary: `can ${a.verb || '?'} ${a.group ? a.group + '/' : ''}${a.resource || '?'}`,
      fn: async (saCtx) => {
        if (!a.verb || !a.resource) throw new Error('can_i 缺 verb/resource(如 verb=delete resource=secrets)')
        // 形状稳定(name/subresource 始终在键位,缺省 undefined),便于 deepEqual / 调用方读 queried。
        const ra = { namespace: a.namespace, verb: a.verb, group: a.group || '', resource: a.resource, name: a.name || undefined, subresource: a.subresource || undefined }
        let body
        try {
          ({ body } = await requestFn(saCtx, '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes: ra } }),
          }))
        } catch (e) {
          // SSAR 失败(SA 无 create SSAR 的 RBAC → 403;或 5xx/网络)→ 优雅返,不抛
          const code = e.status ? `http${e.status}` : 'error'
          const hint = e.status === 403 ? 'SA 无 selfsubjectaccessreviews 的 create 权限(can_i 需 SA 有 SSAR RBAC)' : (e.message || 'error')
          return { allowed: false, reason: null, evaluationError: `SSAR 请求失败(${code}): ${String(hint).slice(0, 300)}`, queried: ra }
        }
        return {
          allowed: !!body?.status?.allowed,
          reason: body?.status?.reason ? String(body.status.reason).slice(0, 300) : null,
          evaluationError: body?.status?.evaluationError ? String(body.status.evaluationError).slice(0, 300) : null,
          queried: ra,
        }
      } }),
    rollout_history: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'rollout_history', source, namespace: a.namespace, verb: 'get', resource: `Deployment/${a.name}/rollout`, summary: `deploy=${a.name}`,
      fn: async (saCtx) => {
        const dp = (await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/deployments/${enc(a.name)}`)).body
        if (!dp) throw new Error(`Deployment ${a.name} 不存在`)
        const uid = dp.metadata?.uid
        const curRev = dp.metadata?.annotations?.['deployment.kubernetes.io/revision'] || null
        const { body } = await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/replicasets`)
        const revisions = (body?.items || [])
          .filter(rs => (rs.metadata?.ownerReferences || []).some(o => o.uid === uid && o.kind === 'Deployment'))
          .map(rs => ({
            revision: rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || null,
            images: imagesOf(rs.spec), // 全容器(审计 P3:此前只 containers[0],多容器 Deployment 展示误导)
            current: rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] === curRev,
            createdAt: rs.metadata?.creationTimestamp || null,
          }))
          .sort((x, y) => (Number(y.revision) || 0) - (Number(x.revision) || 0))
        return { namespace: a.namespace, deployment: a.name, currentRevision: curRev, revisions }
      } }),
    rollout_status: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'rollout_status', source, namespace: a.namespace, verb: 'get', resource: `Deployment/${a.name}`, summary: `rollout status ${a.name}`,
      fn: async (saCtx) => {
        const { body } = await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/deployments/${enc(a.name)}`)
        if (!body) throw new Error(`Deployment ${a.name} 不存在`)
        const s = body.status || {}
        const conditions = (s.conditions || []).map(c => ({ type: c.type, status: c.status, reason: c.reason, message: String(c.message || '').slice(0, 200) }))
        const replicas = { desired: s.replicas ?? 0, ready: s.readyReplicas ?? 0, updated: s.updatedReplicas ?? 0, available: s.availableReplicas ?? 0, unavailable: s.unavailableReplicas ?? 0 }
        const prog = conditions.find(c => c.type === 'Progressing')
        const summary = `${replicas.ready}/${replicas.desired} ready, ${replicas.updated} updated${prog ? `, ${prog.reason || prog.status}` : ''}`
        return { name: body.metadata?.name, replicas, conditions, summary }
      } }),
    rollout_undo: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'rollout_undo', source, namespace: a.namespace, verb: 'patch', resource: `Deployment/${a.name}/rollback`, summary: `deploy=${a.name} →rev=${a.toRevision}`,
      fn: async (saCtx) => {
        if (a.toRevision == null || a.toRevision === '') throw new Error('rollout_undo 缺 toRevision(先 rollout_history 看 revisions)')
        const dp = (await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/deployments/${enc(a.name)}`)).body
        if (!dp) throw new Error(`Deployment ${a.name} 不存在`)
        const uid = dp.metadata?.uid
        const previousImages = imagesOf(dp.spec) // 全容器(审计 P3:此前 prevImage/newImage 只看第一个)
        const { body } = await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/replicasets`)
        const owned = (body?.items || []).filter(rs => (rs.metadata?.ownerReferences || []).some(o => o.uid === uid && o.kind === 'Deployment'))
        const target = owned.find(rs => rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] === String(a.toRevision))
        if (!target) throw new Error(`revision ${a.toRevision} 不存在`)
        const newImages = imagesOf(target.spec)
        await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/deployments/${enc(a.name)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/strategic-merge-patch+json' },
          body: JSON.stringify({ spec: { template: target.spec.template } }),
        })
        return { undone: a.name, toRevision: Number(a.toRevision), previousImages, newImages }
      } }),
    update_image: async (keyRow, cluster, a, source) => {
      const kind = String(a.kind || '').toLowerCase()
      return runBoundedTool({ keyRow, cluster, tool: 'update_image', source, namespace: a.namespace, verb: 'patch', resource: `${kind}/${a.name}`, summary: `${kind}/${a.name} ${a.container}=${(a.image || '').slice(0, 40)}`,
        fn: async (saCtx) => {
          if (!WORKLOADS.includes(kind)) throw new Error(`update_image 仅支持 ${WORKLOADS.join('/')},不是 ${kind}`)
          if (!a.container) throw new Error('update_image 缺 container')
          if (!a.image) throw new Error('update_image 缺 image')
          const getter = GET_PATH[kind]
          const cur = (await requestFn(saCtx, getter(a.namespace, a.name))).body
          if (!cur) throw new Error(`${kind}/${a.name} 不存在`)
          const containers = cur?.spec?.template?.spec?.containers || []
          const targetC = containers.find(c => c.name === a.container)
          if (!targetC) throw new Error(`容器 ${a.container} 不存在于 ${kind}/${a.name}(有: ${containers.map(c => c.name).join(',')})`)
          await requestFn(saCtx, getter(a.namespace, a.name), {
            method: 'PATCH', headers: { 'content-type': 'application/strategic-merge-patch+json' },
            body: JSON.stringify({ spec: { template: { spec: { containers: [{ name: a.container, image: a.image }] } } } }),
          })
          return { kind, name: a.name, container: a.container, previousImage: targetC.image || null, newImage: a.image }
        } })
    },
    scale: async (keyRow, cluster, a, source) => {
      const kind = String(a.kind || '').toLowerCase()
      return runBoundedTool({ keyRow, cluster, tool: 'scale', source, namespace: a.namespace, verb: 'patch', resource: `${kind}/${a.name}`, summary: `${kind}/${a.name} → ${a.replicas}`,
        fn: async (saCtx) => {
          if (!SCALE_KINDS.includes(kind)) throw new Error(`scale 仅支持 ${SCALE_KINDS.join('/')},不是 ${kind}`)
          const replicas = Number(a.replicas)
          if (!Number.isInteger(replicas) || replicas < 1 || replicas > REPLICA_MAX) throw new Error(`replicas 必须是 1..${REPLICA_MAX} 的整数(禁止 scale 到 0 / 异常值)`)
          const { body } = await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/${kind}/${enc(a.name)}/scale`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ spec: { replicas } }) })
          return { kind, name: a.name, replicas: body?.spec?.replicas ?? replicas }
        } })
    },
    restart: async (keyRow, cluster, a, source) => {
      const kind = String(a.kind || '').toLowerCase()
      return runBoundedTool({ keyRow, cluster, tool: 'restart', source, namespace: a.namespace, verb: 'patch', resource: `${kind}/${a.name}`, summary: `${kind}/${a.name}`,
        fn: async (saCtx) => {
          if (!RESTART_KINDS.includes(kind)) throw new Error(`restart 仅支持 ${RESTART_KINDS.join('/')},不是 ${kind}`)
          const restartedAt = new Date().toISOString()
          await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/${kind}/${enc(a.name)}`, { method: 'PATCH', headers: { 'content-type': 'application/strategic-merge-patch+json' }, body: JSON.stringify({ spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': restartedAt } } } } }) })
          return { kind, name: a.name, restartedAt }
        } })
    },
    exec_pod: async (keyRow, cluster, a, source) => {
      const command = Array.isArray(a.command) ? a.command.join(' ') : String(a.command || '')
      return runBoundedTool({ keyRow, cluster, tool: 'exec_pod', source, namespace: a.namespace, verb: 'exec', resource: `Pod/${a.pod}`, summary: `pod=${a.pod} c=${a.container || ''} cmd=${command.slice(0, 80)}`,
        fn: async (saCtx) => {
          if (!execFn) throw new Error('exec_pod 未启用(网关未注入 execFn)')
          if (!command) throw new Error('exec_pod 缺 command')
          // 命令形态(2026-08-25 bug):exec argv 必须数组——字符串经 client-node 编码成单个
          // command= 参数,kubelet 把整串当二进制名 → 必败。exec_pod 契约=shell 命令 → sh -c 包装。
          const r = await execFn(saCtx, a.namespace, a.pod, a.container || '', toExecArgv(command), { timeoutMs: EXEC_TIMEOUT_MS, maxBytes: EXEC_STREAM_MAX })
          return {
            pod: a.pod, container: a.container || '', exitCode: r.status ?? null,
            stdout: (r.stdout?.toString('utf8') || '').slice(0, 32768), stderr: (r.stderr || '').slice(0, 8192),
            timedOut: !!r.timedOut, truncated: !!r.truncated,
            ...(r.timedOut ? { hint: `命令超时(>${Math.round(EXEC_TIMEOUT_MS / 1000)}s)被中止,输出为已收部分;一次性 exec 不适用于长驻命令(tail -f/top 等)` } : {}),
          }
        } })
    },
    browse_files: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'browse_files', source, namespace: a.namespace, verb: 'get', resource: `Pod/${a.pod}/files`, summary: `pod=${a.pod} path=${(a.path || '/').slice(0, 80)}`,
      fn: async (saCtx) => {
        if (!execFn) throw new Error('browse_files 未启用')
        // 数组直传(不经 shell):路径含空格也原样一参,且无 sh 依赖
        const r = await execFn(saCtx, a.namespace, a.pod, a.container || '', ['ls', '-la', safePodPath(a.path || '/')], { timeoutMs: EXEC_TIMEOUT_MS, maxBytes: EXEC_STREAM_MAX })
        return { pod: a.pod, path: a.path || '/', listing: (r.stdout?.toString('utf8') || '').slice(0, 32768), timedOut: !!r.timedOut, truncated: !!r.truncated }
      } }),
    read_file: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'read_file', source, namespace: a.namespace, verb: 'get', resource: `Pod/${a.pod}/file`, summary: `pod=${a.pod} path=${(a.path || '').slice(0, 80)}`,
      fn: async (saCtx) => {
        if (!execFn) throw new Error('read_file 未启用')
        if (!a.path) throw new Error('read_file 缺 path')
        // 数组直传(不经 shell):`--` 止参防 `-` 开头路径被 cat 当选项;空格路径安全
        const r = await execFn(saCtx, a.namespace, a.pod, a.container || '', ['cat', '--', safePodPath(a.path)], { timeoutMs: EXEC_TIMEOUT_MS, maxBytes: EXEC_STREAM_MAX })
        return { pod: a.pod, path: a.path, content: (r.stdout?.toString('utf8') || '').slice(0, 32768), timedOut: !!r.timedOut, truncated: !!r.truncated }
      } }),
    apply_yaml: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'apply_yaml', source, namespace: keyRow.boundSA_namespace, verb: 'apply', resource: 'yaml', summary: `apply yaml ${(a.yaml || '').length} chars`,
      fn: async (saCtx) => {
        if (!applyYamlFn) throw new Error('apply_yaml 未启用(网关未注入 applyYamlFn)')
        if (!a.yaml || !a.yaml.trim()) throw new Error('apply_yaml 缺 yaml')
        // ns 闸门(与 delete_resource 的 assertPathInNs 闭环):apply 正文里的 namespace 是攻击者可控的 metadata.namespace,
        // 必须显式声明且 ∈ allowedNs。缺 ns(集群级资源,或落 default)→ 拒;他 ns → 拒。applyYamlFn 拿到的是已校验过的 yaml。
        const allowedNs = effectiveNamespaces(keyRow)
        yamlLoadAll(a.yaml, (o) => {
          if (!o) return
          const ns = o?.metadata?.namespace
          if (!ns) throw new PermissionDeniedError('policy', { tool: 'apply_yaml', detail: `apply_yaml 要求每个资源显式指定 metadata.namespace(防跨 ns / 集群级越权);kind=${o?.kind || '?'}` })
          if (!allowedNs.has(ns)) throw new PermissionDeniedError('policy', { tool: 'apply_yaml', detail: `命名空间 '${ns}' 不在该 key 允许的 namespace 集([${[...allowedNs].join(', ')}])` })
        })
        return applyYamlFn(saCtx, a.yaml)
      } }),
    delete_resource: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'delete_resource', source, namespace: a.namespace, verb: 'delete', resource: a.path || '?', summary: `delete ${(a.path || '').slice(0, 100)}`,
      fn: async (saCtx) => {
        if (!a.path) throw new Error('delete_resource 缺 path(K8s 资源路径,如 /apis/apps/v1/namespaces/default/deployments/nginx)')
        assertPathInNs(a.path, effectiveNamespaces(keyRow))
        await requestFn(saCtx, a.path, { method: 'DELETE' })
        return { deleted: a.path }
      } }),
    kubectl_debug: async (keyRow, cluster, a, source) => runBoundedTool({
      keyRow, cluster, tool: 'kubectl_debug', source, namespace: a.namespace, verb: 'patch', resource: `Pod/${a.pod}/ephemeral`, summary: `pod=${a.pod} image=${a.image || 'busybox'}`,
      fn: async (saCtx) => {
        if (!ephemeralFn) throw new Error('kubectl_debug 未启用')
        return ephemeralFn(saCtx, a.namespace, a.pod, { name: a.name || 'debugger', image: a.image || 'busybox:latest', command: a.command, targetContainerName: a.targetContainerName })
      } }),
  }

  // 派发:T12 MCP tools/call → callTool;未知工具 → policy 拒(不暴露 tool 存在与否的细节过度,这里直接报)。
  async function callTool(keyRow, cluster, tool, args, source = 'direct') {
    const fn = tools[tool]
    if (!fn) throw new PermissionDeniedError('policy', { tool, detail: `未知工具: ${tool}` })
    return fn(keyRow, cluster, args || {}, source)
  }

  return { callTool, getPodLogs: tools.get_pod_logs, listTools: () => Object.keys(tools) }
}
