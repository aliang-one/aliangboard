<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const activeTab = ref('roles')

const roleHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Scope' },
  { key: 'bindings', label: 'Bindings' },
]

const saHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'age', label: 'Age' },
]

const bindingHeaders = [
  { key: 'name', label: 'Name' },
  { key: 'roleName', label: 'Role' },
  { key: 'subjects', label: 'Subjects' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: '', align: 'right' },
]

const clusterRoleOptions = computed(() => store.clusterRoles.map(r => r.name))

// Create modals
const showCreateRoleModal = ref(false)
const showCreateSAModal = ref(false)
const showCreateCRBModal = ref(false)
const newRole = ref({ name: '', scope: 'Namespace', rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }] })
const newSA = ref({ name: '' })
const newCRB = ref({ name: '', roleName: '', subjectKind: 'User', subjectName: '' })

function createRole() {
  if (!newRole.value.name) return
  store.addRole({
    name: newRole.value.name,
    namespace: newRole.value.scope === 'Namespace' ? route.params.namespace : '',
    scope: newRole.value.scope,
    bindings: 0,
    rules: newRole.value.rules,
  })
  newRole.value = { name: '', scope: 'Namespace', rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }] }
  showCreateRoleModal.value = false
}

function createSA() {
  if (!newSA.value.name) return
  store.addServiceAccount({
    name: newSA.value.name,
    namespace: route.params.namespace,
  })
  newSA.value = { name: '' }
  showCreateSAModal.value = false
}

function createCRB() {
  if (!newCRB.value.name || !newCRB.value.roleName) return
  store.addClusterRoleBinding({
    name: newCRB.value.name,
    roleName: newCRB.value.roleName,
    roleKind: 'ClusterRole',
    subjects: [{ kind: newCRB.value.subjectKind, name: newCRB.value.subjectName }],
  })
  newCRB.value = { name: '', roleName: '', subjectKind: 'User', subjectName: '' }
  showCreateCRBModal.value = false
}

// 删除（集群级 Role / ClusterRoleBinding）
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(item, type) {
  deleteTarget.value = { name: item.name, type }
  showDeleteModal.value = true
}
function handleDelete() {
  if (!deleteTarget.value) return
  if (deleteTarget.value.type === 'clusterrole') store.deleteRole(deleteTarget.value.name, '')
  else if (deleteTarget.value.type === 'clusterrolebinding') store.deleteClusterRoleBinding(deleteTarget.value.name)
  showDeleteModal.value = false
  deleteTarget.value = null
}

function goToRole(name) {
  router.push({ name: 'NsRoleDetail', params: { namespace: route.params.namespace, name } })
}

function goToSA(name) {
  router.push({ name: 'NsServiceAccountDetail', params: { namespace: route.params.namespace, name } })
}

function goToBinding(name) {
  router.push({ name: 'NsRoleBindingDetail', params: { namespace: route.params.namespace, name } })
}

// 按 tab 切换的当前列表
const currentTabList = computed(() => ({
  roles: store.nsRoles,
  serviceaccounts: store.nsServiceAccounts,
  rolebindings: store.nsRoleBindings,
  clusterroles: store.clusterRoles,
  clusterrolebindings: store.clusterRoleBindingList,
}[activeTab.value] || []))
const { currentPage, pageSize, paginated, total } = usePagination(currentTabList, { resetDeps: [activeTab] })
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: $t('ns.rbac.title') }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <h2 class="text-headline-md text-on-surface font-bold">{{ $t('ns.rbac.title') }}</h2>
      <div class="flex gap-sm">
        <button @click="showCreateRoleModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 transition-opacity">
          <span class="material-symbols-outlined text-sm">add</span> {{ $t('ns.rbac.createRoleBtn') }}
        </button>
        <button @click="showCreateSAModal = true" class="flex items-center gap-sm px-3 py-1.5 border border-outline-variant font-semibold rounded-lg text-body-sm hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-sm">add</span> {{ $t('ns.rbac.createSaBtn') }}
        </button>
      </div>
    </div>
    <div class="flex flex-wrap border-b border-outline-variant mb-md">
      <button @click="activeTab = 'roles'" class="px-lg py-2 border-b-2 text-body-sm font-medium transition-colors" :class="activeTab === 'roles' ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">{{ $t('ns.rbac.rolesTab') }}</button>
      <button @click="activeTab = 'serviceaccounts'" class="px-lg py-2 border-b-2 text-body-sm font-medium transition-colors" :class="activeTab === 'serviceaccounts' ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">{{ $t('ns.rbac.serviceAccountsTab') }}</button>
      <button @click="activeTab = 'rolebindings'" class="px-lg py-2 border-b-2 text-body-sm font-medium transition-colors" :class="activeTab === 'rolebindings' ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">{{ $t('ns.rbac.roleBindingsTab') }}</button>
      <button @click="activeTab = 'clusterroles'" class="px-lg py-2 border-b-2 text-body-sm font-medium transition-colors flex items-center gap-xs" :class="activeTab === 'clusterroles' ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        <span class="material-symbols-outlined text-sm">public</span>{{ $t('ns.rbac.clusterRolesTab') }}
      </button>
      <button @click="activeTab = 'clusterrolebindings'" class="px-lg py-2 border-b-2 text-body-sm font-medium transition-colors flex items-center gap-xs" :class="activeTab === 'clusterrolebindings' ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        <span class="material-symbols-outlined text-sm">public</span>{{ $t('ns.rbac.clusterRoleBindingsTab') }}
      </button>
    </div>

    <!-- Roles Tab -->
    <DataTable v-if="activeTab === 'roles'" :headers="roleHeaders" :rows="paginated">
      <template #name="{ row }">
        <div class="flex items-center gap-md cursor-pointer hover:text-primary transition-colors" @click="goToRole(row.name)">
          <span class="material-symbols-outlined text-secondary">admin_panel_settings</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #namespace="{ row }">
        <span v-if="row.namespace" class="font-mono text-code-sm">{{ row.namespace }}</span>
        <span v-else class="px-2 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded">CLUSTER-WIDE</span>
      </template>
      <template #bindings="{ row }">
        <span class="text-body-md font-semibold text-primary">{{ row.bindings }}</span>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- ServiceAccounts Tab -->
    <DataTable v-if="activeTab === 'serviceaccounts'" :headers="saHeaders" :rows="paginated">
      <template #name="{ row }">
        <div class="flex items-center gap-md cursor-pointer hover:text-primary transition-colors" @click="goToSA(row.name)">
          <span class="material-symbols-outlined text-tertiary-container">person</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- RoleBindings Tab -->
    <div v-if="activeTab === 'rolebindings'" class="flex flex-col gap-md">
      <div class="flex justify-end">
        <button @click="showCreateRoleModal = true" class="flex items-center gap-sm px-3 py-1.5 border border-outline-variant font-semibold rounded-lg text-body-sm hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-sm">add</span> Create RoleBinding
        </button>
      </div>
      <DataTable :headers="bindingHeaders" :rows="paginated">
        <template #name="{ row }">
          <div class="flex items-center gap-md cursor-pointer hover:text-primary transition-colors" @click="goToBinding(row.name)">
            <span class="material-symbols-outlined text-secondary">link</span>
            <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
          </div>
        </template>
        <template #roleName="{ row }">
          <div class="flex items-center gap-sm">
            <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps">{{ row.roleKind }}</span>
            <span class="font-mono text-code-sm font-medium">{{ row.roleName }}</span>
          </div>
        </template>
        <template #subjects="{ row }">
          <div class="flex flex-wrap gap-xs">
            <span v-for="s in (row.subjects || [])" :key="s.name" class="px-2 py-0.5 bg-primary-container/10 text-primary text-body-sm rounded-full">
              {{ s.kind }}: {{ s.name }}
            </span>
          </div>
        </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
      </DataTable>
    </div>

    <!-- ClusterRoles Tab（集群级）-->
    <div v-if="activeTab === 'clusterroles'" class="flex flex-col gap-md">
      <div class="flex items-center justify-between bg-primary-container/5 border border-primary/20 rounded-lg px-md py-sm">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary">public</span>
          <p class="text-body-sm text-on-surface">{{ $t('ns.rbac.clusterWideHint') }}</p>
        </div>
        <button @click="showCreateRoleModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors text-body-sm">
          <span class="material-symbols-outlined text-sm">add</span> {{ $t('ns.rbac.createClusterRoleBtn') }}
        </button>
      </div>
      <DataTable :headers="roleHeaders" :rows="paginated">
        <template #name="{ row }">
          <div class="flex items-center gap-md cursor-pointer hover:text-primary transition-colors" @click="goToRole(row.name)">
            <span class="material-symbols-outlined text-primary">shield</span>
            <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
          </div>
        </template>
        <template #namespace="{ row }">
          <span class="px-2 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded">CLUSTER-WIDE</span>
        </template>
        <template #bindings="{ row }">
          <span class="text-body-md font-semibold text-primary">{{ row.bindings }}</span>
        </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
      </DataTable>
    </div>

    <!-- ClusterRoleBindings Tab（集群级）-->
    <div v-if="activeTab === 'clusterrolebindings'" class="flex flex-col gap-md">
      <div class="flex items-center justify-between bg-primary-container/5 border border-primary/20 rounded-lg px-md py-sm">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary">public</span>
          <p class="text-body-sm text-on-surface">{{ $t('ns.rbac.clusterRoleBindingHint') }}</p>
        </div>
        <button @click="showCreateCRBModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors text-body-sm">
          <span class="material-symbols-outlined text-sm">add</span> {{ $t('ns.rbac.createClusterRoleBindingBtn') }}
        </button>
      </div>
      <DataTable :headers="bindingHeaders" :rows="paginated">
        <template #name="{ row }">
          <div class="flex items-center gap-md">
            <span class="material-symbols-outlined text-primary">link</span>
            <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
          </div>
        </template>
        <template #roleName="{ row }">
          <div class="flex items-center gap-sm">
            <span class="px-2 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded">ClusterRole</span>
            <span class="font-mono text-code-sm font-medium">{{ row.roleName }}</span>
          </div>
        </template>
        <template #subjects="{ row }">
          <div class="flex flex-wrap gap-xs">
            <span v-for="s in (row.subjects || [])" :key="s.name + s.kind" class="px-2 py-0.5 bg-primary-container/10 text-primary text-body-sm rounded-full">
              {{ s.kind }}: {{ s.name }}
            </span>
          </div>
        </template>
        <template #actions="{ row }">
          <button @click.stop="confirmDelete(row, 'clusterrolebinding')" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="$t('ns.rbac.deleteBtn')">
            <span class="material-symbols-outlined text-lg">delete</span>
          </button>
        </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
      </DataTable>
    </div>
  </section>

  <!-- Create Role Modal -->
  <Modal v-model="showCreateRoleModal" :title="$t('ns.rbac.createRoleBtnModal')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.rbac.roleNameLabel') }}</label>
        <input v-model="newRole.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="e.g., developer" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.rbac.scopeLabel') }}</label>
        <select v-model="newRole.scope" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option value="Namespace">{{ $t('ns.rbac.namespaceScope') }}</option>
          <option value="Cluster">{{ $t('ns.rbac.clusterScope') }}</option>
        </select>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateRoleModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="createRole" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Create ServiceAccount Modal -->
  <Modal v-model="showCreateSAModal" :title="$t('ns.rbac.createSaBtnModal')" width="max-w-md">
    <div>
      <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.rbac.serviceAccountNameLabel') }}</label>
      <input v-model="newSA.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="e.g., my-service-account" />
    </div>
    <template #actions>
      <button @click="showCreateSAModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="createSA" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Create ClusterRoleBinding Modal -->
  <Modal v-model="showCreateCRBModal" :title="$t('ns.rbac.createClusterRoleBindingBtn')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.rbac.bindingNameLabel') }}</label>
        <input v-model="newCRB.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="e.g., my-cluster-binding" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.rbac.clusterRoleLabel') }}</label>
        <select v-model="newCRB.roleName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option value="" disabled>{{ $t('ns.rbac.clusterRolePlaceholder') }}</option>
          <option v-for="r in clusterRoleOptions" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>
      <div class="grid grid-cols-3 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.rbac.subjectKindLabel') }}</label>
          <select v-model="newCRB.subjectKind" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option>User</option><option>Group</option><option>ServiceAccount</option>
          </select>
        </div>
        <div class="col-span-2">
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.rbac.subjectNameLabel') }}</label>
          <input v-model="newCRB.subjectName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="e.g., admin@kubezen.io" />
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateCRBModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('common.cancel') }}</button>
      <button @click="createCRB" :disabled="!newCRB.name || !newCRB.roleName" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="$t('ns.rbac.deleteModalTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ $t('ns.rbac.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ $t('ns.rbac.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('ns.rbac.cancelBtn') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('ns.rbac.deleteBtn') }}</button>
    </template>
  </Modal>
</template>
