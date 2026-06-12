<script setup>
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'

const route = useRoute()
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
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'RBAC' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <h2 class="text-display-lg text-on-surface">RBAC</h2>
    </div>
    <div class="flex border-b border-outline-variant mb-lg">
      <button @click="activeTab = 'roles'" class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors" :class="activeTab === 'roles' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">Roles</button>
      <button @click="activeTab = 'serviceaccounts'" class="px-xl py-3 border-b-2 text-body-md font-medium transition-colors" :class="activeTab === 'serviceaccounts' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">ServiceAccounts</button>
    </div>
    <DataTable v-if="activeTab === 'roles'" :headers="roleHeaders" :rows="store.nsRoles">
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
    </DataTable>
    <DataTable v-if="activeTab === 'serviceaccounts'" :headers="saHeaders" :rows="store.nsServiceAccounts">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <span class="material-symbols-outlined text-tertiary-container">person</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
    </DataTable>
  </section>
</template>
