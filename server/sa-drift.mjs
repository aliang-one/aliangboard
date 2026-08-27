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

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`probe timeout after ${ms}ms`)), ms))])

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
  } else {
    // Task 2 实现(BYO:ns 内有无绑定引用该 SA)
  }
  const status = issues.some(i => !['probe-error', 'foreign-binding', 'foreign-crb'].includes(i.type)) ? 'drift'
    : issues.some(i => i.type === 'foreign-binding' || i.type === 'foreign-crb') ? 'over' : 'ok'
  return { status, issues }
}
