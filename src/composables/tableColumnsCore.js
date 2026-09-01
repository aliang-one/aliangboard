// 表格自定义列 —— 纯逻辑核心(无 vue / 无 vue-i18n,可被 node 零依赖运行器单测)。
// TABLE_CATALOG 是各 DataTable 视图列定义的「单一事实源」;labelKey 指向 i18n 键,
// label 为英文兜底。useTableColumns.js 在此之上加响应式 + i18n + localStorage。

export const STORAGE_KEY_V1 = 'aliangboard.tableColumns.v1'
export const STORAGE_KEY = 'aliangboard.tableColumns.v2'

export const TABLE_CATALOG = [
  {
    key: 'nodes', labelKey: 'cols.nodes._t', label: 'Nodes', icon: 'dns',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'status', labelKey: 'cols._c.status', label: 'Status' },
      { key: 'roles', labelKey: 'cols.nodes.roles', label: 'Role' },
      { key: 'system', labelKey: 'cols.nodes.system', label: 'System' },
      { key: 'cpu', labelKey: 'cols.nodes.cpu', label: 'CPU' },
      { key: 'memory', labelKey: 'cols.nodes.memory', label: 'Memory' },
      { key: 'pods', labelKey: 'cols._c.pods', label: 'Pods' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'workloads', labelKey: 'cols.workloads._t', label: 'Workloads', icon: 'workspaces',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'type', labelKey: 'cols._c.type', label: 'Type' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'status', labelKey: 'cols._c.status', label: 'Status' },
      { key: 'replicas', labelKey: 'cols.workloads.replicas', label: 'Replicas' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'namespaces', labelKey: 'cols.namespaces._t', label: 'Namespaces', icon: 'folder',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'status', labelKey: 'cols._c.status', label: 'Status' },
      { key: 'pods', labelKey: 'cols._c.pods', label: 'Pods' },
      { key: 'services', labelKey: 'cols._c.services', label: 'Services' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'services', labelKey: 'cols.services._t', label: 'Services', icon: 'share',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'type', labelKey: 'cols._c.type', label: 'Type' },
      { key: 'clusterIP', labelKey: 'cols.services.clusterIP', label: 'Cluster IP' },
      { key: 'externalIP', labelKey: 'cols.services.externalIP', label: 'External IP' },
      { key: 'ports', labelKey: 'cols.services.ports', label: 'Ports' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
    ],
  },
  {
    key: 'ingress', labelKey: 'cols.ingress._t', label: 'Ingress', icon: 'router',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'hosts', labelKey: 'cols.ingress.hosts', label: 'Hosts' },
      { key: 'path', labelKey: 'cols.ingress.path', label: 'Path' },
      { key: 'backend', labelKey: 'cols.ingress.backend', label: 'Backend' },
      { key: 'tls', labelKey: 'cols.ingress.tls', label: 'TLS' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
    ],
  },
  {
    key: 'nsWorkloads', labelKey: 'ns.workloads.title', label: 'Workloads', icon: 'workspaces',
    columns: [
      { key: 'name', labelKey: 'ns.workloads.thName', label: 'Name' },
      { key: 'type', labelKey: 'ns.workloads.thType', label: 'Type' },
      { key: 'status', labelKey: 'ns.workloads.thStatus', label: 'Status' },
      { key: 'replicas', labelKey: 'ns.workloads.thReplicas', label: 'Replicas' },
      { key: 'image', labelKey: 'ns.workloads.thImage', label: 'Image' },
      { key: 'age', labelKey: 'ns.workloads.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsConfigMaps', labelKey: 'ns.configmaps.title', label: 'ConfigMaps', icon: 'description',
    columns: [
      { key: 'name', labelKey: 'ns.configmaps.thName', label: 'Name' },
      { key: 'keys', labelKey: 'ns.configmaps.thKeys', label: 'Data Keys' },
      { key: 'preview', labelKey: 'ns.configmaps.thPreview', label: 'Preview' },
      { key: 'age', labelKey: 'common.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsSecrets', labelKey: 'ns.secrets.title', label: 'Secrets', icon: 'key',
    columns: [
      { key: 'name', labelKey: 'ns.secrets.thName', label: 'Name' },
      { key: 'type', labelKey: 'ns.secrets.thType', label: 'Type' },
      { key: 'keys', labelKey: 'ns.secrets.thKeys', label: 'Keys' },
      { key: 'preview', labelKey: 'ns.secrets.thPreview', label: 'Data Preview' },
      { key: 'age', labelKey: 'common.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsEvents', labelKey: 'ns.events.title', label: 'Events', icon: 'event_available',
    columns: [
      { key: 'type', labelKey: 'ns.events.thType', label: 'Type' },
      { key: 'reason', labelKey: 'ns.events.thReason', label: 'Reason' },
      { key: 'message', labelKey: 'ns.events.thMessage', label: 'Message' },
      { key: 'time', labelKey: 'ns.events.thTime', label: 'Time' },
    ],
  },
  {
    key: 'nsServices', labelKey: 'ns.services.title', label: 'Services', icon: 'share',
    columns: [
      { key: 'name', labelKey: 'ns.services.thName', label: 'Name' },
      { key: 'type', labelKey: 'ns.services.thType', label: 'Type' },
      { key: 'clusterIP', labelKey: 'ns.services.thClusterIp', label: 'Cluster IP' },
      { key: 'externalIP', labelKey: 'ns.services.thExternalIp', label: 'External IP' },
      { key: 'ports', labelKey: 'ns.services.thPorts', label: 'Ports' },
      { key: 'selector', labelKey: 'ns.services.thSelector', label: 'Selector' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsIngress', labelKey: 'ns.ingress.title', label: 'Ingress', icon: 'language',
    columns: [
      { key: 'name', labelKey: 'ns.ingress.thName', label: 'Name' },
      { key: 'className', labelKey: 'ns.ingress.thClass', label: 'Class' },
      { key: 'rules', labelKey: 'ns.ingress.thRules', label: 'Routing Rules' },
      { key: 'tls', labelKey: 'ns.ingress.thTls', label: 'TLS' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsNetworkPolicies', labelKey: 'ns.networkPolicies.title', label: 'NetworkPolicies', icon: 'shield',
    columns: [
      { key: 'name', labelKey: 'ns.networkPolicies.thName', label: 'Name' },
      { key: 'podSelector', labelKey: 'ns.networkPolicies.thPodSelector', label: 'Pod Selector' },
      { key: 'policyTypes', labelKey: 'ns.networkPolicies.thPolicyTypes', label: 'Policy Types' },
      { key: 'ingressRules', labelKey: 'ns.networkPolicies.thIngressRules', label: 'Ingress Rules' },
      { key: 'egressRules', labelKey: 'ns.networkPolicies.thEgressRules', label: 'Egress Rules' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsPDBs', labelKey: 'ns.pdb.title', label: 'PodDisruptionBudgets', icon: 'shield',
    columns: [
      { key: 'name', labelKey: 'ns.pdb.thName', label: 'Name' },
      { key: 'selector', labelKey: 'ns.pdb.thSelector', label: 'Selector' },
      { key: 'budget', labelKey: 'ns.pdb.thBudget', label: 'Budget' },
      { key: 'allowedDisruptions', labelKey: 'ns.pdb.thAllowedDisruptions', label: 'Allowed Disruptions' },
      { key: 'healthy', labelKey: 'ns.pdb.thHealthy', label: 'Healthy' },
      { key: 'age', labelKey: 'ns.pdb.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsHPA', labelKey: 'ns.hpa.title', label: 'HorizontalPodAutoscalers', icon: 'speed',
    columns: [
      { key: 'name', labelKey: 'ns.hpa.thName', label: 'Name' },
      { key: 'target', labelKey: 'ns.hpa.thTarget', label: 'Target' },
      { key: 'minMaxReplicas', labelKey: 'ns.hpa.thMinMaxReplicas', label: 'Min/Max Replicas' },
      { key: 'currentReplicas', labelKey: 'ns.hpa.thCurrentReplicas', label: 'Current Replicas' },
      { key: 'cpuTarget', labelKey: 'ns.hpa.thCpuTarget', label: 'CPU Target' },
      { key: 'cpuCurrent', labelKey: 'ns.hpa.thCpuCurrent', label: 'CPU Current' },
      { key: 'status', labelKey: 'ns.hpa.thStatus', label: 'Status' },
      { key: 'age', labelKey: 'ns.hpa.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsLimitRanges', labelKey: 'ns.limitRanges.title', label: 'LimitRanges', icon: 'tune',
    columns: [
      { key: 'name', labelKey: 'ns.limitRanges.thName', label: 'Name' },
      { key: 'defaultCPU', labelKey: 'ns.limitRanges.thDefaultCpu', label: 'Default CPU' },
      { key: 'defaultMemory', labelKey: 'ns.limitRanges.thDefaultMemory', label: 'Default Memory' },
      { key: 'maxCPU', labelKey: 'ns.limitRanges.thMaxCpu', label: 'Max CPU' },
      { key: 'maxMemory', labelKey: 'ns.limitRanges.thMaxMemory', label: 'Max Memory' },
      { key: 'age', labelKey: 'ns.limitRanges.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsResourceQuotas', labelKey: 'ns.resourceQuotas.title', label: 'ResourceQuotas', icon: 'speed',
    columns: [
      { key: 'name', labelKey: 'ns.resourceQuotas.thName', label: 'Name' },
      { key: 'cpu', labelKey: 'ns.resourceQuotas.thCpu', label: 'CPU' },
      { key: 'memory', labelKey: 'ns.resourceQuotas.thMemory', label: 'Memory' },
      { key: 'pods', labelKey: 'ns.resourceQuotas.thPods', label: 'Pods' },
      { key: 'age', labelKey: 'ns.resourceQuotas.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsStoragePVC', labelKey: 'ns.storage.pvcTab', label: 'PVCs', icon: 'storage',
    columns: [
      { key: 'name', labelKey: 'ns.storage.thPvcName', label: 'Name' },
      { key: 'status', labelKey: 'ns.storage.thStatus', label: 'Status' },
      { key: 'capacity', labelKey: 'ns.storage.thCapacity', label: 'Capacity' },
      { key: 'used', labelKey: 'ns.storage.thUsed', label: 'Used' },
      { key: 'accessModes', labelKey: 'ns.storage.thAccess', label: 'Access' },
      { key: 'storageClass', labelKey: 'ns.storage.thStorageClass', label: 'StorageClass' },
      { key: 'volume', labelKey: 'ns.storage.thVolume', label: 'Volume' },
      { key: 'age', labelKey: 'ns.storage.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsStorageSC', labelKey: 'ns.storage.storageClassTab', label: 'StorageClasses', icon: 'database',
    columns: [
      { key: 'name', labelKey: 'ns.storage.thScName', label: 'Name' },
      { key: 'provisioner', labelKey: 'ns.storage.thProvisioner', label: 'Provisioner' },
      { key: 'parameters', labelKey: 'ns.storage.thParameters', label: 'Parameters' },
      { key: 'reclaimPolicy', labelKey: 'ns.storage.thReclaimPolicy', label: 'Reclaim Policy' },
      { key: 'default', labelKey: 'ns.storage.thDefault', label: 'Default' },
      { key: 'age', labelKey: 'ns.storage.thScAge', label: 'Age' },
    ],
  },
  // —— 已用 DataTable 资源类(RBAC / Storage / Configuration)——
  {
    key: 'rbacRoles', labelKey: 'rbac.title', label: 'RBAC Roles', icon: 'admin_panel_settings',
    columns: [
      { key: 'name', labelKey: 'rbac.thName', label: 'Name' },
      { key: 'namespace', labelKey: 'rbac.thNamespace', label: 'Namespace' },
      { key: 'scope', labelKey: 'rbac.thScope', label: 'Scope' },
      { key: 'bindings', labelKey: 'rbac.thBindings', label: 'Bindings' },
      { key: 'actions', labelKey: 'rbac.thActions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'rbacCRBs', labelKey: 'rbac.title', label: 'ClusterRoleBindings', icon: 'share',
    columns: [
      { key: 'name', labelKey: 'rbac.thName', label: 'Name' },
      { key: 'roleName', labelKey: 'rbac.thRoleName', label: 'Role' },
      { key: 'subjects', labelKey: 'rbac.thSubjects', label: 'Subjects' },
      { key: 'age', labelKey: 'rbac.thAge', label: 'Age' },
    ],
  },
  {
    key: 'rbacSAs', labelKey: 'rbac.title', label: 'ServiceAccounts', icon: 'person',
    columns: [
      { key: 'name', labelKey: 'rbac.thName', label: 'Name' },
      { key: 'namespace', labelKey: 'rbac.thNamespace', label: 'Namespace' },
      { key: 'age', labelKey: 'rbac.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'rbac.thActions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsRbacRoles', labelKey: 'cols.rbac._t', label: 'Roles', icon: 'admin_panel_settings',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'namespace', labelKey: 'rbac.thScope', label: 'Scope' },
      { key: 'bindings', labelKey: 'cols.rbac.bindings', label: 'Bindings' },
    ],
  },
  {
    key: 'nsRbacSAs', labelKey: 'cols.rbac._t', label: 'ServiceAccounts', icon: 'person',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
    ],
  },
  {
    key: 'nsRbacBindings', labelKey: 'cols.rbac._t', label: 'RoleBindings', icon: 'link',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'roleName', labelKey: 'cols.rbac.role', label: 'Role' },
      { key: 'subjects', labelKey: 'cols.rbac.subjects', label: 'Subjects' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'storagePVC', labelKey: 'storage.tabs.pvc', label: 'PVCs', icon: 'storage',
    columns: [
      { key: 'name', labelKey: 'storage.thName', label: 'Name' },
      { key: 'namespace', labelKey: 'storage.thNamespace', label: 'Namespace' },
      { key: 'status', labelKey: 'storage.thStatus', label: 'Status' },
      { key: 'capacity', labelKey: 'storage.thCapacity', label: 'Capacity' },
      { key: 'accessModes', labelKey: 'storage.thAccess', label: 'Access' },
      { key: 'storageClass', labelKey: 'storage.thStorageClass', label: 'StorageClass' },
      { key: 'age', labelKey: 'storage.thAge', label: 'Age' },
    ],
  },
  {
    key: 'storagePV', labelKey: 'storage.tabs.pv', label: 'PersistentVolumes', icon: 'database',
    columns: [
      { key: 'name', labelKey: 'storage.thName', label: 'Name' },
      { key: 'capacity', labelKey: 'storage.thCapacity', label: 'Capacity' },
      { key: 'accessModes', labelKey: 'storage.thAccess', label: 'Access' },
      { key: 'reclaimPolicy', labelKey: 'storage.thReclaim', label: 'Reclaim' },
      { key: 'status', labelKey: 'storage.thStatus', label: 'Status' },
      { key: 'claim', labelKey: 'storage.thClaim', label: 'Claim' },
      { key: 'storageClass', labelKey: 'storage.thStorageClass', label: 'StorageClass' },
      { key: 'actions', labelKey: 'storage.thActions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'storageSC', labelKey: 'storage.tabs.sc', label: 'StorageClasses', icon: 'database',
    columns: [
      { key: 'name', labelKey: 'storage.thName', label: 'Name' },
      { key: 'provisioner', labelKey: 'storage.thProvisioner', label: 'Provisioner' },
      { key: 'reclaimPolicy', labelKey: 'storage.thReclaim', label: 'Reclaim' },
      { key: 'default', labelKey: 'storage.thDefault', label: 'Default' },
      { key: 'age', labelKey: 'storage.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'storage.thActions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'configCM', labelKey: 'config.configmapsTab', label: 'ConfigMaps', icon: 'description',
    columns: [
      { key: 'name', labelKey: 'config.name', label: 'Name' },
      { key: 'namespace', labelKey: 'config.namespace', label: 'Namespace' },
      { key: 'keys', labelKey: 'config.dataKeys', label: 'Data Keys' },
      { key: 'age', labelKey: 'config.age', label: 'Age' },
      { key: 'actions', labelKey: 'config.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'configSecret', labelKey: 'config.secretsTab', label: 'Secrets', icon: 'key',
    columns: [
      { key: 'name', labelKey: 'config.name', label: 'Name' },
      { key: 'namespace', labelKey: 'config.namespace', label: 'Namespace' },
      { key: 'type', labelKey: 'config.type', label: 'Type' },
      { key: 'keys', labelKey: 'config.keys', label: 'Keys' },
      { key: 'age', labelKey: 'config.age', label: 'Age' },
      { key: 'actions', labelKey: 'config.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'configRQ', labelKey: 'config.resourcequotasTab', label: 'ResourceQuotas', icon: 'pie_chart',
    columns: [
      { key: 'name', labelKey: 'config.name', label: 'Name' },
      { key: 'namespace', labelKey: 'config.namespace', label: 'Namespace' },
      { key: 'limits', labelKey: 'config.limits', label: 'Limits' },
      { key: 'age', labelKey: 'config.age', label: 'Age' },
      { key: 'actions', labelKey: 'config.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'configLR', labelKey: 'config.limitrangesTab', label: 'LimitRanges', icon: 'tune',
    columns: [
      { key: 'name', labelKey: 'config.name', label: 'Name' },
      { key: 'namespace', labelKey: 'config.namespace', label: 'Namespace' },
      { key: 'defaultCPU', labelKey: 'config.defCPU', label: 'Def CPU' },
      { key: 'defaultMemory', labelKey: 'config.defMemory', label: 'Def Memory' },
      { key: 'age', labelKey: 'config.age', label: 'Age' },
      { key: 'actions', labelKey: 'config.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'configHPA', labelKey: 'config.hpasTab', label: 'HorizontalPodAutoscalers', icon: 'timeline',
    columns: [
      { key: 'name', labelKey: 'config.name', label: 'Name' },
      { key: 'namespace', labelKey: 'config.namespace', label: 'Namespace' },
      { key: 'targetName', labelKey: 'config.target', label: 'Target' },
      { key: 'minReplicas', labelKey: 'config.min', label: 'Min' },
      { key: 'maxReplicas', labelKey: 'config.max', label: 'Max' },
      { key: 'cpuTarget', labelKey: 'config.cpuTarget', label: 'CPU %' },
      { key: 'age', labelKey: 'config.age', label: 'Age' },
      { key: 'actions', labelKey: 'config.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'nsEndpoints', labelKey: 'ns.endpoints.title', label: 'Endpoints', icon: 'hub',
    columns: [
      { key: 'name', labelKey: 'ns.endpoints.thName', label: 'Name' },
      { key: 'ready', labelKey: 'ns.endpoints.thReady', label: 'Ready' },
      { key: 'addresses', labelKey: 'ns.endpoints.thAddresses', label: 'Addresses' },
      { key: 'ports', labelKey: 'ns.endpoints.thPorts', label: 'Ports' },
      { key: 'age', labelKey: 'ns.endpoints.thAge', label: 'Age' },
    ],
  },
  // —— 集群硬编码列表(Phase2 Task7)——
  {
    key: 'crds', labelKey: 'admin.crdList.title', label: 'Custom Resource Definitions', icon: 'extension',
    columns: [
      { key: 'name', labelKey: 'admin.crdList.thName', label: 'Name' },
      { key: 'groupVersion', labelKey: 'admin.crdList.thGroupVersion', label: 'Group / Version' },
      { key: 'kind', labelKey: 'admin.crdList.thKind', label: 'Kind' },
      { key: 'scope', labelKey: 'admin.crdList.thScope', label: 'Scope' },
      { key: 'description', labelKey: 'admin.crdList.thDescription', label: 'Description' },
    ],
  },
  {
    key: 'ingressClasses', labelKey: 'admin.ingressClasses.title', label: 'IngressClasses', icon: 'language',
    columns: [
      { key: 'name', labelKey: 'admin.ingressClasses.thName', label: 'Name' },
      { key: 'controller', labelKey: 'admin.ingressClasses.thController', label: 'Controller' },
      { key: 'isDefault', labelKey: 'admin.ingressClasses.thDefault', label: 'Default' },
      { key: 'age', labelKey: 'admin.ingressClasses.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'admin.ingressClasses.thActions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'priorityClasses', labelKey: 'admin.priorityClasses.title', label: 'PriorityClasses', icon: 'flag',
    columns: [
      { key: 'name', labelKey: 'admin.priorityClasses.thName', label: 'Name' },
      { key: 'value', labelKey: 'admin.priorityClasses.thValue', label: 'Value' },
      { key: 'globalDefault', labelKey: 'admin.priorityClasses.thGlobalDefault', label: 'Global Default' },
      { key: 'description', labelKey: 'admin.priorityClasses.thDescription', label: 'Description' },
      { key: 'age', labelKey: 'admin.priorityClasses.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'admin.priorityClasses.thActions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'runtimeClasses', labelKey: 'admin.runtimeClasses.title', label: 'RuntimeClasses', icon: 'memory',
    columns: [
      { key: 'name', labelKey: 'admin.runtimeClasses.thName', label: 'Name' },
      { key: 'handler', labelKey: 'admin.runtimeClasses.thHandler', label: 'Handler' },
      { key: 'age', labelKey: 'admin.runtimeClasses.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'admin.runtimeClasses.thActions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'auditLogs', labelKey: 'audit.title', label: 'Audit Logs', icon: 'manage_history',
    columns: [
      { key: 'type', labelKey: 'audit.type', label: 'Type' },
      { key: 'reason', labelKey: 'audit.reason', label: 'Reason' },
      { key: 'resource', labelKey: 'audit.resource', label: 'Resource' },
      { key: 'namespace', labelKey: 'audit.namespace', label: 'Namespace' },
      { key: 'message', labelKey: 'audit.message', label: 'Message' },
      { key: 'time', labelKey: 'audit.time', label: 'Time' },
    ],
  },
  {
    key: 'clusterResources', labelKey: 'admin.resourceList.title', label: 'Cluster Resources', icon: 'widgets',
    columns: [
      { key: 'name', labelKey: 'admin.resourceList.thName', label: 'Name' },
      { key: 'namespace', labelKey: 'admin.resourceList.thNamespace', label: 'Namespace' },
      { key: 'detail', labelKey: 'admin.resourceList.thDetail', label: 'Detail' },
      { key: 'status', labelKey: 'admin.resourceList.thStatus', label: 'Status' },
      { key: 'age', labelKey: 'admin.resourceList.thAge', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  // —— admin/app 视图(Phase 2 扩张:工作台 / 审计 / API Key / 用户)——
  {
    key: 'auditTrail', labelKey: 'auditTrail.title', label: 'Audit Trail', icon: 'manage_history',
    columns: [
      { key: 'ts', labelKey: 'auditTrail.colTs', label: 'Time' },
      { key: 'owner', labelKey: 'auditTrail.colOwner', label: 'Owner' },
      { key: 'source', labelKey: 'auditTrail.colSource', label: 'Source' },
      { key: 'clusterId', labelKey: 'auditTrail.colCluster', label: 'Cluster' },
      { key: 'namespace', labelKey: 'auditTrail.colNamespace', label: 'Namespace' },
      { key: 'tool', labelKey: 'auditTrail.colTool', label: 'Tool' },
      { key: 'resource', labelKey: 'auditTrail.colResource', label: 'Resource' },
      { key: 'result', labelKey: 'auditTrail.colResult', label: 'Result' },
    ],
  },
  {
    key: 'apiKeys', labelKey: 'admin.apiKeys.title', label: 'API Keys', icon: 'key',
    columns: [
      { key: 'prefix', labelKey: 'admin.apiKeys.colKey', label: 'Key' },
      { key: 'tier', labelKey: 'admin.apiKeys.colTier', label: 'Tier' },
      { key: 'overrides', labelKey: 'admin.apiKeys.colOverrides', label: 'Overrides' },
      { key: 'nsAllowlist', labelKey: 'nsAllowlist.colHeader', label: 'Allowed ns' },
      { key: 'owner', labelKey: 'admin.apiKeys.colOwner', label: 'Owner' },
      { key: 'boundSA', labelKey: 'admin.apiKeys.colBoundSA', label: 'Bound SA' },
      { key: 'cluster', labelKey: 'admin.apiKeys.colCluster', label: 'Cluster' },
      { key: 'state', labelKey: 'common.status', label: 'Status' },
      { key: 'created', labelKey: 'admin.apiKeys.colCreated', label: 'Created' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'userMgmt', labelKey: 'admin.users.title', label: 'Users', icon: 'group',
    columns: [
      { key: 'username', labelKey: 'admin.users.colUsername', label: 'Username' },
      { key: 'role', labelKey: 'common.role', label: 'Role' },
      { key: 'displayName', labelKey: 'admin.users.colDisplayName', label: 'Display Name' },
      { key: 'assignedClusters', labelKey: 'admin.users.colAssignedClusters', label: 'Assigned Clusters' },
      { key: 'status', labelKey: 'common.status', label: 'Status' },
      { key: 'actions', labelKey: 'common.actions', label: 'Actions', align: 'right' },
    ],
  },
]

// v1: { [tableKey]: { [colKey]: false } } (false = 隐藏)
// v2: { [tableKey]: { order?: string[], hidden?: { [k]: true }, width?: { [k]: number } } }
export function migrateV1toV2(v1) {
  if (!v1 || typeof v1 !== 'object') return {}
  const v2 = {}
  for (const [tableKey, cols] of Object.entries(v1)) {
    if (!cols || typeof cols !== 'object') continue
    const hidden = {}
    for (const [colKey, val] of Object.entries(cols)) {
      if (val === false) hidden[colKey] = true
    }
    if (Object.keys(hidden).length) v2[tableKey] = { hidden }
  }
  return v2
}

// 对账:catalog 为准。order 重排(未列入的 catalog 列按默认序追加到末尾;order 中
// 不存在的 key 忽略);hidden/width 合并。返回 ordered(全量,带标记)+ visible(过滤)。
export function reconcileColumns(catalogColumns, overrides) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {}
  const order = Array.isArray(ov.order) ? ov.order : []
  const hidden = ov.hidden && typeof ov.hidden === 'object' ? ov.hidden : {}
  const width = ov.width && typeof ov.width === 'object' ? ov.width : {}

  const ordered = [...catalogColumns]
  if (order.length) {
    ordered.sort((a, b) => {
      const ia = order.indexOf(a.key)
      const ib = order.indexOf(b.key)
      if (ia === -1 && ib === -1) return 0
      if (ia === -1) return 1   // a 不在 order → 排到后面
      if (ib === -1) return -1  // b 不在 order → 排到后面
      return ia - ib
    })
  }

  const tagged = ordered.map(c => ({
    ...c,
    hidden: hidden[c.key] === true,
    width: typeof width[c.key] === 'number' ? width[c.key] : undefined,
  }))
  return { ordered: tagged, visible: tagged.filter(c => !c.hidden) }
}
