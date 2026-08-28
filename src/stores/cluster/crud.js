// cluster store · CRUD 域(Plan 5 拆分,2026-08-28):remote* 远端变更 helper(SSA apply→invalidate 语义)、
// makeCrud 工厂 + RESOURCE_SPECS 16 资源、Ingress 规则定点 PATCH、PV/SC 手写 CRUD、
// workload 删/改(getWorkloadForEdit=fetch-first 不变式的实现点)。自 cluster.js 逐字搬迁;
// 依赖显式注入(2026-08-09 mapper 抽取白屏事故教训),store 公开名不变。
// hpaPatchFn 在此模块级导出(cluster.js 再导出,既有单测 cluster.crud-factory.test.js 消费路径不变)。
import { api } from '@/api/client'
import { i18n } from '@/i18n'
import { notify } from '@/composables/useToast'
import { buildIngressRulesPatch } from '@/composables/useIngressRules'
import { buildPVPatch, buildStorageClassPatch } from '@/composables/useStoragePatch'
import { queryClient } from '@/queryClient'
import { encodeSecretData } from '@/composables/useResourceMappers'
import { invalidateResource } from './invalidate'
import { fetchConfigMap, fetchSecret, fetchService, fetchIngress, fetchIngressClass, fetchNetworkPolicy, fetchPDB, fetchLimitRange, fetchResourceQuota, fetchHPA, fetchPV, fetchPVC, fetchStorageClass, fetchRoleBinding, fetchRuntimeClass, fetchPriorityClass, fetchClusterRoleBinding, fetchServiceAccount } from '@/composables/useFetchers'

// HPA 定点 patch(strategic-merge):仅更新可编辑字段(minReplicas/maxReplicas/metrics),
// 保留 spec.behavior / scaleTargetRef 等其余字段 —— 避免全量 SSA prune。
export const hpaPatchFn = (name, ns, updates, before) => ({ spec: {
  minReplicas: updates.minReplicas ?? before.minReplicas,
  maxReplicas: updates.maxReplicas ?? before.maxReplicas,
  metrics: [
    { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: updates.cpuTarget ?? before.cpuTarget } } },
    { type: 'Resource', resource: { name: 'memory', target: { type: 'Utilization', averageUtilization: updates.memoryTarget ?? before.memoryTarget } } },
  ],
} })

export function createCrudDomain({ aliangTag, currentCluster, namespaceList, fetchWorkload, generateYAML, generateExtraYAML }) {
  async function remoteDelete(path, list, matchFn, label) {
    const idx = list.value.findIndex(matchFn)
    const backup = idx !== -1 ? list.value[idx] : null
    if (idx !== -1) list.value.splice(idx, 1)
    try {
      await api.k8s(path, { method: 'DELETE' })
    } catch (e) {
      if (backup) list.value.splice(idx, 0, backup)
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: label || i18n.global.t('store.resource'), msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }

  // 远端创建：用 generateYAML 生成清单 → server-side apply → 刷新对应列表
  async function remoteCreate(yamlStr, label, refreshFn) {
    try {
      await api.applyYaml(yamlStr)
      if (refreshFn) await refreshFn()
      notify('success', i18n.global.t('store.created', { label }))
      return { ok: true }
    } catch (e) {
      notify('error', i18n.global.t('store.createFailed', { label, msg: e.message || i18n.global.t('store.checkYamlPerm') }))
      return { ok: false }
    }
  }

  // 重新拉取某类资源列表（集群范围），创建后用于回填真实状态
  async function refetch(path, list, mapper) {
    try {
      const data = await api.k8s(`${path}?limit=500`)
      list.value = (data.items || []).map(mapper)
    } catch (e) { console.warn('[refetch] 刷新失败:', path, e?.message || e) }
  }

  // 远端结构化更新：用更新后的对象重新生成清单并 server-side apply（与 YAML 编辑器同链路）。
  // 适用于 generateYAML 无损的资源；失败回滚本地并提示。Workload 浅编辑等用 remotePatch 定点 PATCH。
  // {ok} 契约（与 remoteCreate/remoteDeletePath 对齐）：失败吞异常（内部已 toast）但必须返回 {ok:false}，
  // 调用方（如 NsServiceDetail.saveAddPort）据此决定关弹窗/报成功，不再无条件成功。
  async function remoteUpdate(yamlStr, label, rollbackFn) {
    try {
      await api.applyYaml(yamlStr)
      notify('success', `${label}${i18n.global.t('common.save')}`)
      return { ok: true }
    } catch (e) {
      notify('error', `${label}${i18n.global.t('store.saveFailed')}：${e.message || i18n.global.t('store.permissionDeniedOrConflict')}`)
      if (rollbackFn) rollbackFn()
      return { ok: false }
    }
  }
  // 远端定点 PATCH（application/merge-patch+json），失败回滚本地并提示;{ok} 契约同 remoteUpdate
  async function remotePatch(path, patch, label, rollbackFn) {
    try {
      await api.k8s(path, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(patch) })
      notify('success', `${label}${i18n.global.t('common.save')}`)
      return { ok: true }
    } catch (e) {
      notify('error', `${label}${i18n.global.t('store.saveFailed')}：${e.message || i18n.global.t('store.permissionDeniedOrNotExist')}`)
      if (rollbackFn) rollbackFn()
      return { ok: false }
    }
  }

  // === CRUD 工厂（全真实数据模型：纯远端 + Vue Query 缓存）===
  // makeCrud 为每类规整资源生成 add/update/delete 三函数：
  // - add: generateYAML → server-side apply → invalidateResource(刷 Vue Query)
  // - update: 从 Vue Query 缓存取当前对象（fromCache）→ merge → remoteUpdate/remotePatch
  //   · patchFn 资源(HPA)：定向 patch body，不 regenerate 全量 YAML
  //   · 缓存未命中：仅 invalidate（下次有缓存再编辑），不抛
  // - delete: api.k8s DELETE → invalidateResource
  // 集中 await + invalidateResource，结构性消灭 await-race。
  function makeCrud(plural, spec) {
    const { kind, group, resource, namespaced, genType = resource, genExtra = false,
            beforeSave, customYaml, patchFn, sideEffects, skipRemoteUpdate, fetch } = spec
    const genFn = genExtra ? generateExtraYAML : generateYAML
    const itemApi = (name, ns) => namespaced
      ? `${group}/namespaces/${encodeURIComponent(ns)}/${resource}/${encodeURIComponent(name)}`
      : `${group}/${resource}/${encodeURIComponent(name)}`
    const yamlOf = item => customYaml ? customYaml(item) : genFn(genType, beforeSave ? beforeSave(item) : item)

    // 从 Vue Query 缓存取当前对象（all-real-data 的唯一真相源；替代旧 store-ref idxOf）
    const fromCache = (name, ns) => {
      const cid = currentCluster.value || 'cluster'
      const list = queryClient.getQueryData(['cluster', cid, plural]) || []
      return list.find(x => x.name === name && (!namespaced || x.namespace === ns))
    }

    async function add(item) {
      const r = await remoteCreate(yamlOf(item), `${kind}/${item.name}`)
      if (r.ok && sideEffects?.onAdd) sideEffects.onAdd(item) // 失败不触发 sideEffects(修 services 计数漂移)
      invalidateResource(plural)
      return r // { ok } from remoteCreate;失败时已 toast,调用方可据 r.ok 决定后续(见 CreatePvcDialog)
    }
    // {ok} 契约（对齐 add/remove）：调用方必须据 r.ok 决定关弹窗/报成功
    async function update(name, ns, updates) {
      if (skipRemoteUpdate) return { ok: true }
      let cur = fromCache(name, ns)
      if (!cur && fetch) cur = await fetch(name, ns).catch(() => null)
      let r
      if (patchFn) {
        r = await remotePatch(itemApi(name, ns), patchFn(name, ns, updates, cur || {}), kind)
      } else {
        if (!cur) { invalidateResource(plural); return { ok: false, skipped: true } }
        const merged = { ...cur, ...(beforeSave ? beforeSave(updates) : updates) }
        r = await remoteUpdate(yamlOf(merged), kind)
      }
      if (r.ok && sideEffects?.onUpdate) sideEffects.onUpdate(name, ns)
      invalidateResource(plural)
      return r
    }
    async function remove(name, ns) {
      const r = await remoteDeletePath(itemApi(name, ns), `${kind}/${name}`)
      if (r.ok && sideEffects?.onDelete) sideEffects.onDelete(name, ns)
      invalidateResource(plural)
      return r
    }
    return { add, update, delete: remove }
  }

  // 远端删除（工厂专用）：纯 DELETE，无 store ref / 无乐观回滚——Vue Query invalidate 重拉即同步。
  async function remoteDeletePath(path, label) {
    try {
      await api.k8s(path, { method: 'DELETE' })
      return { ok: true }
    } catch (e) {
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: label || i18n.global.t('store.resource'), msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
      return { ok: false }
    }
  }

  const RESOURCE_SPECS = {
    configmaps: { kind: 'ConfigMap', group: '/api/v1', resource: 'configmaps', namespaced: true, genType: 'configmap', fetch: fetchConfigMap },
    secrets: { kind: 'Secret', group: '/api/v1', resource: 'secrets', namespaced: true, genType: 'secret', beforeSave: s => (s.data ? { ...s, data: encodeSecretData(s.data) } : s), fetch: fetchSecret },
    pvcs: { kind: 'PVC', group: '/api/v1', resource: 'persistentvolumeclaims', namespaced: true, genType: 'pvc', fetch: fetchPVC },
    services: { kind: 'Service', group: '/api/v1', resource: 'services', namespaced: true, genType: 'service', fetch: fetchService, sideEffects: {
      onAdd: svc => { const ns = namespaceList.value.find(n => n.name === svc.namespace); if (ns) ns.services = (ns.services || 0) + 1 },
      onDelete: (_n, ns) => { const nsObj = namespaceList.value.find(n => n.name === ns); if (nsObj) nsObj.services = Math.max(0, (nsObj.services || 0) - 1) },
    } },
    networkpolicies: { kind: 'NetworkPolicy', group: '/apis/networking.k8s.io/v1', resource: 'networkpolicies', namespaced: true, genType: 'networkpolicy', fetch: fetchNetworkPolicy },
    hpas: { kind: 'HPA', group: '/apis/autoscaling/v2', resource: 'horizontalpodautoscalers', namespaced: true, genType: 'hpa', patchFn: hpaPatchFn, fetch: fetchHPA },
    resourcequotas: { kind: 'ResourceQuota', group: '/api/v1', resource: 'resourcequotas', namespaced: true, genType: 'resourcequota', fetch: fetchResourceQuota },
    limitranges: { kind: 'LimitRange', group: '/api/v1', resource: 'limitranges', namespaced: true, genType: 'limitrange', fetch: fetchLimitRange },
    serviceaccounts: { kind: 'ServiceAccount', group: '/api/v1', resource: 'serviceaccounts', namespaced: true, genType: 'serviceaccount', fetch: fetchServiceAccount },
    rolebindings: { kind: 'RoleBinding', group: '/apis/rbac.authorization.k8s.io/v1', resource: 'rolebindings', namespaced: true, genType: 'rolebinding', fetch: fetchRoleBinding },
    poddisruptionbudgets: { kind: 'PDB', group: '/apis/policy/v1', resource: 'poddisruptionbudgets', namespaced: true, genType: 'pdb', genExtra: true, fetch: fetchPDB },
    ingresses: { kind: 'Ingress', group: '/apis/networking.k8s.io/v1', resource: 'ingresses', namespaced: true, genType: 'ingress', fetch: fetchIngress },
    // 集群级规整资源 (namespaced:false)：单一 API 端点 + 标准 remoteXxx
    ingressclasses: { kind: 'IngressClass', group: '/apis/networking.k8s.io/v1', resource: 'ingressclasses', namespaced: false, genType: 'ingressclass', fetch: fetchIngressClass },
    runtimeclasses: { kind: 'RuntimeClass', group: '/apis/node.k8s.io/v1', resource: 'runtimeclasses', namespaced: false, genType: 'runtimeclass', fetch: fetchRuntimeClass },
    priorityclasses: { kind: 'PriorityClass', group: '/apis/scheduling.k8s.io/v1', resource: 'priorityclasses', namespaced: false, genType: 'priorityclass', genExtra: true, fetch: fetchPriorityClass },
    clusterrolebindings: { kind: 'ClusterRoleBinding', group: '/apis/rbac.authorization.k8s.io/v1', resource: 'clusterrolebindings', namespaced: false, genType: 'clusterrolebinding', fetch: fetchClusterRoleBinding },
  }
  // 生成并顶替手写（解构到与原函数同名）
  const _crud = {}
  ;(_crud.configmaps = makeCrud('configmaps', RESOURCE_SPECS.configmaps))
  const { add: addConfigMap, update: updateConfigMap, delete: deleteConfigMap } = _crud.configmaps
  ;(_crud.secrets = makeCrud('secrets', RESOURCE_SPECS.secrets))
  const { add: addSecret, update: updateSecret, delete: deleteSecret } = _crud.secrets
  ;(_crud.pvcs = makeCrud('pvcs', RESOURCE_SPECS.pvcs))
  const { add: addPVC, update: updatePVC, delete: deletePVC } = _crud.pvcs
  ;(_crud.services = makeCrud('services', RESOURCE_SPECS.services))
  const { add: addService, update: updateService, delete: deleteService } = _crud.services
  ;(_crud.networkpolicies = makeCrud('networkpolicies', RESOURCE_SPECS.networkpolicies))
  const { add: addNetworkPolicy, update: updateNetworkPolicy, delete: deleteNetworkPolicy } = _crud.networkpolicies
  ;(_crud.hpas = makeCrud('hpas', RESOURCE_SPECS.hpas))
  const { add: addHPA, update: updateHPA, delete: deleteHPA } = _crud.hpas
  ;(_crud.resourcequotas = makeCrud('resourcequotas', RESOURCE_SPECS.resourcequotas))
  const { add: addResourceQuota, update: updateResourceQuota, delete: deleteResourceQuota } = _crud.resourcequotas
  ;(_crud.limitranges = makeCrud('limitranges', RESOURCE_SPECS.limitranges))
  const { add: addLimitRange, update: updateLimitRange, delete: deleteLimitRange } = _crud.limitranges
  ;(_crud.serviceaccounts = makeCrud('serviceaccounts', RESOURCE_SPECS.serviceaccounts))
  const { add: addServiceAccount, update: updateServiceAccount, delete: deleteServiceAccount } = _crud.serviceaccounts
  ;(_crud.rolebindings = makeCrud('rolebindings', RESOURCE_SPECS.rolebindings))
  const { add: addRoleBinding, update: updateRoleBinding, delete: deleteRoleBinding } = _crud.rolebindings
  ;(_crud.poddisruptionbudgets = makeCrud('poddisruptionbudgets', RESOURCE_SPECS.poddisruptionbudgets))
  const { add: addPDB, update: updatePDB, delete: deletePDB } = _crud.poddisruptionbudgets
  ;(_crud.ingresses = makeCrud('ingresses', RESOURCE_SPECS.ingresses))
  const { add: addIngress, update: updateIngress, delete: deleteIngress } = _crud.ingresses
  ;(_crud.ingressclasses = makeCrud('ingressclasses', RESOURCE_SPECS.ingressclasses))
  const { add: addIngressClass, update: updateIngressClass, delete: deleteIngressClass } = _crud.ingressclasses
  ;(_crud.runtimeclasses = makeCrud('runtimeclasses', RESOURCE_SPECS.runtimeclasses))
  const { add: addRuntimeClass, update: updateRuntimeClass, delete: deleteRuntimeClass } = _crud.runtimeclasses
  ;(_crud.priorityclasses = makeCrud('priorityclasses', RESOURCE_SPECS.priorityclasses))
  const { add: addPriorityClass, update: updatePriorityClass, delete: deletePriorityClass } = _crud.priorityclasses
  ;(_crud.clusterrolebindings = makeCrud('clusterrolebindings', RESOURCE_SPECS.clusterrolebindings))
  const { add: addClusterRoleBinding, update: updateClusterRoleBinding, delete: deleteClusterRoleBinding } = _crud.clusterrolebindings

  // === CRUD: Ingress (add/update/delete 已进工厂；updateIngressRules 手写——特殊 PATCH)===
  // 结构化编辑 Ingress 路由规则：入参 flatRules + defaultBackend，
  // 用 buildIngressRulesPatch 构造 PATCH body（rules + defaultBackend 一次提交）；
  // defaultBackend===null 时 merge-patch 删除该字段。
  // 单次远端写：PATCH 已携带全量 rules+defaultBackend；不再二次 updateIngress——
  // 那条链路走 generateYAML 有损 SSA（单 tls 折叠/无 defaultBackend 会静默剪除多 TLS 条目）。
  // 成功 toast 由调用方负责（④ NsIngressDetail.saveRules / ② NsWorkloadDetail.saveIngressMap 各自 notify）。
  async function updateIngressRules(name, ns, flatRules, defaultBackend = null) {
    const patch = buildIngressRulesPatch(flatRules, defaultBackend)
    await api.k8s(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/ingresses/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify(patch),
    })
    invalidateResource('ingresses') // Vue Query refetch 恢复缓存真值
  }

  // (ConfigMaps / Secrets / PVCs CRUD 已进工厂)

  // === CRUD: PersistentVolumes（集群级，手写——特殊 patch）===
  async function addPV(pv) {
    return remoteCreate(generateYAML('pv', pv), `PersistentVolume/${pv.name}`, () => invalidateResource('pvs'))
  }
  async function updatePV(name, updates) {
    const cur = await fetchPV(name).catch(() => null)
    if (!cur) { invalidateResource('pvs'); return }
    const patch = buildPVPatch(cur, updates)
    if (!patch) return
    await remotePatch(`/api/v1/persistentvolumes/${encodeURIComponent(name)}`, patch, 'PersistentVolume')
    invalidateResource('pvs') // Storage.vue 的 PV 查询 key 是 'pvs'(旧 'persistentvolumes' 失效打空)
  }
  async function deletePV(name) {
    try {
      await api.k8s(`/api/v1/persistentvolumes/${encodeURIComponent(name)}`, { method: 'DELETE' })
      invalidateResource('pvs')
    } catch (e) {
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: `PersistentVolume/${name}`, msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }

  // === CRUD: StorageClasses（集群级）===
  async function addStorageClass(sc) {
    return remoteCreate(generateYAML('storageclass', sc), `StorageClass/${sc.name}`, () => invalidateResource('storageclasses'))
  }
  async function updateStorageClass(name, updates) {
    const cur = await fetchStorageClass(name).catch(() => null)
    if (!cur) { invalidateResource('storageclasses'); return }
    const patch = buildStorageClassPatch(cur, updates)
    if (!patch) return
    await remotePatch(`/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`, patch, 'StorageClass')
    invalidateResource('storageclasses')
  }
  async function deleteStorageClass(name) {
    try {
      await api.k8s(`/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`, { method: 'DELETE' })
      invalidateResource('storageclasses')
    } catch (e) {
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: `StorageClass/${name}`, msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }

  async function deleteWorkload(name, ns) {
    const wl = await getWorkloadForEdit(name, ns)
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl?.type]
    if (!plural) { notify('error', i18n.global.t('store.deleteNotSupported', { type: wl?.type || i18n.global.t('store.thisWorkload') })); return }
    try {
      await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, { method: 'DELETE' })
      invalidateResource('workloads')
    } catch (e) {
      // 与旧 remoteDelete 一致：失败只提示不抛（handleDelete 仍会跳列表页）
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: i18n.global.t('store.workload'), msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }

  // 从 Vue Query 缓存或 API 取单个工作负载（all-real-data 真相源；替代旧 workloadList.findIndex）
  async function getWorkloadForEdit(name, ns) {
    const cid = currentCluster.value || 'cluster'
    const cached = queryClient.getQueryData(['cluster', cid, 'workloads']) || []
    const hit = cached.find(w => w.name === name && w.namespace === ns)
    if (hit) return hit
    // 缓存未命中：逐类型探测 API（Deployment/StatefulSet/DaemonSet）
    for (const type of ['Deployment', 'StatefulSet', 'DaemonSet']) {
      try { return await fetchWorkload(type, name, ns) } catch { /* 继续下一个类型 */ }
    }
    return null
  }

  async function updateWorkload(name, ns, updates) {
    const cur = await getWorkloadForEdit(name, ns)
    if (!cur) { invalidateResource('workloads'); return }
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[cur.type]
    // 定点 merge-patch：仅改动字段，避免 regenerate 丢失深模板（env/probes/卷）。Job/CronJob 等不支持定点编辑。
    if (plural) {
      const patch = {}
      // labels：合并 tier→layer.aliangboard.io，保留既有 labels（merge-patch 全量回写，故取并集）
      if (updates.labels || updates.tier != null) {
        const labels = { ...(updates.labels || cur.labels || {}) }
        if (updates.tier != null) labels['layer.aliangboard.io'] = updates.tier
        patch.metadata = { labels }
      }
      // 平台编辑自动 tag（managed-by + last-edited）
      const _edittag = aliangTag()
      patch.metadata = patch.metadata || {}
      patch.metadata.labels = { ...(patch.metadata.labels || {}), ..._edittag.labels }
      patch.metadata.annotations = _edittag.annotations
      const spec = {}
      if (updates.replicas != null) {
        const r = Number(String(updates.replicas).split('/')[0])
        if (!Number.isNaN(r)) spec.replicas = r
      }
      if (updates.image) {
        const tpl = cur.raw?.spec?.template || { spec: { containers: [{ name: cur.name, image: cur.image }] } }
        if (tpl.spec?.containers?.[0]) {
          const tpl2 = JSON.parse(JSON.stringify(tpl))
          tpl2.spec.containers[0].image = updates.image
          spec.template = tpl2
        }
      }
      // 更新策略 + 历史版本上限（Deployment 级 spec，不在 pod 模板）
      if (updates.strategy) {
        spec.strategy = { type: updates.strategy }
        if (updates.strategy === 'RollingUpdate') {
          const ru = {}
          if (updates.maxSurge != null && updates.maxSurge !== '') ru.maxSurge = updates.maxSurge
          if (updates.maxUnavailable != null && updates.maxUnavailable !== '') ru.maxUnavailable = updates.maxUnavailable
          if (Object.keys(ru).length) spec.strategy.rollingUpdate = ru
        }
      }
      if (updates.revisionHistoryLimit != null && updates.revisionHistoryLimit !== '') spec.revisionHistoryLimit = Number(updates.revisionHistoryLimit)
      if (Object.keys(spec).length) patch.spec = spec
      if (Object.keys(patch).length) {
        await remotePatch(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, patch, i18n.global.t('store.workload'))
      }
    }
    invalidateResource('workloads')
  }

  // 深度编辑工作负载的 Pod 模板（image/env/resources/probes/nodeSelector 等）：
  // 入参 template 为完整的 pod template 对象（深克隆后由视图修改）。
  // 远端 PATCH spec.template（全量 merge-patch，安全）；本地合并并刷新 image。仅 Deployment/StatefulSet/DaemonSet。
  // 就地修改任意资源的分层（NsLayers 用）：写 layer.aliangboard.io label 并本地即时反映。
  // 取当前 labels 再合并后全量回写，避免 merge-patch 下 labels 对象被替换而丢其它键。
  return {
    remoteDelete, remoteCreate, refetch, remoteUpdate, remotePatch, remoteDeletePath,
    addConfigMap, updateConfigMap, deleteConfigMap, addSecret, updateSecret, deleteSecret,
    addPVC, updatePVC, deletePVC, addService, updateService, deleteService,
    addNetworkPolicy, updateNetworkPolicy, deleteNetworkPolicy, addHPA, updateHPA, deleteHPA,
    addResourceQuota, updateResourceQuota, deleteResourceQuota, addLimitRange, updateLimitRange, deleteLimitRange,
    addServiceAccount, updateServiceAccount, deleteServiceAccount, addRoleBinding, updateRoleBinding, deleteRoleBinding,
    addPDB, updatePDB, deletePDB, addIngress, updateIngress, deleteIngress,
    addIngressClass, updateIngressClass, deleteIngressClass, addRuntimeClass, updateRuntimeClass, deleteRuntimeClass,
    addPriorityClass, updatePriorityClass, deletePriorityClass, addClusterRoleBinding, updateClusterRoleBinding, deleteClusterRoleBinding,
    updateIngressRules, addPV, updatePV, deletePV, addStorageClass, updateStorageClass, deleteStorageClass,
    deleteWorkload, getWorkloadForEdit, updateWorkload,
  }
}
