<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const router = useRouter()
const store = useClusterStore()
const activeTab = ref('roles')

const tabs = [
  { key: 'roles', label: 'Roles' },
  { key: 'clusterrolebindings', label: 'ClusterRoleBindings' },
  { key: 'serviceaccounts', label: 'ServiceAccounts' },
]

const roleHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'scope', label: 'Scope' },
  { key: 'bindings', label: 'Bindings' },
  { key: 'actions', label: 'Actions', align: 'right' },
]

const crbHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'roleName', label: 'Role' },
  { key: 'subjects', label: 'Subjects' },
  { key: 'age', label: 'Age' },
]

const saHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: 'Actions', align: 'right' },
]

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
  roles: store.roleList,
  clusterrolebindings: store.clusterRoleBindingList,
  serviceaccounts: store.saList,
}[activeTab.value] || []))
const { currentPage, pageSize, paginated, total } = usePagination(currentTabList, { resetDeps: [activeTab] })

// 新建：跳转到当前（或首个）命名空间的 RBAC 页，那里已有 Create Role / SA / ClusterRoleBinding 表单
function createRole() {
  const ns = store.currentNamespace || store.namespaceList?.[0]?.name || 'default'
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
    notify('success', `已删除 ${name}`)
    showDeleteModal.value = false
    deleteTarget.value = null
  } catch (e) {
    notify('error', e.message || '删除失败')
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">RBAC</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Manage Role-Based Access Control: Roles, RoleBindings, and ServiceAccounts.</p>
      </div>
      <div class="flex gap-sm">
        <button @click="router.push({ name: 'RbacCanI' })" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">verified_user</span> 权限模拟
        </button>
        <button @click="createRole" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90">
          <span class="material-symbols-outlined">add</span> Create Role
        </button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors"
        :class="activeTab === tab.key ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
      >{{ tab.label }}</button>
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
        <span v-else class="px-2 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded">CLUSTER-WIDE</span>
      </template>
      <template #scope="{ row }">
        <span class="px-2 py-0.5 bg-surface-container rounded-full text-label-caps text-on-surface-variant border border-outline-variant">{{ row.scope }}</span>
      </template>
      <template #bindings="{ row }">
        <span class="font-mono text-code-sm font-bold">{{ row.bindings }}</span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="editRole(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="Edit"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete"><span class="material-symbols-outlined text-lg">delete</span></button>
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
        <span class="text-body-sm text-on-surface-variant">{{ row.subjects?.length || 0 }} subject(s)</span>
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
          <button @click.stop="editSA(row)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="Edit"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click.stop="askDelete(row)" class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>

  <!-- Delete Confirm Modal -->
  <Modal v-model="showDeleteModal" title="Delete resource" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">确定删除 <span class="font-mono text-on-surface font-semibold">{{ deleteTarget?.name }}</span><span v-if="deleteTarget?.namespace" class="text-on-surface-variant">（{{ deleteTarget.namespace }}）</span>？</p>
    <p class="text-body-sm text-error mt-sm">此操作不可撤销。删除 {{ deleteTarget?.tab === 'roles' ? (deleteTarget?.scope === 'Cluster' ? 'ClusterRole' : 'Role') : deleteTarget?.tab === 'serviceaccounts' ? 'ServiceAccount' : '资源' }} 将影响依赖它的绑定。</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="doDelete" :disabled="deleting" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-50">Delete</button>
    </template>
  </Modal>
</template>
