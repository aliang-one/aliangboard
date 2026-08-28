// cluster store · RBAC 域(Plan 5 第二波,2026-08-28):Role 手写 CRUD(Cluster/Namespace 双 scope,
// SSA 全量重建语义)+ checkAccess 本地推演(kubectl auth can-i 近似:subject→bindings→rules 合取)。
// 自 cluster.js 逐字搬迁;依赖显式注入;store 公开名不变。
import { api } from '@/api/client'
import { i18n } from '@/i18n'
import { notify } from '@/composables/useToast'
import { queryClient } from '@/queryClient'
import { invalidateResource } from './invalidate'
import { fetchRole, fetchClusterRole } from '@/composables/useFetchers'

export function createRbacDomain({ remoteCreate, remoteUpdate, generateYAML }) {
  // === CRUD: RBAC (Role 手写——Cluster/Namespace 双 scope；ServiceAccount/RoleBinding 已进工厂)===
  async function addRole(role) {
    return remoteCreate(generateYAML('role', role), `${role.scope === 'Cluster' ? 'ClusterRole' : 'Role'}/${role.name}`, () => invalidateResource('roles'))
  }

  async function updateRole(name, ns, updates) {
    // Role 双 scope：优先 namespace Role，失败则试 ClusterRole
    let cur = null
    if (ns) cur = await fetchRole(name, ns).catch(() => null)
    if (!cur) cur = await fetchClusterRole(name).catch(() => null)
    if (!cur) { invalidateResource('roles'); return }
    const merged = { ...cur, ...updates }
    await remoteUpdate(generateYAML('role', merged), 'Role')
    invalidateResource('roles')
  }

  async function deleteRole(name, ns) {
    // P2-B:ns 空 = ClusterRole。旧版读孤儿 roleList 判 scope(恒 undefined)→ 删 ClusterRole
    // 永远错走 namespaced 路径 404(RBAC 页 clusterrole 行的删除曾必失败)。
    const path = ns
      ? `/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/roles/${encodeURIComponent(name)}`
      : `/apis/rbac.authorization.k8s.io/v1/clusterroles/${encodeURIComponent(name)}`
    try {
      await api.k8s(path, { method: 'DELETE' })
      invalidateResource('roles') // fetchRoles 合并 roles+clusterroles,单 key 覆盖双端点
    } catch (e) {
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: `Role/${name}`, msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }
  // === RBAC 权限模拟(kubectl auth can-i 语义)===
  // === RBAC 权限模拟（kubectl auth can-i 语义）===
  // 根据 subject 匹配的 RoleBinding/ClusterRoleBinding → Role/ClusterRole 的 rules，
  // 判断该 subject 能否对指定 resource 执行指定 verb。纯前端基于本地缓存数据推演。
  const RESOURCE_TO_APIGROUP = {
    pods: '', services: '', configmaps: '', secrets: '', endpoints: '', namespaces: '', nodes: '',
    persistentvolumeclaims: '', persistentvolumes: '',
    deployments: 'apps', statefulsets: 'apps', daemonsets: 'apps', replicasets: 'apps',
    ingresses: 'networking.k8s.io', networkpolicies: 'networking.k8s.io',
    roles: 'rbac.authorization.k8s.io', rolebindings: 'rbac.authorization.k8s.io',
    clusterroles: 'rbac.authorization.k8s.io', clusterrolebindings: 'rbac.authorization.k8s.io',
    jobs: 'batch', cronjobs: 'batch', horizontalpodautoscalers: 'autoscaling',
    serviceaccounts: '', persistentvolumeclaims2: '',
  }
  function checkAccess({ subjectKind, subjectName, verb, resource, namespace }) {
    const group = RESOURCE_TO_APIGROUP[resource] ?? ''
    // P2-B:读 Vue Query 缓存(RbacCanI 挂载即预热;旧读孤儿三表恒空 → 模拟器永远拒绝)。
    const _cid = currentCluster.value || 'cluster'
    const roles = queryClient.getQueryData(['cluster', _cid, 'roles']) || []
    const rb = queryClient.getQueryData(['cluster', _cid, 'rolebindings']) || []
    const crb = queryClient.getQueryData(['cluster', _cid, 'clusterrolebindings']) || []
    // 命名空间级 RoleBinding 仅在所属 ns 生效；ClusterRoleBinding 全局生效
    const bindings = [
      ...rb.filter(b => !namespace || b.namespace === namespace).map(b => ({ ...b, bindingKind: 'RoleBinding' })),
      ...crb.map(b => ({ ...b, bindingKind: 'ClusterRoleBinding' })),
    ]
    for (const b of bindings) {
      const subs = b.subjects || []
      // 精确匹配 subject 名称（subjectName 为空表示通配查询）；类型一致或未指定
      const hit = subs.some(s => {
        if (subjectName && s.name !== subjectName) return false
        if (subjectKind && s.kind && s.kind !== subjectKind) return false
        return true
      })
      if (!hit) continue
      const wantCluster = (b.roleKind || 'Role') === 'ClusterRole' || b.bindingKind === 'ClusterRoleBinding'
      const role = roles.find(r => r.name === b.roleName && (wantCluster ? r.scope === 'Cluster' : r.scope !== 'Cluster' && (!b.namespace || r.namespace === b.namespace)))
      if (!role) continue
      for (const rule of (role.rules || [])) {
        const groups = rule.apiGroups || ['']
        const resources = rule.resources || []
        const verbs = rule.verbs || []
        const groupOk = groups.includes('*') || groups.includes(group)
        const resOk = resources.includes('*') || resources.includes(resource)
        const verbOk = verbs.includes('*') || verbs.includes(verb)
        if (groupOk && resOk && verbOk) {
          return {
            allowed: true,
            matchedBy: `${b.bindingKind} "${b.name}" → ${role.scope === 'Cluster' ? 'ClusterRole' : 'Role'} "${role.name}"`,
            rule,
          }
        }
      }
    }
    return { allowed: false, matchedBy: null, rule: null }
  }
  return { addRole, updateRole, deleteRole, checkAccess }
}
