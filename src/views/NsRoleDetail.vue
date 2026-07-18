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

const role = computed(() => store.getRoleByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('role', role.value))

const activeTab = ref('overview')
const showDeleteModal = ref(false)
const showEditRuleModal = ref(false)
const editingRuleIndex = ref(null)
const editForm = ref({ apiGroups: '', resources: '', verbs: '' })

// Mock rules for roles that don't have them defined
const defaultRules = computed(() => {
  if (role.value?.rules) return role.value.rules
  // Generate sensible defaults based on role name
  const name = role.value?.name || ''
  if (name === 'admin') {
    return [
      { apiGroups: ['*'], resources: ['*'], verbs: ['*'] },
    ]
  }
  if (name === 'edit') {
    return [
      { apiGroups: ['', 'apps', 'batch'], resources: ['pods', 'deployments', 'statefulsets', 'jobs', 'configmaps', 'secrets'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
    ]
  }
  if (name === 'view') {
    return [
      { apiGroups: ['', 'apps', 'batch'], resources: ['pods', 'deployments', 'statefulsets', 'services', 'configmaps'], verbs: ['get', 'list', 'watch'] },
    ]
  }
  return [
    { apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list'] },
  ]
})

// RoleBindings referencing this role
const roleBindings = computed(() => {
  if (!role.value) return []
  return store.nsRoleBindings.filter(rb =>
    rb.roleName === role.value.name
  )
})

function handleDelete() {
  store.deleteRole(route.params.name, route.params.namespace)
  router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })
}

function openEditRule(index) {
  editingRuleIndex.value = index
  const rule = defaultRules.value[index]
  editForm.value = {
    apiGroups: (rule.apiGroups || []).join(', '),
    resources: (rule.resources || []).join(', '),
    verbs: (rule.verbs || []).join(', '),
  }
  showEditRuleModal.value = true
}

function openAddRule() {
  editingRuleIndex.value = -1
  editForm.value = { apiGroups: '', resources: '', verbs: '' }
  showEditRuleModal.value = true
}

function saveRuleEdit() {
  const rules = [...defaultRules.value]
  const newRule = {
    apiGroups: editForm.value.apiGroups.split(',').map(s => s.trim()).filter(Boolean),
    resources: editForm.value.resources.split(',').map(s => s.trim()).filter(Boolean),
    verbs: editForm.value.verbs.split(',').map(s => s.trim()).filter(Boolean),
  }
  if (editingRuleIndex.value === -1) {
    rules.push(newRule)
  } else {
    rules[editingRuleIndex.value] = newRule
  }
  store.updateRole(route.params.name, route.params.namespace, { rules })
  showEditRuleModal.value = false
}

function deleteRule(index) {
  const rules = [...defaultRules.value]
  rules.splice(index, 1)
  store.updateRole(route.params.name, route.params.namespace, { rules })
}

const scopeBadge = computed(() => {
  if (role.value?.scope === 'Cluster') {
    return { color: 'bg-primary-container/20 text-primary', label: 'Cluster' }
  }
  return { color: 'bg-secondary-container/20 text-secondary', label: 'Namespace' }
})
</script>

<template>
  <div class="animate-fade-in" v-if="role">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'RBAC', route: `/ns/${route.params.namespace}/rbac` },
      { label: route.params.name }
    ]" />

    <!-- Header -->
    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">admin_panel_settings</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ role.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 rounded-full text-label-caps font-medium" :class="scopeBadge.color">
              {{ scopeBadge.label }}
            </span>
            <span v-if="role.namespace" class="text-body-sm text-on-surface-variant">Namespace: <span class="text-primary font-medium">{{ role.namespace }}</span></span>
            <span class="text-body-sm text-on-surface-variant">Bindings: <span class="font-mono font-bold text-on-surface">{{ role.bindings }}</span></span>
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
      <button v-for="tab in ['overview', 'rules', 'bindings', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Role Details</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Name</p>
              <p class="font-mono text-code-md text-on-surface font-semibold">{{ role.name }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Scope</p>
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-lg" :class="role.scope === 'Cluster' ? 'text-primary' : 'text-secondary'">{{ role.scope === 'Cluster' ? 'public' : 'lock' }}</span>
                <span class="text-body-md font-semibold" :class="role.scope === 'Cluster' ? 'text-primary' : 'text-on-surface'">{{ role.scope === 'Cluster' ? 'Cluster' : 'Namespace' }}</span>
              </div>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Namespace</p>
              <p v-if="role.namespace" class="font-mono text-code-sm text-primary">{{ role.namespace }}</p>
              <p v-else class="text-body-sm text-on-surface-variant">Cluster-wide (all namespaces)</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">Bindings</p>
              <p class="font-mono text-code-md text-primary font-semibold">{{ role.bindings }}</p>
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
              <span class="text-body-md font-semibold text-on-surface">{{ role.scope === 'Cluster' ? 'ClusterRole' : 'Role' }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Rules</span>
              <span class="text-body-md font-semibold text-primary">{{ defaultRules.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">RoleBindings</span>
              <span class="text-body-md font-semibold text-on-surface">{{ roleBindings.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">API Version</span>
              <span class="text-body-sm font-mono text-on-surface-variant">rbac.authorization.k8s.io/v1</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Rules Tab -->
    <div v-if="activeTab === 'rules'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Policy Rules ({{ defaultRules.length }})</h3>
          <button @click="openAddRule" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">add</span> Add Rule
          </button>
        </div>
        <table v-if="defaultRules.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">API Groups</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Resources</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Verbs</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant w-24">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="(rule, idx) in defaultRules" :key="idx" class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="flex flex-wrap gap-xs">
                  <span v-for="g in rule.apiGroups" :key="g" class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant font-mono">
                    {{ g || '(core)' }}
                  </span>
                </div>
              </td>
              <td class="px-lg py-md">
                <div class="flex flex-wrap gap-xs">
                  <span v-for="r in rule.resources" :key="r" class="px-2 py-0.5 bg-primary-container/10 text-primary rounded text-label-caps font-mono">
                    {{ r }}
                  </span>
                </div>
              </td>
              <td class="px-lg py-md">
                <div class="flex flex-wrap gap-xs">
                  <span v-for="v in rule.verbs" :key="v" class="px-2 py-0.5 bg-secondary-container/10 text-secondary rounded text-label-caps">
                    {{ v }}
                  </span>
                </div>
              </td>
              <td class="px-lg py-md">
                <div class="flex gap-xs">
                  <button @click="openEditRule(idx)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
                    <span class="material-symbols-outlined text-lg">edit</span>
                  </button>
                  <button @click="deleteRule(idx)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg">
                    <span class="material-symbols-outlined text-lg">delete</span>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">admin_panel_settings</span>
          <p class="mt-sm">No policy rules defined</p>
        </div>
      </div>
    </div>

    <!-- Bindings Tab -->
    <div v-if="activeTab === 'bindings'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low">
          <h3 class="text-headline-sm">RoleBindings ({{ roleBindings.length }})</h3>
        </div>
        <table v-if="roleBindings.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Namespace</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Role Kind</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Subjects</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="rb in roleBindings" :key="rb.name" class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">link</span>
                  <span class="font-mono text-code-sm font-semibold text-on-surface">{{ rb.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ rb.namespace }}</td>
              <td class="px-lg py-md">
                <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">{{ rb.roleKind }}</span>
              </td>
              <td class="px-lg py-md">
                <div class="flex flex-wrap gap-xs">
                  <span v-for="(subj, si) in rb.subjects" :key="si" class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary rounded text-label-caps">
                    {{ subj.kind }}: {{ subj.name }}
                  </span>
                </div>
              </td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ rb.age }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="p-xl text-center text-on-surface-variant">
          <span class="material-symbols-outlined text-3xl">link_off</span>
          <p class="mt-sm">No RoleBindings reference this role</p>
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
    <h2 class="text-headline-lg text-on-surface mt-md">Role Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">Role "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to RBAC</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Role" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete <span class="text-on-surface font-semibold">{{ role?.scope === 'Cluster' ? 'ClusterRole' : 'Role' }}</span> <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">All RoleBindings referencing this role will become invalid. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Edit Rule Modal -->
  <Modal v-model="showEditRuleModal" :title="editingRuleIndex === -1 ? 'Add Rule' : 'Edit Rule'" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">API Groups (comma-separated)</label>
        <input v-model="editForm.apiGroups" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder='e.g. "", apps, batch' />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Resources (comma-separated)</label>
        <input v-model="editForm.resources" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="e.g. pods, deployments, secrets" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Verbs (comma-separated)</label>
        <input v-model="editForm.verbs" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="e.g. get, list, watch, create, delete" />
      </div>
    </div>
    <template #actions>
      <button @click="showEditRuleModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveRuleEdit" :disabled="!editForm.verbs && !editForm.resources" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Save</button>
    </template>
  </Modal>
</template>
