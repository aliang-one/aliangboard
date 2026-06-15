<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'

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
]

// Create modals
const showCreateRoleModal = ref(false)
const showCreateSAModal = ref(false)
const newRole = ref({ name: '', scope: 'Namespace', rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }] })
const newSA = ref({ name: '' })

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

function goToRole(name) {
  router.push({ name: 'NsRoleDetail', params: { namespace: route.params.namespace, name } })
}

function goToSA(name) {
  router.push({ name: 'NsServiceAccountDetail', params: { namespace: route.params.namespace, name } })
}

function goToBinding(name) {
  router.push({ name: 'NsRoleBindingDetail', params: { namespace: route.params.namespace, name } })
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'RBAC' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <h2 class="text-display-lg text-on-surface">RBAC</h2>
      <div class="flex gap-sm">
        <button @click="showCreateRoleModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors">
          <span class="material-symbols-outlined">add</span> Create Role
        </button>
        <button @click="showCreateSAModal = true" class="flex items-center gap-sm px-md py-sm border border-outline-variant font-semibold rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined">add</span> Create SA
        </button>
      </div>
    </div>
    <div class="flex border-b border-outline-variant mb-lg">
      <button @click="activeTab = 'roles'" class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors" :class="activeTab === 'roles' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">Roles</button>
      <button @click="activeTab = 'serviceaccounts'" class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors" :class="activeTab === 'serviceaccounts' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">ServiceAccounts</button>
      <button @click="activeTab = 'rolebindings'" class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors" :class="activeTab === 'rolebindings' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">RoleBindings</button>
    </div>

    <!-- Roles Tab -->
    <DataTable v-if="activeTab === 'roles'" :headers="roleHeaders" :rows="store.nsRoles">
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
    </DataTable>

    <!-- ServiceAccounts Tab -->
    <DataTable v-if="activeTab === 'serviceaccounts'" :headers="saHeaders" :rows="store.nsServiceAccounts">
      <template #name="{ row }">
        <div class="flex items-center gap-md cursor-pointer hover:text-primary transition-colors" @click="goToSA(row.name)">
          <span class="material-symbols-outlined text-tertiary-container">person</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
    </DataTable>

    <!-- RoleBindings Tab -->
    <DataTable v-if="activeTab === 'rolebindings'" :headers="bindingHeaders" :rows="store.nsRoleBindings">
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
    </DataTable>
  </section>

  <!-- Create Role Modal -->
  <Modal v-model="showCreateRoleModal" title="Create Role" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Role Name</label>
        <input v-model="newRole.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="e.g., developer" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Scope</label>
        <select v-model="newRole.scope" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option value="Namespace">Namespace</option>
          <option value="Cluster">Cluster</option>
        </select>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateRoleModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="createRole" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Create</button>
    </template>
  </Modal>

  <!-- Create ServiceAccount Modal -->
  <Modal v-model="showCreateSAModal" title="Create ServiceAccount" width="max-w-md">
    <div>
      <label class="text-label-caps text-on-surface-variant block mb-xs">ServiceAccount Name</label>
      <input v-model="newSA.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="e.g., my-service-account" />
    </div>
    <template #actions>
      <button @click="showCreateSAModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="createSA" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Create</button>
    </template>
  </Modal>
</template>
