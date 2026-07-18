<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const sa = computed(() => store.getServiceAccountByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('serviceaccount', sa.value))

const activeTab = ref('overview')
const showDeleteModal = ref(false)

// Associated secrets of type service-account-token
const saSecrets = computed(() => {
  if (!sa.value) return []
  return store.nsSecrets.filter(s =>
    s.type && s.type.includes('service-account-token')
  )
})

// RoleBindings that reference this ServiceAccount as a subject
const saRoleBindings = computed(() => {
  if (!sa.value) return []
  return store.nsRoleBindings.filter(rb =>
    rb.subjects?.some(s => s.kind === 'ServiceAccount' && s.name === sa.value.name)
  )
})

function handleDelete() {
  store.deleteServiceAccount(route.params.name, route.params.namespace)
  router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })
}

// === 结构化编辑 ===
const showEditModal = ref(false)
const editAutomount = ref(true)
const editImagePullSecrets = ref('')

function openEdit() {
  editAutomount.value = sa.value?.automountServiceAccountToken === undefined ? true : sa.value.automountServiceAccountToken
  editImagePullSecrets.value = (sa.value?.imagePullSecrets || []).map(s => s.name).join(', ')
  showEditModal.value = true
}
function saveEdit() {
  store.updateServiceAccount(route.params.name, route.params.namespace, {
    automountServiceAccountToken: editAutomount.value,
    imagePullSecrets: editImagePullSecrets.value.split(',').map(s => s.trim()).filter(Boolean).map(n => ({ name: n })),
  })
  showEditModal.value = false
}
</script>

<template>
  <div class="animate-fade-in" v-if="sa">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'RBAC', route: `/ns/${route.params.namespace}/rbac` },
      { label: route.params.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-tertiary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-tertiary text-3xl">person</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ sa.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-tertiary-container/10 text-tertiary text-label-caps rounded-full font-medium">ServiceAccount</span>
            <span class="text-body-sm text-on-surface-variant">Namespace: <span class="text-primary font-medium">{{ sa.namespace }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ sa.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors">
          <span class="material-symbols-outlined">edit</span> Edit
        </button>
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> Delete
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'secrets', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">ServiceAccount Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Name</p>
              <p class="font-mono text-code-md text-on-surface font-semibold">{{ sa.name }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Namespace</p>
              <p class="font-mono text-code-sm text-primary">{{ sa.namespace }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Age</p>
              <p class="text-body-md text-on-surface">{{ sa.age }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Automount Token</p>
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-lg" :class="(sa.automountServiceAccountToken === undefined ? true : sa.automountServiceAccountToken) ? 'text-primary' : 'text-on-surface-variant'">{{ (sa.automountServiceAccountToken === undefined ? true : sa.automountServiceAccountToken) ? 'check_circle' : 'cancel' }}</span>
                <span class="text-body-md text-on-surface">{{ (sa.automountServiceAccountToken === undefined ? true : sa.automountServiceAccountToken) ? 'Enabled' : 'Disabled' }}</span>
              </div>
            </div>
            <div v-if="sa.imagePullSecrets && sa.imagePullSecrets.length" class="p-md rounded-lg bg-surface-container-low col-span-2">
              <p class="text-label-caps text-on-surface-variant mb-xs">Image Pull Secrets</p>
              <div class="flex flex-wrap gap-sm">
                <span v-for="ips in sa.imagePullSecrets" :key="ips.name" class="flex items-center gap-xs px-2.5 py-0.5 bg-tertiary-container/10 text-tertiary text-label-caps rounded-full font-medium">
                  {{ ips.name }}
                </span>
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
              <span class="text-body-sm text-on-surface-variant">Secrets</span>
              <span class="text-body-md font-semibold text-primary">{{ saSecrets.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">RoleBindings</span>
              <span class="text-body-md font-semibold text-on-surface">{{ saRoleBindings.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">API Version</span>
              <span class="text-body-sm font-mono text-on-surface-variant">v1</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Secrets Tab -->
    <div v-if="activeTab === 'secrets'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <h3 class="text-headline-sm">Tokens / Secrets ({{ saSecrets.length }})</h3>
        </div>
        <table v-if="saSecrets.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Keys</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="secret in saSecrets" :key="secret.name" class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-tertiary text-lg">key</span>
                  <span class="font-mono text-code-sm font-semibold text-on-surface">{{ secret.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md">
                <span class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary text-label-caps rounded border border-tertiary/20">{{ secret.type }}</span>
              </td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ secret.keys }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ secret.age }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">key</span>
          <p class="mt-sm">No service account tokens found in this namespace</p>
        </div>
      </div>
    </div>

    <!-- YAML Tab -->
    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-lg text-on-surface mt-md">ServiceAccount Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">ServiceAccount "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to RBAC</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete ServiceAccount" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete ServiceAccount <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Pods using this ServiceAccount may fail to start. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" title="Edit ServiceAccount" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <label class="flex items-center gap-sm cursor-pointer">
        <input type="checkbox" v-model="editAutomount" class="w-4 h-4 accent-primary" />
        <span class="text-body-md text-on-surface">Automount Service Account Token</span>
      </label>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Image Pull Secrets</label>
        <input v-model="editImagePullSecrets" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="my-secret, docker-registry-key" />
        <p class="text-body-sm text-on-surface-variant mt-xs">comma-separated</p>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save</button>
    </template>
  </Modal>
</template>
