import { createRouter, createWebHistory } from 'vue-router'
import { i18n } from '@/i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import { useClusterStore } from '@/stores/cluster'
import { useAuthStore } from '@/stores/auth'
import { api, clearSession, getSession, getPlatformToken } from '@/api/client'
import { resolveWhenSessionMissing } from './clusterGate'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { titleKey: 'route.login' }
  },
  {
    path: '/select-cluster',
    name: 'SelectCluster',
    component: () => import('@/views/SelectCluster.vue'),
    meta: { titleKey: 'selectCluster.title' }
  },
  {
    // 添加集群独立页(admin):AppLayout 外全屏,创建→自动连接→进 Overview。
    // requiresCluster: false → 无 K8s session 时守卫放行(clusterGate);requireAdmin 由页面自查+服务端兜底。
    path: '/add-cluster',
    name: 'AddCluster',
    component: () => import('@/views/AddCluster.vue'),
    meta: { titleKey: 'addCluster.title', requiresCluster: false, requireAdmin: true }
  },
  {
    // 独立终端弹窗（新标签页打开），不走 AppLayout（无侧栏/顶栏，纯全屏终端）
    path: '/terminal-popup',
    name: 'TerminalPopup',
    component: () => import('@/views/TerminalPopup.vue'),
    meta: { titleKey: 'route.terminal' }
  },
  {
    // SSH 终端独立弹窗(新标签页):同 sid 接网关保活会话,打开即回放续跑
    path: '/ssh-terminal-popup',
    name: 'SshTerminalPopup',
    component: () => import('@/views/SshTerminalPopup.vue'),
    meta: { titleKey: 'nav.workbench' }
  },
  {
    // 独立日志页（新浏览器标签页打开），不走 AppLayout（无侧栏/顶栏，全屏日志）
    path: '/log-popup',
    name: 'LogPopup',
    component: () => import('@/views/LogPopup.vue'),
    meta: { titleKey: 'route.logs' }
  },
  {
    path: '/',
    component: AppLayout,
    redirect: '/cluster',
    children: [
      // === 全局页面（不需要选择 Namespace）===
      {
        path: 'cluster',
        name: 'ClusterOverview',
        component: () => import('@/views/ClusterOverview.vue'),
        meta: { titleKey: 'route.clusterOverview', icon: 'dashboard', scope: 'global' }
      },
      {
        path: 'monitoring',
        name: 'MonitoringCenter',
        component: () => import('@/views/MonitoringCenter.vue'),
        meta: { titleKey: 'nav.monitoring', icon: 'monitoring', scope: 'global' }
      },
      {
        path: 'nodes',
        name: 'Nodes',
        component: () => import('@/views/Nodes.vue'),
        meta: { titleKey: 'nav.nodes', icon: 'dns', scope: 'global' }
      },
      {
        path: 'nodes/:name',
        name: 'NodeDetail',
        component: () => import('@/views/NodeDetail.vue'),
        meta: { titleKey: 'route.nodeDetail', scope: 'global' }
      },
      {
        path: 'workloads',
        name: 'Workloads',
        component: () => import('@/views/Workloads.vue'),
        meta: { titleKey: 'nav.workloads', icon: 'apps', scope: 'global' }
      },
      {
        path: 'workloads/:type/:name',
        name: 'WorkloadDetail',
        component: () => import('@/views/WorkloadDetail.vue'),
        meta: { titleKey: 'route.workloadDetail', scope: 'global' }
      },
      {
        path: 'pods/:namespace/:name',
        name: 'PodDetail',
        component: () => import('@/views/PodDetail.vue'),
        meta: { titleKey: 'route.podDetail', scope: 'global' }
      },
      {
        path: 'network',
        name: 'Network',
        component: () => import('@/views/Network.vue'),
        meta: { titleKey: 'nav.network', icon: 'share', scope: 'global' }
      },
      {
        path: 'storage',
        name: 'Storage',
        component: () => import('@/views/Storage.vue'),
        meta: { titleKey: 'route.storage', icon: 'storage', scope: 'global' }
      },
      {
        path: 'configuration',
        name: 'Configuration',
        component: () => import('@/views/Configuration.vue'),
        meta: { titleKey: 'route.configuration', icon: 'description', scope: 'global' }
      },
      {
        path: 'rbac',
        name: 'RBAC',
        component: () => import('@/views/RBAC.vue'),
        meta: { titleKey: 'route.rbac', icon: 'admin_panel_settings', scope: 'global' }
      },
      {
        path: 'rbac/can-i',
        name: 'RbacCanI',
        component: () => import('@/views/RbacCanI.vue'),
        meta: { titleKey: 'route.canI', icon: 'verified_user', scope: 'global' }
      },
      {
        path: 'deploy',
        name: 'Deploy',
        component: () => import('@/views/DeployApp.vue'),
        meta: { titleKey: 'nav.deploy', icon: 'rocket_launch', scope: 'global' }
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/Settings.vue'),
        meta: { titleKey: 'nav.settings', icon: 'tune', scope: 'global' }
      },
      {
        path: 'clusters',
        name: 'Clusters',
        component: () => import('@/views/Clusters.vue'),
        meta: { titleKey: 'nav.clusters', icon: 'hub', scope: 'global' }
      },
      {
        path: 'crds',
        name: 'CrdList',
        component: () => import('@/views/CrdList.vue'),
        meta: { titleKey: 'nav.crds', icon: 'extension', scope: 'global' }
      },
      {
        path: 'crds/:name',
        name: 'CrdDetail',
        component: () => import('@/views/CrdDetail.vue'),
        meta: { titleKey: 'route.crdDetail', scope: 'global' }
      },
      {
        path: 'audit-logs',
        name: 'AuditLogs',
        component: () => import('@/views/AuditLogs.vue'),
        meta: { titleKey: 'route.auditLogs', icon: 'history', scope: 'global' }
      },
      {
        path: 'priorityclasses',
        name: 'PriorityClasses',
        component: () => import('@/views/PriorityClasses.vue'),
        meta: { titleKey: 'route.priorityClasses', icon: 'flag', scope: 'global' }
      },
      {
        path: 'ingressclasses',
        name: 'IngressClasses',
        component: () => import('@/views/IngressClasses.vue'),
        meta: { titleKey: 'route.ingressClasses', icon: 'language', scope: 'global' }
      },
      {
        path: 'runtimeclasses',
        name: 'RuntimeClasses',
        component: () => import('@/views/RuntimeClasses.vue'),
        meta: { titleKey: 'route.runtimeClasses', icon: 'memory', scope: 'global' }
      },
      {
        path: 'admin/apiservices',
        name: 'APIServices',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { titleKey: 'route.apiServices', icon: 'api', scope: 'global', resource: 'apiservices' }
      },
      {
        path: 'admin/webhooks-mutating',
        name: 'MutatingWebhooks',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { titleKey: 'route.mutatingWebhooks', icon: 'webhook', scope: 'global', resource: 'mutatingwebhooks' }
      },
      {
        path: 'admin/webhooks-validating',
        name: 'ValidatingWebhooks',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { titleKey: 'route.validatingWebhooks', icon: 'rule', scope: 'global', resource: 'validatingwebhooks' }
      },
      {
        path: 'admin/replicasets',
        name: 'ReplicaSets',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { titleKey: 'route.replicaSets', icon: 'dynamic_feed', scope: 'global', resource: 'replicasets' }
      },
      {
        path: 'admin/csinodes',
        name: 'CSINodes',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { titleKey: 'route.csiNodes', icon: 'hard_drive', scope: 'global', resource: 'csinodes' }
      },
      {
        path: 'priorityclasses/:name',
        name: 'PriorityClassDetail',
        component: () => import('@/views/PriorityClassDetail.vue'),
        meta: { titleKey: 'route.priorityClassDetail', scope: 'global' }
      },
      {
        path: 'pv/:name',
        name: 'PVDetail',
        component: () => import('@/views/PVDetail.vue'),
        meta: { titleKey: 'route.pvDetail', scope: 'global' }
      },
      {
        path: 'storageclass/:name',
        name: 'StorageClassDetail',
        component: () => import('@/views/StorageClassDetail.vue'),
        meta: { titleKey: 'route.storageClassDetail', scope: 'global' }
      },
      {
        path: 'clusterrole/:name',
        name: 'ClusterRoleDetail',
        component: () => import('@/views/ClusterRoleDetail.vue'),
        meta: { titleKey: 'route.clusterRoleDetail', scope: 'global' }
      },
      {
        path: 'clusterrolebinding/:name',
        name: 'ClusterRoleBindingDetail',
        component: () => import('@/views/ClusterRoleBindingDetail.vue'),
        meta: { titleKey: 'route.clusterRoleBindingDetail', scope: 'global' }
      },
      {
        path: 'namespaces',
        name: 'Namespaces',
        component: () => import('@/views/Namespaces.vue'),
        meta: { titleKey: 'nav.namespaces', icon: 'folder_open', scope: 'global' }
      },
      {
        path: 'namespaces/:name',
        name: 'NamespaceDetail',
        component: () => import('@/views/NamespaceDetail.vue'),
        meta: { titleKey: 'route.namespaceDetail', scope: 'global' }
      },

      // === Namespace 作用域页面 ===
      {
        path: 'ns/:namespace',
        name: 'NamespaceOverview',
        component: () => import('@/views/NamespaceOverview.vue'),
        meta: { titleKey: 'route.namespaceOverview', icon: 'dashboard', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/workloads',
        name: 'NsWorkloads',
        component: () => import('@/views/NsWorkloads.vue'),
        meta: { titleKey: 'nav.workloads', icon: 'apps', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/layers',
        name: 'NsLayers',
        component: () => import('@/views/NsLayers.vue'),
        meta: { titleKey: 'route.layers', icon: 'layers', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/workloads/:type/:name',
        name: 'NsWorkloadDetail',
        component: () => import('@/views/NsWorkloadDetail.vue'),
        meta: { titleKey: 'route.workloadDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/pods',
        name: 'NsPods',
        component: () => import('@/views/NsPods.vue'),
        meta: { titleKey: 'route.pods', icon: 'layers', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/pods/:name',
        name: 'NsPodDetail',
        component: () => import('@/views/PodDetail.vue'),
        meta: { titleKey: 'route.podDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/services',
        name: 'NsServices',
        component: () => import('@/views/NsServices.vue'),
        meta: { titleKey: 'route.services', icon: 'hub', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/services/:name',
        name: 'NsServiceDetail',
        component: () => import('@/views/NsServiceDetail.vue'),
        meta: { titleKey: 'route.serviceDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/endpoints',
        name: 'NsEndpoints',
        component: () => import('@/views/NsEndpoints.vue'),
        meta: { titleKey: 'route.endpoints', icon: 'hub', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/ingress',
        name: 'NsIngress',
        component: () => import('@/views/NsIngress.vue'),
        meta: { titleKey: 'route.ingress', icon: 'language', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/ingress/:name',
        name: 'NsIngressDetail',
        component: () => import('@/views/NsIngressDetail.vue'),
        meta: { titleKey: 'route.ingressDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/storage',
        name: 'NsStorage',
        component: () => import('@/views/NsStorage.vue'),
        meta: { titleKey: 'route.storage', icon: 'storage', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/storage/pvc/:name',
        name: 'NsPVCDetail',
        component: () => import('@/views/NsPVCDetail.vue'),
        meta: { titleKey: 'route.pvcDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/configmaps',
        name: 'NsConfigMaps',
        component: () => import('@/views/NsConfigMaps.vue'),
        meta: { titleKey: 'route.configMaps', icon: 'description', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/configmaps/:name',
        name: 'NsConfigMapDetail',
        component: () => import('@/views/NsConfigMapDetail.vue'),
        meta: { titleKey: 'route.configMapDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/secrets',
        name: 'NsSecrets',
        component: () => import('@/views/NsSecrets.vue'),
        meta: { titleKey: 'route.secrets', icon: 'key', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/secrets/:name',
        name: 'NsSecretDetail',
        component: () => import('@/views/NsSecretDetail.vue'),
        meta: { titleKey: 'route.secretDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/rbac',
        name: 'NsRBAC',
        component: () => import('@/views/NsRBAC.vue'),
        meta: { titleKey: 'route.rbac', icon: 'admin_panel_settings', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/rbac/roles/:name',
        name: 'NsRoleDetail',
        component: () => import('@/views/NsRoleDetail.vue'),
        meta: { titleKey: 'route.roleDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/rbac/serviceaccounts/:name',
        name: 'NsServiceAccountDetail',
        component: () => import('@/views/NsServiceAccountDetail.vue'),
        meta: { titleKey: 'route.serviceAccountDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/rbac/rolebindings/:name',
        name: 'NsRoleBindingDetail',
        component: () => import('@/views/NsRoleBindingDetail.vue'),
        meta: { titleKey: 'route.roleBindingDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/networkpolicies',
        name: 'NsNetworkPolicies',
        component: () => import('@/views/NsNetworkPolicies.vue'),
        meta: { titleKey: 'route.networkPolicies', icon: 'shield', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/networkpolicies/:name',
        name: 'NsNetworkPolicyDetail',
        component: () => import('@/views/NsNetworkPolicyDetail.vue'),
        meta: { titleKey: 'route.networkPolicyDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/hpa',
        name: 'NsHPA',
        component: () => import('@/views/NsHPA.vue'),
        meta: { titleKey: 'route.hpa', icon: 'timeline', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/hpa/:name',
        name: 'NsHPADetail',
        component: () => import('@/views/NsHPADetail.vue'),
        meta: { titleKey: 'route.hpaDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/resourcequotas',
        name: 'NsResourceQuotas',
        component: () => import('@/views/NsResourceQuotas.vue'),
        meta: { titleKey: 'route.resourceQuotas', icon: 'pie_chart', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/resourcequotas/:name',
        name: 'NsResourceQuotaDetail',
        component: () => import('@/views/NsResourceQuotaDetail.vue'),
        meta: { titleKey: 'route.resourceQuotaDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/limitranges',
        name: 'NsLimitRanges',
        component: () => import('@/views/NsLimitRanges.vue'),
        meta: { titleKey: 'route.limitRanges', icon: 'tune', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/limitranges/:name',
        name: 'NsLimitRangeDetail',
        component: () => import('@/views/NsLimitRangeDetail.vue'),
        meta: { titleKey: 'route.limitRangeDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/pdbs',
        name: 'NsPDBs',
        component: () => import('@/views/NsPDBs.vue'),
        meta: { titleKey: 'route.pdbs', icon: 'shield', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/pdbs/:name',
        name: 'NsPDBDetail',
        component: () => import('@/views/NsPDBDetail.vue'),
        meta: { titleKey: 'route.pdbDetail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/deploy',
        name: 'NsDeploy',
        component: () => import('@/views/DeployApp.vue'),
        meta: { titleKey: 'nav.deploy', icon: 'rocket_launch', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/events',
        name: 'NsEvents',
        component: () => import('@/views/NsEvents.vue'),
        meta: { titleKey: 'nav.events', icon: 'notifications_active', scope: 'namespace' }
      },
      {
        path: 'workbench',
        name: 'Workbench',
        component: () => import('@/views/WorkbenchShell.vue'),
        // fullHeight:AppLayout main 切 overflow-hidden + 包裹层 h-full——工作台是
        // 应用式布局(内部自管滚动),不是文档式页面;否则 h-full 链断、输入框悬空下方留白
        meta: { titleKey: 'nav.workbench', icon: 'workspaces', scope: 'global', fullHeight: true, requiresCluster: false }
      },
      {
        path: 'workbench/ledger',
        name: 'WorkbenchLedger',
        component: () => import('@/views/WorkbenchLedger.vue'),
        meta: { titleKey: 'route.clusterLedger', scope: 'global', requiresCluster: false }
      },
      {
        path: 'workbench/:id',
        name: 'WorkbenchProject',
        component: () => import('@/views/WorkbenchDetail.vue'),
        meta: { titleKey: 'route.project', scope: 'global', fullHeight: true, requiresCluster: false }
      },
      {
        path: 'workbench/:id/chat',
        redirect: to => '/workbench/' + to.params.id
      },
      // === 个人中心（所有登录用户；平台层页面，不依赖集群）===
      {
        path: 'profile',
        name: 'UserProfile',
        component: () => import('@/views/UserProfile.vue'),
        meta: { titleKey: 'route.profile', icon: 'person', scope: 'global', requiresCluster: false }
      },
      // === 平台管理（admin only）===
      {
        path: 'admin/users',
        name: 'AdminUsers',
        component: () => import('@/views/admin/UserManagement.vue'),
        meta: { titleKey: 'nav.userManagement', icon: 'group', scope: 'global', requireAdmin: true, requiresCluster: false }
      },
      {
        path: 'admin/clusters',
        name: 'AdminClusters',
        component: () => import('@/views/admin/ClusterManagement.vue'),
        meta: { titleKey: 'nav.clusterManagement', icon: 'cloud', scope: 'global', requireAdmin: true, requiresCluster: false }
      },
      {
        path: 'admin/apikeys',
        name: 'AdminApiKeys',
        component: () => import('@/views/admin/ApiKeyManagement.vue'),
        meta: { titleKey: 'nav.apiKeys', icon: 'vpn_key', scope: 'global', requireAdmin: true, requiresCluster: false }
      },
      {
        path: 'admin/llm-config',
        name: 'AdminLlmConfig',
        component: () => import('@/views/admin/LlmConfig.vue'),
        meta: { titleKey: 'nav.llmConfig', icon: 'neurology', scope: 'global', requireAdmin: true, requiresCluster: false }
      },
      {
        path: 'admin/ai-behavior',
        name: 'AdminAiBehavior',
        component: () => import('@/views/admin/AiBehaviorConfig.vue'),
        meta: { titleKey: 'nav.aiBehavior', icon: 'tune', scope: 'global', requireAdmin: true, requiresCluster: false }
      },
      {
        path: 'admin/audit-trail',
        name: 'AdminAuditTrail',
        component: () => import('@/views/admin/AuditTrail.vue'),
        meta: { titleKey: 'nav.auditTrail', icon: 'shield', scope: 'global', requireAdmin: true, requiresCluster: false }
      },
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(async (to) => {
  const store = useClusterStore()
  const authStore = useAuthStore()
  authStore.init()
  if (['TerminalPopup', 'LogPopup'].includes(to.name)) return

  const isPublic = to.name === 'Login' || to.name === 'SelectCluster'

  // Layer 1: 无平台 token → 跳登录
  if (!getPlatformToken()) {
    if (!isPublic) return { name: 'Login' }
    return
  }
  if (!authStore.user) {
    const user = await authStore.fetchMe()
    if (!user) return { name: 'Login' }
  }
  if (to.name === 'Login') return { name: 'SelectCluster' }

  // Layer 2: 无 K8s session → 尝试自动连接上次集群；失败才跳选择页
  if (!getSession()) {
    const auto = await authStore.tryAutoConnect()
    if (!auto) {
      // 无 session 且连不上集群:平台管理类页面(meta.requiresCluster===false,不依赖集群)
      // 放行,其余非 public 页面弹回选择页。放行时直接 return,跳过下方 api.session() 验证。
      const redirect = resolveWhenSessionMissing(to, isPublic)
      if (redirect) return redirect
      return
    }
    // 自动连接成功 → 设集群状态（setConnectedCluster 内部已置连接态），继续进入页面
    store.setConnectedCluster({ apiServer: auto.cluster.apiServer.replace(/\/$/, ''), version: auto.cluster.version })
  }
  // 已有 K8s session 但未水合 → 仅验证 session 有效，不做全量水合（各页面按需加载）
  if (!store.currentCluster) {
    try {
      const result = await api.session()
      store.setConnectedCluster(result.cluster)
      // 不在这里调 hydrateCoreResources——改为各页面 onMounted 按需加载（避免首次进入拉全集群资源）
    } catch {
      clearSession()
      return { name: 'SelectCluster' }
    }
  }
  const namespaceParam = to.params.namespace
  const namespace = Array.isArray(namespaceParam) ? namespaceParam[0] : namespaceParam

  if (namespace) {
    if (store.currentNamespace !== namespace) {
      store.setNamespace(namespace)
    }
  }
})

// 统一消费 meta.titleKey → document.title。无 titleKey 的路由（redirect 等）落品牌标题。
// 切语言时由 App.vue watch locale 调 applyRouteTitle(currentMeta) 重刷。
export function applyRouteTitle(meta) {
  const key = meta?.titleKey
  document.title = key ? `${i18n.global.t(key)} · AliangBoard` : i18n.global.t('route.brandTitle')
}
router.afterEach((to) => applyRouteTitle(to.meta))

export default router
