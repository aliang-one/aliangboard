// server/sa-provision.mjs
// 托管 SA 供给(T14):board 代建/回收 MCP key 的集群身份。原则:
//   1) 权限刚好等于工具面——tier→Role 规则从 authorize.mjs 工具宇宙推导(admin 因 apply_yaml 面向任意 kind → ns 内全权);
//   2) 幂等——全部走 server-side apply(fieldManager=aliangboard),自愈路径直接复用;
//   3) can_i 需要集群级 SSAR create → 共享 ClusterRole(aliangboard-mcp-cani)+ per-key ClusterRoleBinding。
// requestFn 注入(同全仓契约 (callCtx, path, init) => {body}),纯逻辑可单测。
import { effectiveTools, DANGEROUS_TOOLS } from './authorize.mjs'

const enc = encodeURIComponent
const id8 = (keyId) => String(keyId).slice(0, 8)
// 全部 tier 档名:tier 变更后旧档名 Role/RoleBinding 可能残留,teardown/sweep 须三档全清。
export const TIERS = ['read', 'operator', 'admin']
export const managedSaName = (keyId) => `aliangboard-mcp-${id8(keyId)}`
const labels = (keyId) => ({ 'app.kubernetes.io/managed-by': 'aliangboard', 'aliangboard.io/api-key': keyId })

// tier → namespaced Role 规则。read 覆盖 9 个只读工具所需(get/list + pods/log get + replicasets list[rollout_history] + secrets get[get_resource_yaml 镜像工具面]);
// operator 额外盖 scale/restart(patch 工作负载 + scale 子资源);admin = ns 内全权。
export function roleRules(tier) {
  const read = [
    { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list'] },
    { apiGroups: [''], resources: ['events', 'services', 'configmaps', 'persistentvolumeclaims', 'serviceaccounts'], verbs: ['get', 'list'] },
    { apiGroups: [''], resources: ['secrets'], verbs: ['get'] },
    { apiGroups: ['apps'], resources: ['deployments', 'statefulsets', 'daemonsets', 'replicasets'], verbs: ['get', 'list'] },
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies'], verbs: ['get', 'list'] },
  ]
  if (tier === 'read') return read
  if (tier === 'operator') return [...read,
    { apiGroups: ['apps'], resources: ['deployments', 'statefulsets', 'daemonsets'], verbs: ['patch'] },
    { apiGroups: ['apps'], resources: ['deployments/scale', 'statefulsets/scale'], verbs: ['patch'] },
  ]
  return [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }]
}

// RBAC 模板档位 ≥ key 实际工具面:tool_overrides 可越档放行(read key allow update_image)→ 模板必须盖住,否则工具被 RBAC 403。
export function rbacTier(keyRow) {
  const tools = effectiveTools(keyRow)
  for (const t of tools) if (DANGEROUS_TOOLS.includes(t)) return 'admin'
  if (tools.has('scale') || tools.has('restart')) return keyRow?.tier === 'admin' ? 'admin' : 'operator'
  return keyRow?.tier === 'admin' ? 'admin' : keyRow?.tier === 'operator' ? 'operator' : 'read'
}

// 幂等供给:SA(主 ns)+ 每 ns Role/RoleBinding(主 ns + namespaces)+ 共享 can-i ClusterRole + per-key CRB。
// 返回 {ok, applied, failed, total}(形状对齐 applyYamlPartial);部分失败不抛,由调用方决定成败口径。
export async function provisionSa({ requestFn, callCtx }, { keyId, namespace, name, tier, namespaces = [] }) {
  const nss = [...new Set([namespace, ...namespaces])]
  const applied = [], failed = []
  const ssa = async (path, object) => {
    const label = { kind: object.kind, name: object.metadata.name, namespace: object.metadata.namespace || null }
    try {
      await requestFn(callCtx, `${path}?fieldManager=aliangboard&force=true`, {
        method: 'PATCH', headers: { 'content-type': 'application/apply-patch+yaml' }, body: JSON.stringify(object),
      })
      applied.push(label)
    } catch (e) { failed.push({ ...label, error: e.message }) }
  }
  await ssa(`/api/v1/namespaces/${enc(namespace)}/serviceaccounts/${enc(name)}`, {
    apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace, labels: labels(keyId) },
  })
  const role = `aliangboard-mcp-${tier}-${id8(keyId)}`
  for (const ns of nss) {
    await ssa(`/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/roles/${enc(role)}`, {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: role, namespace: ns, labels: labels(keyId) }, rules: roleRules(tier),
    })
    await ssa(`/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/rolebindings/${enc(role)}`, {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: role, namespace: ns, labels: labels(keyId) },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role },
      subjects: [{ kind: 'ServiceAccount', name, namespace }],
    })
  }
  await ssa('/apis/rbac.authorization.k8s.io/v1/clusterroles/aliangboard-mcp-cani', {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
    metadata: { name: 'aliangboard-mcp-cani', labels: { 'app.kubernetes.io/managed-by': 'aliangboard' } },
    rules: [{ apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews'], verbs: ['create'] }],
  })
  await ssa(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${enc('aliangboard-mcp-cani-' + id8(keyId))}`, {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding',
    metadata: { name: 'aliangboard-mcp-cani-' + id8(keyId), labels: labels(keyId) },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'aliangboard-mcp-cani' },
    subjects: [{ kind: 'ServiceAccount', name, namespace }],
  })
  return { ok: failed.length === 0, applied, failed, total: applied.length + failed.length }
}

// 回收(best-effort,吊销时调用):SA/Role/RoleBinding/CRB;共享 ClusterRole 保留(其他 key 在用);404 视为成功。
// Role/RoleBinding 按 TIERS 三档名全删——tier 曾变更(降档/改覆盖)后旧档名残留,只删当前档名会留孤儿 RBAC。
export async function teardownSa({ requestFn, callCtx }, { keyId, namespace, name, tier, namespaces = [] }) {
  const nss = [...new Set([namespace, ...namespaces])]
  const paths = [
    `/api/v1/namespaces/${enc(namespace)}/serviceaccounts/${enc(name)}`,
    `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${enc('aliangboard-mcp-cani-' + id8(keyId))}`,
    ...nss.flatMap(ns => TIERS.flatMap(t => {
      const role = `aliangboard-mcp-${t}-${id8(keyId)}`
      return [
        `/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/rolebindings/${enc(role)}`,
        `/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/roles/${enc(role)}`,
      ]
    })),
  ]
  const deleted = [], errors = []
  for (const p of paths) {
    try { await requestFn(callCtx, p, { method: 'DELETE' }); deleted.push(p) }
    catch (e) { if (e.status !== 404) errors.push({ path: p, error: e.message }) }
  }
  return { deleted, errors }
}

// tier 变更后清理旧档:DELETE 除 keepTier 外两档的 Role+RoleBinding(repair 成功后 best-effort 调,404 容忍)。
export async function sweepStaleTierBindings({ requestFn, callCtx }, { keyId, namespace, keepTier, namespaces = [] }) {
  const nss = [...new Set([namespace, ...namespaces])]
  const paths = nss.flatMap(ns => TIERS.filter(t => t !== keepTier).flatMap(t => {
    const role = `aliangboard-mcp-${t}-${id8(keyId)}`
    return [
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/rolebindings/${enc(role)}`,
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${enc(ns)}/roles/${enc(role)}`,
    ]
  }))
  const deleted = [], errors = []
  for (const p of paths) {
    try { await requestFn(callCtx, p, { method: 'DELETE' }); deleted.push(p) }
    catch (e) { if (e.status !== 404) errors.push({ path: p, error: e.message }) }
  }
  return { deleted, errors }
}
