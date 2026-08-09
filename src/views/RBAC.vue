<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useI18n } from 'vue-i18n'
import { notify } from '@/composables/useToast'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'
import { useResourceList } from '@/composables/useK8sQuery'

const { t } = useI18n()
const router = useRouter()
const store = useClusterStore()
const activeTab = ref('roles')

const cid = computed(() => (store.currentCluster || 'cluster'))
const nsQ = useResourceList({ key: ['cluster', cid.value, 'namespaces'], fetcher: () => store.fetchNamespaces(), options: { refetchInterval: 60000 } })
const allNamespaces = computed(() => nsQ.data.value ?? store.namespaceList)
const rolesQuery = useResourceList({
  key: ['cluster', cid.value, 'roles'],
  fetcher: () => store.fetchRoles(),
  options: { refetchInterval: 30000 },
})
const clusterRoleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'clusterrolebindings'],
  fetcher: () => store.fetchClusterRoleBindings(),
  options: { refetchInterval: 30000 },
})
const serviceAccountsQuery = useResourceList({
  key: ['cluster', cid.value, 'serviceaccounts'],
  fetcher: () => store.fetchServiceAccounts(),
  options: { refetchInterval: 30000 },
})

const tabs = computed(() => [
  { key: 'roles', label: t('rbac.rolesTab') },
  { key: 'clusterrolebindings', label: t('rbac.clusterRoleBindingsTab') },
  { key: 'serviceaccounts', label: t('rbac.serviceAccountsTab') },
])

const roleHeaders = computed(() => [
  { key: 'name', label: t('rbac.thName') },
  { key: 'namespace', label: t('rbac.thNamespace') },
  { key: 'scope', label: t('rbac.thScope') },
  { key: 'bindings', label: t('rbac.thBindings') },
  { key: 'actions', label: t('rbac.thActions'), align: 'right' },
])

const crbHeaders = computed(() => [
  { key: 'name', label: t('rbac.thName') },
  { key: 'roleName', label: t('rbac.thRoleName') },
  { key: 'subjects', label: t('rbac.thSubjects') },
  { key: 'age', label: t('rbac.thAge') },
])

const saHeaders = computed(() => [
  { key: 'name', label: t('rbac.thName') },
  { key: 'namespace', label: t('rbac.thNamespace') },
  { key: 'age', label: t('rbac.thAge') },
  { key: 'actions', label: t('rbac.thActions'), align: 'right' },
])

function openRole(row) {
  if (row.scope === 'Cluster') router.push({ name: 'ClusterRoleDetail', params: { name: row.name } })
  else router.push({ name: 'NsRoleDetail', params: { namespace: row.namespace, name: row.name } })
}
function openCRB(row) {
  router.push({ name: 'ClusterRoleBindingDetail', params: { name: row.name } })
}
function openSA(row) {
  router.push({ name: 'NsServiceAccountDetail', params: { namespace: row.namespace, name: row.name } })
}

// 按 tab 切换的当前列表
const currentTabList = computed(() => ({
  roles: rolesQuery.data.value || [],
  clusterrolebindings: clusterRoleBindingsQuery.data.value || [],
  serviceaccounts: serviceAccountsQuery.data.value || [],
}[activeTab.value] || []))
const { currentPage, pageSize, paginated, total } = usePagination(currentTabList, { resetDeps: [activeTab] })

// 新建：跳转到当前（或首个）命名空间的 RBAC 页，那里已有 Create Role / SA / ClusterRoleBinding 表单
function createRole() {
  const ns = store.currentNamespace || allNamespaces.value?.[0]?.name || 'default'
  router.push({ name: 'NsRBAC', params: { namespace: ns } })
}

// 编辑：复用行点击的详情跳转（详情页带结构化编辑 + apply YAML）
const editRole = row => openRole(row)
const editSA = row => openSA(row)

// 删除（roles tab 兼容 Namespace/Cluster 两种 scope；ClusterRoleBinding 走集群级删除）
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)
function askDelete(row) {
  deleteTarget.value = { tab: activeTab.value, name: row.name, namespace: row.namespace, scope: row.scope }
  showDeleteModal.value = true
}
async function doDelete() {
  if (!deleteTarget.value) return
  const { tab, name, namespace } = deleteTarget.value
  deleting.value = true
  try {
    if (tab === 'roles') await store.deleteRole(name, namespace || '')
    else if (tab === 'serviceaccounts') await store.deleteServiceAccount(name, namespace)
    notify('success', t('rbac.deleted', { name }))
    showDeleteModal.value = false
    deleteTarget.value = null
  } catch (e) {
    notify('error', e.message || t('rbac.deleteFailed'))
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('rbac.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('rbac.subtitle') }}</p>
      </div>
      <div class="flex gap-sm">
        <button @click="router.push({ name: 'RbacCanI' })" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-base">verified_user</span> {{ t('rbac.permissionSimulation') }}
        </button>
        <button @click="createRole" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
          <span class="material-symbols-outlined text-base">add</span> {{ t('rbac.createRole') }}
        </button>
      </div>
    </div>

    <div class="flex items-center gap-xs border-b border-outline-variant mb-md">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-lg py-2 text-body-sm font-medium transition-colors relative"
        :class="activeTab === tab.key ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'"
      >{{ tab.label }}
        <span v-if="activeTab === tab.key" class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"></span>
      </button>
    </div>

    <DataTable v-if="activeTab === 'roles'" :headers="roleHeaders" :rows="paginated" @row-click="openRole">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-secondary">admin_panel_settings</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #namespace="{ row }">
        <span v-if="row.namespace" class="font-mono text-code-sm">{{ row.namespace }}</span>
        <span v-else class="px-1.5 py-0.5 bg-primary-container/20 text-primary text-xs rounded font-medium">{{ t('rbac.clusterWide') }}</span>
      </template>
      <template #scope="{ row }">
        <span class="px-1.5 py-0.5 bg-surface-container rounded text-xs text-on-surface-variant border border-outline-variant">{{ row.scope }}</span>
      </template>
      <template #bindings="{ row }">
        <span class="font-mono text-code-sm font-bold">{{ row.bindings }}</span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editRole(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('rbac.titleEdit')"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('rbac.titleDelete')"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <DataTable v-if="activeTab === 'clusterrolebindings'" :headers="crbHeaders" :rows="paginated" @row-click="openCRB">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-tertiary-container">share</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #roleName="{ row }">
        <span class="font-mono text-code-sm text-primary">{{ row.roleName }}</span>
      </template>
      <template #subjects="{ row }">
        <span class="text-body-sm text-on-surface-variant">{{ t('rbac.subjectCount', { n: row.subjects?.length || 0 }) }}</span>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <DataTable v-if="activeTab === 'serviceaccounts'" :headers="saHeaders" :rows="paginated" @row-click="openSA">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-tertiary-container">person</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #namespace="{ row }">
        <span class="font-mono text-code-sm">{{ row.namespace }}</span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editSA(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('rbac.titleEdit')"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('rbac.titleDelete')"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>

  <!-- Delete Confirm Modal -->
  <Modal v-model="showDeleteModal" :title="t('rbac.deleteResource')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant" v-html="t('rbac.deleteConfirm', { name: deleteTarget?.name, namespace: deleteTarget?.namespace })"></p>
    <p class="text-body-sm text-error mt-sm" v-html="t('rbac.deleteWarning', { resourceType: deleteTarget?.tab === 'roles' ? (deleteTarget?.scope === 'Cluster' ? 'ClusterRole' : 'Role') : deleteTarget?.tab === 'serviceaccounts' ? 'ServiceAccount' : t('rbac.resource') })"></p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="doDelete" :disabled="deleting" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-50">{{ t('common.delete') }}</button>
    </template>
  </Modal>
</template>
