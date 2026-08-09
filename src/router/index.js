import { createRouter, createWebHistory } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import { useClusterStore } from '@/stores/cluster'
import { useAuthStore } from '@/stores/auth'
import { api, clearSession, getSession, getPlatformToken } from '@/api/client'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { title: 'Login' }
  },
  {
    path: '/select-cluster',
    name: 'SelectCluster',
    component: () => import('@/views/SelectCluster.vue'),
    meta: { titleKey: 'selectCluster.title' }
  },
  {
    // 独立终端弹窗（新标签页打开），不走 AppLayout（无侧栏/顶栏，纯全屏终端）
    path: '/terminal-popup',
    name: 'TerminalPopup',
    component: () => import('@/views/TerminalPopup.vue'),
    meta: { title: 'Terminal' }
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
        meta: { title: 'Cluster Overview', icon: 'dashboard', scope: 'global' }
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
        meta: { title: 'Nodes', icon: 'dns', scope: 'global' }
      },
      {
        path: 'nodes/:name',
        name: 'NodeDetail',
        component: () => import('@/views/NodeDetail.vue'),
        meta: { title: 'Node Detail', scope: 'global' }
      },
      {
        path: 'workloads',
        name: 'Workloads',
        component: () => import('@/views/Workloads.vue'),
        meta: { title: 'Workloads', icon: 'apps', scope: 'global' }
      },
      {
        path: 'workloads/:type/:name',
        name: 'WorkloadDetail',
        component: () => import('@/views/WorkloadDetail.vue'),
        meta: { title: 'Workload Detail', scope: 'global' }
      },
      {
        path: 'pods/:namespace/:name',
        name: 'PodDetail',
        component: () => import('@/views/PodDetail.vue'),
        meta: { title: 'Pod Detail', scope: 'global' }
      },
      {
        path: 'network',
        name: 'Network',
        component: () => import('@/views/Network.vue'),
        meta: { title: 'Network', icon: 'share', scope: 'global' }
      },
      {
        path: 'storage',
        name: 'Storage',
        component: () => import('@/views/Storage.vue'),
        meta: { title: 'Storage', icon: 'storage', scope: 'global' }
      },
      {
        path: 'configuration',
        name: 'Configuration',
        component: () => import('@/views/Configuration.vue'),
        meta: { title: 'Configuration', icon: 'description', scope: 'global' }
      },
      {
        path: 'rbac',
        name: 'RBAC',
        component: () => import('@/views/RBAC.vue'),
        meta: { title: 'RBAC', icon: 'admin_panel_settings', scope: 'global' }
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
        meta: { title: 'Deploy', icon: 'rocket_launch', scope: 'global' }
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/Settings.vue'),
        meta: { title: 'Settings', icon: 'tune', scope: 'global' }
      },
      {
        path: 'clusters',
        name: 'Clusters',
        component: () => import('@/views/Clusters.vue'),
        meta: { title: 'Clusters', icon: 'hub', scope: 'global' }
      },
      {
        path: 'crds',
        name: 'CrdList',
        component: () => import('@/views/CrdList.vue'),
        meta: { title: 'Custom Resource Definitions', icon: 'extension', scope: 'global' }
      },
      {
        path: 'crds/:name',
        name: 'CrdDetail',
        component: () => import('@/views/CrdDetail.vue'),
        meta: { title: 'CRD Detail', scope: 'global' }
      },
      {
        path: 'audit-logs',
        name: 'AuditLogs',
        component: () => import('@/views/AuditLogs.vue'),
        meta: { title: 'Audit Logs', icon: 'history', scope: 'global' }
      },
      {
        path: 'priorityclasses',
        name: 'PriorityClasses',
        component: () => import('@/views/PriorityClasses.vue'),
        meta: { title: 'PriorityClasses', icon: 'flag', scope: 'global' }
      },
      {
        path: 'ingressclasses',
        name: 'IngressClasses',
        component: () => import('@/views/IngressClasses.vue'),
        meta: { title: 'IngressClasses', icon: 'language', scope: 'global' }
      },
      {
        path: 'runtimeclasses',
        name: 'RuntimeClasses',
        component: () => import('@/views/RuntimeClasses.vue'),
        meta: { title: 'RuntimeClasses', icon: 'memory', scope: 'global' }
      },
      {
        path: 'admin/apiservices',
        name: 'APIServices',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { title: 'APIServices', icon: 'api', scope: 'global', resource: 'apiservices' }
      },
      {
        path: 'admin/webhooks-mutating',
        name: 'MutatingWebhooks',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { title: 'Mutating Webhooks', icon: 'webhook', scope: 'global', resource: 'mutatingwebhooks' }
      },
      {
        path: 'admin/webhooks-validating',
        name: 'ValidatingWebhooks',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { title: 'Validating Webhooks', icon: 'rule', scope: 'global', resource: 'validatingwebhooks' }
      },
      {
        path: 'admin/replicasets',
        name: 'ReplicaSets',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { title: 'ReplicaSets', icon: 'dynamic_feed', scope: 'global', resource: 'replicasets' }
      },
      {
        path: 'admin/csinodes',
        name: 'CSINodes',
        component: () => import('@/views/ClusterResourceList.vue'),
        meta: { title: 'CSINodes', icon: 'hard_drive', scope: 'global', resource: 'csinodes' }
      },
      {
        path: 'priorityclasses/:name',
        name: 'PriorityClassDetail',
        component: () => import('@/views/PriorityClassDetail.vue'),
        meta: { title: 'PriorityClass Detail', scope: 'global' }
      },
      {
        path: 'pv/:name',
        name: 'PVDetail',
        component: () => import('@/views/PVDetail.vue'),
        meta: { title: 'PersistentVolume Detail', scope: 'global' }
      },
      {
        path: 'storageclass/:name',
        name: 'StorageClassDetail',
        component: () => import('@/views/StorageClassDetail.vue'),
        meta: { title: 'StorageClass Detail', scope: 'global' }
      },
      {
        path: 'clusterrole/:name',
        name: 'ClusterRoleDetail',
        component: () => import('@/views/ClusterRoleDetail.vue'),
        meta: { title: 'ClusterRole Detail', scope: 'global' }
      },
      {
        path: 'clusterrolebinding/:name',
        name: 'ClusterRoleBindingDetail',
        component: () => import('@/views/ClusterRoleBindingDetail.vue'),
        meta: { title: 'ClusterRoleBinding Detail', scope: 'global' }
      },
      {
        path: 'namespaces',
        name: 'Namespaces',
        component: () => import('@/views/Namespaces.vue'),
        meta: { title: 'Namespaces', icon: 'folder_open', scope: 'global' }
      },
      {
        path: 'namespaces/:name',
        name: 'NamespaceDetail',
        component: () => import('@/views/NamespaceDetail.vue'),
        meta: { title: 'Namespace Detail', scope: 'global' }
      },

      // === Namespace 作用域页面 ===
      {
        path: 'ns/:namespace',
        name: 'NamespaceOverview',
        component: () => import('@/views/NamespaceOverview.vue'),
        meta: { title: 'Namespace Overview', icon: 'dashboard', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/workloads',
        name: 'NsWorkloads',
        component: () => import('@/views/NsWorkloads.vue'),
        meta: { title: 'Workloads', icon: 'apps', scope: 'namespace' }
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
        meta: { title: 'Workload Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/pods',
        name: 'NsPods',
        component: () => import('@/views/NsPods.vue'),
        meta: { title: 'Pods', icon: 'layers', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/pods/:name',
        name: 'NsPodDetail',
        component: () => import('@/views/PodDetail.vue'),
        meta: { title: 'Pod Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/services',
        name: 'NsServices',
        component: () => import('@/views/NsServices.vue'),
        meta: { title: 'Services', icon: 'hub', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/services/:name',
        name: 'NsServiceDetail',
        component: () => import('@/views/NsServiceDetail.vue'),
        meta: { title: 'Service Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/endpoints',
        name: 'NsEndpoints',
        component: () => import('@/views/NsEndpoints.vue'),
        meta: { title: 'Endpoints', icon: 'hub', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/ingress',
        name: 'NsIngress',
        component: () => import('@/views/NsIngress.vue'),
        meta: { title: 'Ingress', icon: 'language', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/ingress/:name',
        name: 'NsIngressDetail',
        component: () => import('@/views/NsIngressDetail.vue'),
        meta: { title: 'Ingress Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/storage',
        name: 'NsStorage',
        component: () => import('@/views/NsStorage.vue'),
        meta: { title: 'Storage', icon: 'storage', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/storage/pvc/:name',
        name: 'NsPVCDetail',
        component: () => import('@/views/NsPVCDetail.vue'),
        meta: { title: 'PVC Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/configmaps',
        name: 'NsConfigMaps',
        component: () => import('@/views/NsConfigMaps.vue'),
        meta: { title: 'ConfigMaps', icon: 'description', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/configmaps/:name',
        name: 'NsConfigMapDetail',
        component: () => import('@/views/NsConfigMapDetail.vue'),
        meta: { title: 'ConfigMap Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/secrets',
        name: 'NsSecrets',
        component: () => import('@/views/NsSecrets.vue'),
        meta: { title: 'Secrets', icon: 'key', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/secrets/:name',
        name: 'NsSecretDetail',
        component: () => import('@/views/NsSecretDetail.vue'),
        meta: { title: 'Secret Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/rbac',
        name: 'NsRBAC',
        component: () => import('@/views/NsRBAC.vue'),
        meta: { title: 'RBAC', icon: 'admin_panel_settings', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/rbac/roles/:name',
        name: 'NsRoleDetail',
        component: () => import('@/views/NsRoleDetail.vue'),
        meta: { title: 'Role Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/rbac/serviceaccounts/:name',
        name: 'NsServiceAccountDetail',
        component: () => import('@/views/NsServiceAccountDetail.vue'),
        meta: { title: 'ServiceAccount Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/rbac/rolebindings/:name',
        name: 'NsRoleBindingDetail',
        component: () => import('@/views/NsRoleBindingDetail.vue'),
        meta: { title: 'RoleBinding Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/networkpolicies',
        name: 'NsNetworkPolicies',
        component: () => import('@/views/NsNetworkPolicies.vue'),
        meta: { title: 'NetworkPolicies', icon: 'shield', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/networkpolicies/:name',
        name: 'NsNetworkPolicyDetail',
        component: () => import('@/views/NsNetworkPolicyDetail.vue'),
        meta: { title: 'NetworkPolicy Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/hpa',
        name: 'NsHPA',
        component: () => import('@/views/NsHPA.vue'),
        meta: { title: 'HPA', icon: 'timeline', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/hpa/:name',
        name: 'NsHPADetail',
        component: () => import('@/views/NsHPADetail.vue'),
        meta: { title: 'HPA Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/resourcequotas',
        name: 'NsResourceQuotas',
        component: () => import('@/views/NsResourceQuotas.vue'),
        meta: { title: 'ResourceQuotas', icon: 'pie_chart', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/resourcequotas/:name',
        name: 'NsResourceQuotaDetail',
        component: () => import('@/views/NsResourceQuotaDetail.vue'),
        meta: { title: 'ResourceQuota Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/limitranges',
        name: 'NsLimitRanges',
        component: () => import('@/views/NsLimitRanges.vue'),
        meta: { title: 'LimitRanges', icon: 'tune', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/limitranges/:name',
        name: 'NsLimitRangeDetail',
        component: () => import('@/views/NsLimitRangeDetail.vue'),
        meta: { title: 'LimitRange Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/pdbs',
        name: 'NsPDBs',
        component: () => import('@/views/NsPDBs.vue'),
        meta: { title: 'PodDisruptionBudgets', icon: 'shield', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/pdbs/:name',
        name: 'NsPDBDetail',
        component: () => import('@/views/NsPDBDetail.vue'),
        meta: { title: 'PDB Detail', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/deploy',
        name: 'NsDeploy',
        component: () => import('@/views/DeployApp.vue'),
        meta: { title: 'Deploy', icon: 'rocket_launch', scope: 'namespace' }
      },
      {
        path: 'ns/:namespace/events',
        name: 'NsEvents',
        component: () => import('@/views/NsEvents.vue'),
        meta: { title: 'Events', icon: 'notifications_active', scope: 'namespace' }
      },
      {
        path: 'workbench',
        name: 'Workbench',
        component: () => import('@/views/WorkbenchShell.vue'),
        meta: { titleKey: 'nav.workbench', icon: 'workspaces', scope: 'global' }
      },
      {
        path: 'workbench/ledger',
        name: 'WorkbenchLedger',
        component: () => import('@/views/WorkbenchLedger.vue'),
        meta: { titleKey: 'route.clusterLedger', scope: 'global' }
      },
      {
        path: 'workbench/:id',
        name: 'WorkbenchProject',
        component: () => import('@/views/WorkbenchDetail.vue'),
        meta: { titleKey: 'route.project', scope: 'global' }
      },
      {
        path: 'workbench/:id/chat',
        redirect: to => '/workbench/' + to.params.id
      },
      // === 平台管理（admin only）===
      {
        path: 'admin/users',
        name: 'AdminUsers',
        component: () => import('@/views/admin/UserManagement.vue'),
        meta: { titleKey: 'nav.userManagement', icon: 'group', scope: 'global', requireAdmin: true }
      },
      {
        path: 'admin/clusters',
        name: 'AdminClusters',
        component: () => import('@/views/admin/ClusterManagement.vue'),
        meta: { titleKey: 'nav.clusterManagement', icon: 'cloud', scope: 'global', requireAdmin: true }
      },
      {
        path: 'admin/apikeys',
        name: 'AdminApiKeys',
        component: () => import('@/views/admin/ApiKeyManagement.vue'),
        meta: { titleKey: 'nav.apiKeys', icon: 'vpn_key', scope: 'global', requireAdmin: true }
      },
      {
        path: 'admin/agent',
        name: 'AdminAgentConsole',
        component: () => import('@/views/admin/AgentConsole.vue'),
        meta: { titleKey: 'nav.aiConsole', icon: 'smart_toy', scope: 'global', requireAdmin: true }
      },
      {
        path: 'admin/llm-config',
        name: 'AdminLlmConfig',
        component: () => import('@/views/admin/LlmConfig.vue'),
        meta: { titleKey: 'nav.llmConfig', icon: 'neurology', scope: 'global', requireAdmin: true }
      },
      {
        path: 'admin/audit-trail',
        name: 'AdminAuditTrail',
        component: () => import('@/views/admin/AuditTrail.vue'),
        meta: { titleKey: 'nav.auditTrail', icon: 'shield', scope: 'global', requireAdmin: true }
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
  if (to.name === 'TerminalPopup') return

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
      if (!isPublic) return { name: 'SelectCluster' }
      return
    }
    // 自动连接成功 → 设集群状态，继续进入页面
    store.setConnectedCluster({ apiServer: auto.cluster.apiServer.replace(/\/$/, ''), version: auto.cluster.version })
    store.remoteMode = true
  }
  // 已有 K8s session 但未水合 → 仅验证 session 有效，不做全量水合（各页面按需加载）
  if (!store.remoteMode) {
    try {
      const result = await api.session()
      store.setConnectedCluster(result.cluster)
      // 不在这里调 hydrateCoreResources——改为各页面 onMounted 按需加载（避免首次进入拉全集群资源）
      store.remoteMode = true
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

export default router
