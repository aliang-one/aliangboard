// 拓扑域组合式(2026-09-01 拓扑整修):services/ingresses/pdbs/netpols 四查询自 NsWorkloadDetail
// 迁入,新增 replicasets/endpoints/hpas 三查询;七条统一 pollInterval 门控(B2:watch 降级时与
// workloads/pods 同 30s 兜底,新鲜度单轨)。workloads/pods 查询留在页面(多 Tab 共用),
// pollInterval/managedPods 经参数只读注入。判定纯函数在 logic/topology 与 logic/workloadMeta。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { notify } from '@/composables/useToast'
import { sameHostIngresses, appendPathToIngress } from '@/composables/useIngressRules'
import { pickIngressClassName } from '@/logic/ingressClass'
import { identitySelector, servicesBrokenBy, podTemplateLabels } from '@/logic/workloadMeta'
import { filterOwnIngressRules, classifyServiceDrift, endpointsForService, groupPodsByReplicaSet, latestOwnedRs, usedNodePortsFromServices, suggestNodePorts } from '@/logic/topology'

export function useWorkloadTopology({ workload, namespace, pollInterval, managedPods }) {
  const { t } = useI18n()
  const store = useClusterStore()
  const queryClient = useQueryClient()
  const cid = computed(() => (store.currentCluster || 'cluster'))
  const ns = () => namespace
  const POLL = { refetchInterval: pollInterval }

  const servicesQuery = useResourceList({ key: ['cluster', cid, 'services'], fetcher: () => store.fetchServices(), select: list => list.filter(s => s.namespace === ns()), options: POLL })
  const ingressesQuery = useResourceList({ key: ['cluster', cid, 'ingresses'], fetcher: () => store.fetchIngresses(), select: list => list.filter(i => i.namespace === ns()), options: POLL })
  const pdbsQuery = useResourceList({ key: ['cluster', cid, 'poddisruptionbudgets'], fetcher: () => store.fetchPDBs(), select: list => list.filter(p => p.namespace === ns()), options: POLL })
  const netpolsQuery = useResourceList({ key: ['cluster', cid, 'networkpolicies'], fetcher: () => store.fetchNetworkPolicies(), select: list => list.filter(n => n.namespace === ns()), options: POLL })
  const endpointsQuery = useResourceList({ key: ['cluster', cid, 'endpoints'], fetcher: () => store.fetchEndpoints(), select: list => list.filter(e => e.namespace === ns()), options: POLL })
  const hpasQuery = useResourceList({ key: ['cluster', cid, 'hpas'], fetcher: () => store.fetchHPAs(), select: list => list.filter(h => h.namespace === ns()), options: POLL })
  const rsQuery = useResourceList({
    key: ['cluster', cid, 'replicasets', namespace],
    fetcher: () => store.fetchReplicaSets(ns()),
    select: list => list.filter(r => r.namespace === ns()),
    options: { ...POLL, enabled: () => workload.value?.type === 'Deployment' },
  })
  // IngressClass 单源(集群级;与 NsIngress/DeployApp 同 key → 命中 Vue Query 缓存,零额外请求)
  const ingressClassesQuery = useResourceList({ key: ['cluster', cid, 'ingressclasses'], fetcher: () => store.fetchIngressClasses(), options: { staleTime: 60_000 } })
  const ingressClassList = computed(() => ingressClassesQuery.data.value || [])

  const serviceList = computed(() => servicesQuery.data.value || [])
  const ingressList = computed(() => ingressesQuery.data.value || [])
  const pdbList = computed(() => pdbsQuery.data.value || [])
  const netpolList = computed(() => netpolsQuery.data.value || [])

  // A2:Pod 模板标签单源(CronJob 走 jobTemplate)
  const tplLabels = computed(() => podTemplateLabels(workload.value?.raw))

  // 关联 Service:selector ⊆ 模板 labels
  const relatedServices = computed(() => serviceList.value.filter(s => s.selector && Object.keys(s.selector).length && Object.entries(s.selector).every(([k, v]) => tplLabels.value[k] === v)))
  const relatedServiceNames = computed(() => new Set(relatedServices.value.map(s => s.name)))
  const relatedIngresses = computed(() => ingressList.value.filter(ing => (ing.rules || []).some(r => (r.http?.paths || []).some(p => { const be = p.backend?.service || p.backend; return relatedServiceNames.value.has(be?.name) }))))
  // A1:本负载路由(共享 Ingress 不再张冠李戴)
  const ingressBreakdown = computed(() => filterOwnIngressRules(relatedIngresses.value, relatedServiceNames.value))

  // 失配 Service(两档):归属判据保持「selector 值含本负载名」启发式(防线④精度语义不变),
  // 档位由 classifyServiceDrift 依模板 labels + 实际 Pod + Endpoints 判定(C7)
  const driftedServices = computed(() => {
    const name = workload.value?.name
    if (!name) return []
    const broken = new Set(servicesBrokenBy(tplLabels.value, serviceList.value))
    const eps = endpointsQuery.data.value || []
    return serviceList.value
      .filter(s => broken.has(s.name) && Object.values(s.selector || {}).map(String).includes(name))
      .map(s => ({ ...s, drift: classifyServiceDrift(s, tplLabels.value, managedPods.value || [], endpointsForService(eps, s.name)) }))
      .filter(s => s.drift)
  })
  const epFor = name => endpointsForService(endpointsQuery.data.value || [], name)

  // C2 附挂:HPA(scaleTargetRef 命中本负载)+ 标签消费者(selector ⊆ 模板 labels 精度语义)
  const workloadHpas = computed(() => (hpasQuery.data.value || []).filter(h => h.targetName === workload.value?.name && (h.targetKind || 'Deployment') === workload.value?.type))
  const labelConsumers = computed(() => {
    const subset = sel => Object.entries(sel || {}).every(([k, v]) => k in tplLabels.value && String(tplLabels.value[k]) === String(v))
    return [
      ...pdbList.value.filter(p => subset(p.selector)).map(p => ({ kind: 'PDB', name: p.name, disruptive: p.raw?.status?.disruptionsAllowed === 0, selector: p.selector })),
      ...netpolList.value.filter(n => subset(n.podSelector)).map(n => ({ kind: 'NetworkPolicy', name: n.name, selector: n.podSelector })),
    ]
  })

  // C1:本负载 owned RS(最新/淘汰)+ Pod 分组
  const replicaSets = computed(() => (rsQuery.data.value || []).filter(rs2 => (rs2.raw?.metadata?.ownerReferences || []).some(o => o.kind === 'Deployment' && o.controller && o.name === workload.value?.name)))
  const latestRs = computed(() => latestOwnedRs(replicaSets.value))
  const podsGrouped = computed(() => groupPodsByReplicaSet(managedPods.value || [], replicaSets.value))

  // C5:STS governing service
  const governingSvcName = computed(() => (workload.value?.type === 'StatefulSet' ? workload.value?.raw?.spec?.serviceName : '') || '')

  // 网络暴露(自 NsWorkloadDetail :750-754 原样迁入)
  const containerPorts = computed(() => {
    const out = []
    const wl = workload.value
    const podSpec = wl?.type === 'CronJob' ? wl?.raw?.spec?.jobTemplate?.spec?.template?.spec : wl?.raw?.spec?.template?.spec
    for (const c of (podSpec?.containers || [])) for (const p of (c.ports || [])) out.push({ container: c.name, port: p.containerPort, name: p.name, protocol: p.protocol || 'TCP' })
    return out
  })
  const identitySel = computed(() => identitySelector(workload.value?.raw, tplLabels.value, workload.value?.name))

  // === 弹窗状态与动作(自 NsWorkloadDetail :814-902 迁入;差异处见注释)===
  const showExposeModal = ref(false)
  const exposeForm = ref({ name: '', type: 'ClusterIP', ports: [] })
  function openExpose() {
    const base = workload.value?.name || 'app'
    const existing = new Set(relatedServices.value.map(s => s.name))
    let name = `${base}-svc`, n = 2
    while (existing.has(name)) name = `${base}-svc-${n++}`
    // D1:不再猜 80→8080;无声明端口时空一行由用户填。nodePort:NodePort/LoadBalancer 专属,留空=集群自动分配
    exposeForm.value = { name, type: 'ClusterIP', ports: containerPorts.value.length ? containerPorts.value.map(p => ({ port: p.port, targetPort: p.port, protocol: p.protocol, nodePort: '' })) : [{ port: '', targetPort: '', protocol: 'TCP', nodePort: '' }] }
    showExposeModal.value = true
  }
  // nodePort 推荐:占用是集群级的(跨 ns 都会撞),须看【全量】Service——query 缓存存 fetcher 原始数据
  // (select 只影响读取面),直接取缓存;无缓存时 fetchQuery 拉一次。只填空行,不覆盖手填值。
  const isNodePortType = () => ['NodePort', 'LoadBalancer'].includes(exposeForm.value.type)
  async function recommendNodePorts() {
    if (!isNodePortType()) return
    const key = ['cluster', cid.value, 'services']
    let all = queryClient.getQueryData(key)
    if (!Array.isArray(all) || !all.length) all = await queryClient.fetchQuery({ queryKey: key, queryFn: () => store.fetchServices() })
    const used = new Set(usedNodePortsFromServices(Array.isArray(all) ? all : []))
    const empties = exposeForm.value.ports.filter(p => p.nodePort === '' || p.nodePort == null)
    suggestNodePorts([...used], empties.length).forEach((port, i) => { empties[i].nodePort = port; used.add(port) })
  }
  async function saveExpose() {
    try {
      const sel = identitySel.value
      if (!Object.keys(sel).length) { notify('error', t('workload.expose.identityRequired')); return }
      // D1:至少一个有效端口,不静默丢弃
      const ports = exposeForm.value.ports.filter(p => p.port)
      if (!ports.length) { notify('error', t('workload.expose.portRequired')); return }
      // nodePort 校验(分级):填了必须是 1-65535 数字;默认 range(30000-32767)外放行——自定义 range 集群合法,交 API 裁
      for (const p of ports) {
        if (p.nodePort === '' || p.nodePort == null) continue
        const n = Number(p.nodePort)
        if (!Number.isFinite(n) || n < 1 || n > 65535) { notify('error', t('workload.expose.nodePortInvalid')); return }
      }
      // 结构化 portList 无损通道(generateYAML('service') 优先吃它,nodePort 在此输出;扁平串通道废弃)
      const portList = ports.map(p => ({
        name: '', port: Number(p.port), targetPort: p.targetPort === '' || p.targetPort == null ? Number(p.port) : Number(p.targetPort),
        protocol: p.protocol || 'TCP',
        nodePort: isNodePortType() && p.nodePort !== '' && p.nodePort != null ? Number(p.nodePort) : null,
        appProtocol: '',
      }))
      const r = await store.addService({ name: exposeForm.value.name, namespace: ns(), type: exposeForm.value.type, clusterIP: '', portList, selector: sel })
      if (r && r.ok === false) return
      notify('success', t('workload.notify.createdService', { name: exposeForm.value.name })); showExposeModal.value = false
    } catch (e) { notify('error', e.message || t('workload.notify.createServiceFailed')) }
  }
  const showIngressMapModal = ref(false)
  const ingressMapForm = ref({ name: '', host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: '', target: '' })
  const sameHost = computed(() => sameHostIngresses(ingressList.value || [], ingressMapForm.value.host))
  // target 与候选同步：候选出现/变化时默认选首项（追加优先——原生 select v-model='' 只会显示空白并落入新建分支）；
  // 现 target 已不在候选（host 改过）则改选新候选首项，杜绝向不同 host 的 Ingress 静默追加；用户显式选 'new' 不覆盖。
  watch(sameHost, list => {
    const cur = ingressMapForm.value.target
    if (cur === 'new') return
    if (cur && list.some(i => i.name === cur)) return
    ingressMapForm.value.target = list.length ? list[0].name : ''
  })
  const mapConflict = ref('')
  const mapSvcOptions = computed(() => {
    const related = new Set(relatedServices.value.map(s => s.name))
    const badge = t('workload.ingressMap.relatedBadge')
    return serviceList.value
      .map(s => ({ related: related.has(s.name), label: related.has(s.name) ? `${s.name}${badge}` : s.name, value: s.name }))
      .sort((a, b) => Number(b.related) - Number(a.related))
      .map(({ label, value }) => ({ label, value }))
  })
  const mapPortsFor = computed(() => {
    const svc = serviceList.value.find(s => s.name === ingressMapForm.value.serviceName)
    return (svc?.portList || []).map(p => p.port)
  })
  function openIngressMap() {
    const svc = relatedServices.value[0]
    const base = workload.value?.name || 'app'
    const existing = new Set(ingressList.value.map(i => i.name))
    let name = `${base}-ingress`, n = 2
    while (existing.has(name)) name = `${base}-ingress-${n++}`
    mapConflict.value = ''
    ingressMapForm.value = { name, host: '', path: '/', pathType: 'Prefix', serviceName: svc?.name || '', servicePort: (svc?.portList || [])[0]?.port || '', target: '' }
    showIngressMapModal.value = true
  }
  async function saveIngressMap() {
    const f = ingressMapForm.value
    if (!f.serviceName) { notify('error', t('workload.notify.selectService')); return }
    // A5:端口必填(无值必生成坏 backend;不再静默兜底 80)
    if (f.servicePort === '' || f.servicePort == null) { notify('error', t('workload.ingressMap.portRequired')); return }
    const rule = { host: (f.host || '').trim(), path: f.path || '/', pathType: f.pathType, serviceName: f.serviceName, servicePort: f.servicePort }
    const targetIng = f.target && f.target !== 'new' ? (ingressList.value || []).find(i => i.name === f.target) : null
    if (targetIng) {
      const { flatRules, conflict } = appendPathToIngress(targetIng, rule)
      if (conflict) { mapConflict.value = t('workload.ingressMap.conflict', { path: rule.path }); return }
      mapConflict.value = ''
      const db = targetIng.defaultBackend?.serviceName
        ? { enabled: true, serviceName: targetIng.defaultBackend.serviceName, servicePort: targetIng.defaultBackend.servicePort }
        : null
      try {
        await store.updateIngressRules(targetIng.name, ns(), flatRules, db)
      } catch (e) { notify('error', e.message || t('workload.notify.createIngressFailed')); return }
      notify('success', t('workload.notify.createdIngress', { host: rule.host || '*', path: rule.path, service: rule.serviceName, port: rule.servicePort }))
      showIngressMapModal.value = false
      return
    }
    // 新建模式:端口已校验非空,去掉旧 || 80 兜底(A5)
    // addIngress 失败返回 {ok:false}(store 已 toast 错误):据 r.ok 决定后续,失败保留弹窗不误报成功;
    // 若 addIngress 抛异常同样 catch 错误 notify(与原实现 saveExpose 同款兜底)
    try {
      // 「集群默认」退役(2026-09-01):className 恒选确定类(isDefault 优先,否则字母序第一),无类回退 ''(原行为)
      const r = await store.addIngress({ name: f.name || `${workload.value?.name || 'app'}-ingress`, namespace: ns(), className: pickIngressClassName(ingressClassList.value), tls: false, tlsSecret: '', rules: [{ host: rule.host, http: { paths: [{ path: rule.path, pathType: rule.pathType, backend: { serviceName: rule.serviceName, servicePort: Number(rule.servicePort) } }] } }] })
      if (r && r.ok === false) return
      notify('success', t('workload.notify.createdIngress', { host: rule.host || '*', path: rule.path, service: rule.serviceName, port: rule.servicePort }))
      showIngressMapModal.value = false
    } catch (e) { notify('error', e.message || t('workload.notify.createIngressFailed')) }
  }
  const repairingSvc = ref('')
  async function repairServiceSelector(name) {
    const sel = identitySel.value
    if (!Object.keys(sel).length) return
    const svc = serviceList.value.find(s => s.name === name)
    if (!svc) return
    repairingSvc.value = name
    try {
      const r = await store.updateService(name, ns(), { selector: sel })
      if (!(r && r.ok === false)) notify('success', t('workload.topology.selectorRepaired', { name }))
    } catch (e) { notify('error', e.message || t('workload.notify.saveFailed')) }
    repairingSvc.value = ''
  }

  // B1:各查询 pending 态(展示层骨架 vs 空态分流用)
  const states = computed(() => ({
    servicesPending: !!servicesQuery.isPending.value,
    ingressesPending: !!ingressesQuery.isPending.value,
  }))

  return {
    tplLabels, relatedServices, relatedServiceNames, relatedIngresses, ingressBreakdown,
    driftedServices, epFor, workloadHpas, labelConsumers,
    replicaSets, latestRs, podsGrouped, governingSvcName, containerPorts, identitySel, states,
    showExposeModal, exposeForm, openExpose, saveExpose, recommendNodePorts, isNodePortType,
    showIngressMapModal, ingressMapForm, sameHost, mapConflict, mapSvcOptions, mapPortsFor, openIngressMap, saveIngressMap,
    repairingSvc, repairServiceSelector,
  }
}
