// server/sa-drift.mjs
// RBAC 漂移探测(spec: docs/superpowers/specs/2026-08-27-apikey-sa-rbac-drift-detection.md):
//   托管 key 逐 ns 声明式比对平台供给对象(Role 规则/RoleBinding/CRB) + 外来绑定扫描(超配);
//   BYO 只探「ns 内有无绑定引用该 SA」。全部复用 sa-provision/authorize 既有导出,零新事实源。
//   per-probe 超时:Promise.race 包裹,超时记 probe-error 不计 drift(防网络抖动永久黄)。
// requestFn 注入(同 sa-provision.mjs 契约),纯逻辑可单测。
import { roleRules, rbacTier, TIERS } from './sa-provision.mjs'
import { effectiveNamespaces } from './authorize.mjs'

const enc = encodeURIComponent
const id8 = (keyId) => String(keyId).slice(0, 8)
const DEFAULT_TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS) || 5000

// 稳定序列化:对象键与数组元素均排序 → 顺序不敏感的深比对基底。
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).sort().join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

// 该 key 的平台命名全集(三档 Role/RoleBinding + per-key cani CRB + 共享 cani ClusterRole)。
// 外来绑定判定 = subjects 引用我们的 SA 且名字不在此集合。
export function platformNames(keyId) {
  const s = new Set(TIERS.map(t => `aliangboard-mcp-${t}-${id8(keyId)}`))
  s.add(`aliangboard-mcp-cani-${id8(keyId)}`)
  s.add('aliangboard-mcp-cani')
  return s
}

const withTimeout = (p, ms) => {
  let timer
  const settled = {}
  return Promise.race([
    p.finally(() => { settled.ok = true; if (timer) clearTimeout(timer) }),
    new Promise((_, rej) => { timer = setTimeout(() => { settled.ok = true; rej(new Error(`probe timeout after ${ms}ms`)) }, ms) })
  ]).finally(() => { if (!settled.ok && timer) clearTimeout(timer) })
}

// 一次 health 调用内的共享缓存:同 apiServer 的 ns rolebinding list / CRB list / cani CR GET 只发一次;失败不缓存。
function sharedGet(shared, key, make) {
  if (!shared[key]) {
    const p = make().catch(e => { delete shared[key]; throw e })
    shared[key] = p
  }
  return shared[key]
}

function issue(type, extra = {}) { return { type, ...extra } }

export async function probeSaDrift({ requestFn, callCtx, timeoutMs = DEFAULT_TIMEOUT_MS }, { keyRow, shared = {} }) {
  const issues = []
  const get = async (path) => {
    try { const { body } = await withTimeout(requestFn(callCtx, path), timeoutMs); return { ok: true, body } }
    catch (e) { return { ok: false, status: e.status, error: e.message } }
  }
  const nss = [...effectiveNamespaces(keyRow)]
  const tier = rbacTier(keyRow)
  const role = `aliangboard-mcp-${tier}-${id8(keyRow.id)}`
  const apiServer = String(callCtx?.apiServer || '')
  // list 的 404 视为空(与 teardown 容忍语义一致);其他错误(超时/403)→ null → probe-error。
  const listNs = (ns) => sharedGet(shared, `nslist|${apiServer}|${ns}`, async () =>
    (await withTimeout(requestFn(callCtx, `/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/rolebindings`), timeoutMs))?.body?.items || [])
    .catch(e => e?.status === 404 ? [] : null)
  const listCrb = () => sharedGet(shared, `crblist|${apiServer}`, async () =>
    (await withTimeout(requestFn(callCtx, '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'), timeoutMs))?.body?.items || [])
    .catch(e => e?.status === 404 ? [] : null)
  const refUs = (item) => (item.subjects || []).some(s => s.kind === 'ServiceAccount' && s.name === keyRow.boundSA_name && s.namespace === keyRow.boundSA_namespace)

  if (keyRow.saManaged) {
    for (const ns of nss) {
      const r = await get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/roles/${enc(role)}`)
      if (!r.ok) {
        if (r.status === 404) issues.push(issue('role-missing', { ns, name: role }))
        else issues.push(issue('probe-error', { ns, detail: r.error }))
        continue
      }
      if (stableStringify(r.body.rules) !== stableStringify(roleRules(tier))) issues.push(issue('role-rules', { ns, name: role }))
      const b = await get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/rolebindings/${enc(role)}`)
      if (!b.ok) { b.status === 404 ? issues.push(issue('binding-missing', { ns, name: role })) : issues.push(issue('probe-error', { ns, detail: b.error })); continue }
      const subjOk = b.body.subjects?.some(s => s.kind === 'ServiceAccount' && s.name === keyRow.boundSA_name && s.namespace === keyRow.boundSA_namespace)
      const refOk = b.body.roleRef?.name === role && b.body.roleRef?.kind === 'Role'
      if (!subjOk || !refOk) issues.push(issue('binding-subjects', { ns, name: role }))
    }
    const crb = await get(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${enc('aliangboard-mcp-cani-' + id8(keyRow.id))}`)
    if (!crb.ok) crb.status === 404 ? issues.push(issue('crb-missing', { name: 'aliangboard-mcp-cani-' + id8(keyRow.id) })) : issues.push(issue('probe-error', { detail: crb.error }))
    // 共享 cani ClusterRole(每 cluster 一次,走 shared):所有 key 的 can_i 都依赖它
    await sharedGet(shared, `cani|${apiServer}`, async () =>
      withTimeout(requestFn(callCtx, '/apis/rbac.authorization.k8s.io/v1/clusterroles/aliangboard-mcp-cani'), timeoutMs))
      .catch(e => { e?.status === 404 ? issues.push(issue('crb-missing', { name: 'aliangboard-mcp-cani' })) : issues.push(issue('probe-error', { detail: e?.message || 'cani ClusterRole 探测失败' })) })
    // 外来绑定扫描(超配):subjects 引用我们的 SA 且名字非平台命名 → 报告不处理
    const mine = platformNames(keyRow.id)
    for (const ns of nss) {
      const items = await listNs(ns)
      if (items == null) { issues.push(issue('probe-error', { ns, detail: 'rolebinding list 失败' })); continue }
      for (const item of items) if (refUs(item) && !mine.has(item.metadata?.name)) issues.push(issue('foreign-binding', { ns, name: item.metadata?.name }))
    }
    const crbItems = await listCrb()
    if (crbItems == null) issues.push(issue('probe-error', { detail: 'clusterrolebinding list 失败' }))
    else for (const item of crbItems) if (refUs(item) && !mine.has(item.metadata?.name)) issues.push(issue('foreign-crb', { name: item.metadata?.name }))
  } else {
    // BYO:平台不拥有 RBAC,只探「ns 内有无任何绑定引用该 SA」;无 → 引导自建或接管。超配扫描跳过(一切外来皆合法)。
    for (const ns of nss) {
      const items = await listNs(ns)
      if (items == null) { issues.push(issue('probe-error', { ns, detail: 'rolebinding list 失败' })); continue }
      if (!items.some(refUs)) issues.push(issue('byo-no-binding', { ns }))
    }
  }
  const status = issues.some(i => !['probe-error', 'foreign-binding', 'foreign-crb'].includes(i.type)) ? 'drift'
    : issues.some(i => i.type === 'foreign-binding' || i.type === 'foreign-crb') ? 'over' : 'ok'
  return { status, issues }
}
