<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'

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
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">RBAC</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Manage Role-Based Access Control: Roles, RoleBindings, and ServiceAccounts.</p>
      </div>
      <button class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90">
        <span class="material-symbols-outlined">add</span> Create Role
      </button>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors"
        :class="activeTab === tab.key ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
      >{{ tab.label }}</button>
    </div>

    <DataTable v-if="activeTab === 'roles'" :headers="roleHeaders" :rows="store.roleList" @row-click="openRole">
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
      <template #actions>
        <div class="flex justify-end gap-1">
          <button class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
    </DataTable>

    <DataTable v-if="activeTab === 'clusterrolebindings'" :headers="crbHeaders" :rows="store.clusterRoleBindingList" @row-click="openCRB">
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
    </DataTable>

    <DataTable v-if="activeTab === 'serviceaccounts'" :headers="saHeaders" :rows="store.saList" @row-click="openSA">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-tertiary-container">person</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #namespace="{ row }">
        <span class="font-mono text-code-sm">{{ row.namespace }}</span>
      </template>
      <template #actions>
        <div class="flex justify-end gap-1">
          <button class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </template>
    </DataTable>
  </section>
</template>
