import { createRouter, createWebHistory } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { title: 'Login' }
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
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/Settings.vue'),
        meta: { title: 'Settings', icon: 'tune', scope: 'global' }
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
        meta: { title: 'NetworkPolicies', icon: 'firewall', scope: 'namespace' }
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
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
