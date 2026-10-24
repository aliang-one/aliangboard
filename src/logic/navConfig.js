// 导航单一事实源(2026-10-23 顶栏退役·导航单源收敛,spec §3:
// docs/superpowers/specs/2026-10-23-topbar-retirement-nav-consolidation-design.md)。
// 侧栏全部导航声明为数据,SideNavBar 只渲染;globalSearch.PAGE_ENTRIES 由此派生。
// 纯数据模块:禁止 import Vue/store/i18n——labelKey 由消费方渲染期经 $t/t 解析。
export const CLUSTER_PRIMARY_NAV = [
  { icon: 'dashboard', labelKey: 'nav.clusterOverview', route: '/cluster' },
  { icon: 'dns', labelKey: 'nav.nodes', route: '/nodes' },
  { icon: 'folder_open', labelKey: 'nav.namespaces', route: '/namespaces' },
  { icon: 'storage', labelKey: 'nav.storage', route: '/storage' },
  { icon: 'monitoring', labelKey: 'nav.monitoring', route: '/monitoring' },
]
// 跨命名空间视图(2026-10-23 补入口:此前仅全局搜索可达,spec §6)
export const CLUSTER_CROSS_NS_NAV = [
  { icon: 'work', labelKey: 'nav.workloads', route: '/workloads' },
  { icon: 'share', labelKey: 'nav.network', route: '/network' },
  { icon: 'tune', labelKey: 'route.configuration', route: '/configuration' },
  { icon: 'security', labelKey: 'route.rbac', route: '/rbac' },
]
// 与 SideNavBar 现 clusterResourcesNav 逐字一致(仅 route 键名沿用)
export const CLUSTER_RESOURCES_NAV = [
  { icon: 'extension', labelKey: 'nav.crds', route: '/crds' },
  { icon: 'flag', label: 'PriorityClasses', route: '/priorityclasses' },
  { icon: 'language', label: 'IngressClasses', route: '/ingressclasses' },
  { icon: 'memory', label: 'RuntimeClasses', route: '/runtimeclasses' },
  { icon: 'api', label: 'APIServices', route: '/admin/apiservices' },
  { icon: 'webhook', label: 'Mutating Webhooks', route: '/admin/webhooks-mutating' },
  { icon: 'rule', label: 'Validating Webhooks', route: '/admin/webhooks-validating' },
  { icon: 'dynamic_feed', label: 'ReplicaSets', route: '/admin/replicasets' },
  { icon: 'hard_drive', label: 'CSINodes', route: '/admin/csinodes' },
  { icon: 'verified', labelKey: 'nav.certs', route: '/cluster/certs' },
]
export const CLUSTER_OTHER_NAV = [
  { icon: 'hub', labelKey: 'nav.clusters', route: '/clusters' },
]
export const PLATFORM_ADMIN_NAV = [
  { icon: 'group', labelKey: 'nav.userManagement', route: '/admin/users' },
  { icon: 'admin_panel_settings', labelKey: 'nav.groupsGrants', route: '/admin/groups' },
  { icon: 'cloud', labelKey: 'nav.clusterManagement', route: '/admin/clusters' },
  { icon: 'vpn_key', labelKey: 'nav.apiKeys', route: '/admin/apikeys' },
  { icon: 'tune', labelKey: 'nav.aiBehavior', route: '/admin/ai-behavior' },
  { icon: 'neurology', labelKey: 'nav.llmConfig', route: '/admin/llm-config' },
  { icon: 'shield', labelKey: 'nav.auditTrail', route: '/admin/audit-trail' },
]
// Namespace 作用域导航——与 SideNavBar 现 nsNavGroups 逐字一致(五组:工作负载/网络/
// 存储配置/安全/策略,items 形状 {icon,labelKey?,label?,routeKey})
export const NS_NAV_GROUPS = [
  {
    labelKey: 'nav.workloads',
    icon: 'work',
    items: [
      { icon: 'apps', labelKey: 'nav.workloadsList', routeKey: 'workloads' },
      { icon: 'view_in_ar', label: 'Pods', routeKey: 'pods' },
      { icon: 'timeline', label: 'HPA', routeKey: 'hpa' },
    ]
  },
  {
    labelKey: 'nav.network',
    icon: 'share',
    items: [
      { icon: 'hub', label: 'Services', routeKey: 'services' },
      { icon: 'language', label: 'Ingress', routeKey: 'ingress' },
      { icon: 'shield', label: 'NetworkPolicy', routeKey: 'networkpolicies' },
    ]
  },
  {
    labelKey: 'nav.storageConfig',
    icon: 'folder_shared',
    items: [
      { icon: 'storage', label: 'Storage (PVC)', routeKey: 'storage' },
      { icon: 'description', label: 'ConfigMaps', routeKey: 'configmaps' },
      { icon: 'key', label: 'Secrets', routeKey: 'secrets' },
    ]
  },
  {
    labelKey: 'nav.security',
    icon: 'security',
    items: [
      { icon: 'admin_panel_settings', label: 'RBAC', routeKey: 'rbac' },
    ]
  },
  {
    labelKey: 'nav.policy',
    icon: 'policy',
    items: [
      { icon: 'pie_chart', label: 'ResourceQuota', routeKey: 'resourcequotas' },
      { icon: 'tune', label: 'LimitRange', routeKey: 'limitranges' },
      { icon: 'shield', label: 'PDB', routeKey: 'pdbs' },
    ]
  },
]
// routeKey → vue-router 命名路由,与 SideNavBar 现 nsRouteMap 逐字一致(16 个映射)
export const NS_ROUTE_MAP = {
  overview: 'NamespaceOverview',
  events: 'NsEvents',
  layers: 'NsLayers',
  workloads: 'NsWorkloads',
  pods: 'NsPods',
  hpa: 'NsHPA',
  services: 'NsServices',
  ingress: 'NsIngress',
  networkpolicies: 'NsNetworkPolicies',
  storage: 'NsStorage',
  configmaps: 'NsConfigMaps',
  secrets: 'NsSecrets',
  rbac: 'NsRBAC',
  resourcequotas: 'NsResourceQuotas',
  limitranges: 'NsLimitRanges',
  pdbs: 'NsPDBs',
}
// 工作台模块入口(W 轨,免集群;spec §4.3)
export const WORKBENCH_NAV = { icon: 'workspaces', labelKey: 'nav.workbench', route: '/workbench' }
