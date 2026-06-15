<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const rb = computed(() => store.getRoleBindingByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('rolebinding', rb.value))

const activeTab = ref('overview')
const showDeleteModal = ref(false)

// The referenced role
const referencedRole = computed(() => {
  if (!rb.value) return null
  return store.getRoleByName(rb.value.roleName, rb.value.namespace)
})

function handleDelete() {
  store.deleteRoleBinding(route.params.name, route.params.namespace)
  router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })
}
</script>

<template>
  <div class="animate-fade-in" v-if="rb">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'RBAC', route: `/ns/${route.params.namespace}/rbac` },
      { label: route.params.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">link</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ rb.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded-full font-medium">RoleBinding</span>
            <span class="text-body-sm text-on-surface-variant">Namespace: <span class="text-primary font-medium">{{ rb.namespace }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ rb.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'subjects', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">RoleBinding Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Name</p>
              <p class="font-mono text-code-md text-on-surface font-semibold">{{ rb.name }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Namespace</p>
              <p class="font-mono text-code-sm text-primary">{{ rb.namespace }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">RoleRef Kind</p>
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-lg text-secondary">admin_panel_settings</span>
                <span class="text-body-md font-semibold text-on-surface">{{ rb.roleKind }}</span>
              </div>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">RoleRef Name</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ rb.roleName }}</p>
            </div>
          </div>
        </div>

        <!-- RoleRef card -->
        <div v-if="referencedRole" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Referenced Role</h3>
          <div class="flex items-center gap-lg p-md rounded-lg bg-surface-container-low">
            <div class="w-10 h-10 rounded-lg bg-secondary-container/20 flex items-center justify-center">
              <span class="material-symbols-outlined text-secondary text-xl">admin_panel_settings</span>
            </div>
            <div class="flex-1">
              <p class="font-mono text-code-md text-on-surface font-semibold">{{ referencedRole.name }}</p>
              <div class="flex items-center gap-md mt-xs">
                <span class="px-2 py-0.5 rounded-full text-label-caps font-medium" :class="referencedRole.scope === 'Cluster' ? 'bg-primary-container/20 text-primary' : 'bg-secondary-container/20 text-secondary'">
                  {{ referencedRole.scope === 'Cluster' ? 'ClusterRole' : 'Role' }}
                </span>
                <span class="text-body-sm text-on-surface-variant">{{ referencedRole.bindings }} binding(s)</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Summary</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Kind</span>
              <span class="text-body-md font-semibold text-on-surface">RoleBinding</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Subjects</span>
              <span class="text-body-md font-semibold text-primary">{{ rb.subjects?.length || 0 }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Role Kind</span>
              <span class="text-body-md text-on-surface">{{ rb.roleKind }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Role Name</span>
              <span class="text-body-md font-mono text-primary">{{ rb.roleName }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Age</span>
              <span class="text-body-md text-on-surface">{{ rb.age }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Subjects Tab -->
    <div v-if="activeTab === 'subjects'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <h3 class="text-headline-sm">Subjects ({{ rb.subjects?.length || 0 }})</h3>
        </div>
        <table v-if="rb.subjects?.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Kind</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Namespace</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="(subj, idx) in rb.subjects" :key="idx" class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-lg" :class="subj.kind === 'ServiceAccount' ? 'text-tertiary' : subj.kind === 'Group' ? 'text-secondary' : 'text-primary'">
                    {{ subj.kind === 'ServiceAccount' ? 'person' : subj.kind === 'Group' ? 'group' : 'account_circle' }}
                  </span>
                  <span class="px-2 py-0.5 rounded text-label-caps font-medium" :class="subj.kind === 'ServiceAccount' ? 'bg-tertiary-container/10 text-tertiary' : subj.kind === 'Group' ? 'bg-secondary-container/10 text-secondary' : 'bg-primary-container/10 text-primary'">
                    {{ subj.kind }}
                  </span>
                </div>
              </td>
              <td class="px-lg py-md font-mono text-code-sm font-semibold text-on-surface">{{ subj.name }}</td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ subj.namespace || rb.namespace }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">group_off</span>
          <p class="mt-sm">No subjects defined for this RoleBinding</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="() => {}" />
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">RoleBinding Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">RoleBinding "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to RBAC</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete RoleBinding" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete RoleBinding <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Subjects will lose the permissions granted by this binding. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
