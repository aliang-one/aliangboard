<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import DataTable from '@/components/common/DataTable.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

// 主资源 role + 关联 rolebindings 走 Vue Query（15s/30s 轮询）；store CRUD 已接 invalidateResource，编辑后自动刷新。
const cid = computed(() => (store.currentCluster || 'cluster'))
const roleDetail = useResourceDetail({
  key: ['cluster', cid, 'roles', route.params.name],
  fetcher: () => store.fetchRole(route.params.name, route.params.namespace),
  options: { refetchInterval: 15000 },
})
const role = computed(() => roleDetail.data.value)
const roleBindingsQuery = useResourceList({
  key: ['cluster', cid, 'rolebindings'],
  fetcher: () => store.fetchRoleBindings(),
  options: { refetchInterval: 30000 },
})
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(route.params.namespace)}/roles/${encodeURIComponent(route.params.name)}`,
})

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

// RoleBindings referencing this role (filtered from rolebindings query by namespace + roleName)
const roleBindings = computed(() => {
  if (!role.value) return []
  return (roleBindingsQuery.data.value || []).filter(rb =>
    rb.namespace === route.params.namespace && rb.roleName === role.value.name
  )
})

// —— 裸表迁 DataTable(Wave5 B2,审计 #233/#291):手机自动卡片化(首列=标题),列 slot 双分支同源 ——
// rules 无唯一键(同名 rule 可重复)→ 注入 _idx 作 row-key;openEditRule/deleteRule 按 _idx 回写 defaultRules
const ruleRows = computed(() => defaultRules.value.map((r, idx) => ({ ...r, _idx: idx })))
const ruleHeaders = computed(() => [
  { key: 'apiGroups', label: t('ns.roleDetail.apiGroupsLabel') },
  { key: 'resources', label: t('ns.roleDetail.resourcesLabel') },
  { key: 'verbs', label: t('ns.roleDetail.verbsLabel') },
  { key: 'actions', label: t('common.actions') },
])
const bindingHeaders = computed(() => [
  { key: 'name', label: t('common.name') },
  { key: 'namespace', label: t('common.namespace') },
  { key: 'roleKind', label: t('ns.roleDetail.roleKind') },
  { key: 'subjects', label: t('ns.roleDetail.subjects') },
  { key: 'age', label: t('common.age') },
])

async function handleDelete() {
  await store.deleteRole(route.params.name, route.params.namespace)
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
    <div class="flex flex-wrap items-start justify-between gap-x-sm gap-y-sm mt-sm mb-xl">
      <div class="flex items-center gap-lg min-w-0">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-secondary text-3xl">admin_panel_settings</span>
        </div>
        <div class="min-w-0">
          <h1 class="text-display-lg text-on-surface min-w-0 max-sm:truncate" :title="role.name">{{ role.name }}</h1>
          <div class="flex items-center gap-md mt-xs flex-wrap">
            <span class="px-2.5 py-0.5 rounded-full text-label-caps font-medium" :class="scopeBadge.color">
              {{ scopeBadge.label }}
            </span>
            <span v-if="role.namespace" class="text-body-sm text-on-surface-variant">{{ t('common.namespace') }}: <span class="text-primary font-medium break-all">{{ role.namespace }}</span></span>
            <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleDetail.bindings') }}: <span class="font-mono font-bold text-on-surface">{{ role.bindings }}</span></span>
          </div>
        </div>
      </div>
      <div class="flex flex-wrap gap-sm">
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors max-sm:min-h-[40px]">
          <span class="material-symbols-outlined">delete</span> {{ t('common.delete') }}
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex overflow-x-auto border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'rules', 'bindings', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors shrink-0 whitespace-nowrap"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">{{ t('ns.roleDetail.roleDetails') }}</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('common.name') }}</p>
              <p class="font-mono text-code-sm text-on-surface font-semibold break-all">{{ role.name }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.roleDetail.scope') }}</p>
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-lg" :class="role.scope === 'Cluster' ? 'text-primary' : 'text-secondary'">{{ role.scope === 'Cluster' ? 'public' : 'lock' }}</span>
                <span class="text-body-md font-semibold" :class="role.scope === 'Cluster' ? 'text-primary' : 'text-on-surface'">{{ role.scope === 'Cluster' ? 'Cluster' : 'Namespace' }}</span>
              </div>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('common.namespace') }}</p>
              <p v-if="role.namespace" class="font-mono text-code-sm text-primary break-all">{{ role.namespace }}</p>
              <p v-else class="text-body-sm text-on-surface-variant">{{ t('ns.roleDetail.clusterWide') }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.roleDetail.bindings') }}</p>
              <p class="font-mono text-code-sm text-primary font-semibold">{{ role.bindings }}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('ns.roleDetail.summary') }}</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleDetail.kindLabel') }}</span>
              <span class="text-body-md font-semibold text-on-surface">{{ role.scope === 'Cluster' ? 'ClusterRole' : 'Role' }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleDetail.rulesLabel') }}</span>
              <span class="text-body-md font-semibold text-primary">{{ defaultRules.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleDetail.roleBindingsLabel') }}</span>
              <span class="text-body-md font-semibold text-on-surface">{{ roleBindings.length }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleDetail.apiVersionLabel') }}</span>
              <span class="text-body-sm font-mono text-on-surface-variant">rbac.authorization.k8s.io/v1</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Rules Tab -->
    <div v-if="activeTab === 'rules'" class="flex flex-col gap-md">
      <div class="flex items-center justify-between">
        <h3 class="text-headline-sm">{{ t('ns.roleDetail.policyRulesCount', { count: defaultRules.length }) }}</h3>
        <button @click="openAddRule" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 max-sm:min-h-[40px]">
          <span class="material-symbols-outlined text-sm">add</span> {{ t('ns.roleDetail.addRule') }}
        </button>
      </div>
      <DataTable v-if="ruleRows.length" :headers="ruleHeaders" :rows="ruleRows" row-key="_idx">
        <template #apiGroups="{ row }">
          <div class="flex flex-wrap gap-xs">
            <span v-for="g in row.apiGroups" :key="g" class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant font-mono">
              {{ g || '(core)' }}
            </span>
          </div>
        </template>
        <template #resources="{ row }">
          <div class="flex flex-wrap gap-xs">
            <span v-for="r in row.resources" :key="r" class="px-2 py-0.5 bg-primary-container/10 text-primary rounded text-label-caps font-mono">
              {{ r }}
            </span>
          </div>
        </template>
        <template #verbs="{ row }">
          <div class="flex flex-wrap gap-xs">
            <span v-for="v in row.verbs" :key="v" class="px-2 py-0.5 bg-secondary-container/10 text-secondary rounded text-label-caps">
              {{ v }}
            </span>
          </div>
        </template>
        <template #actions="{ row }">
          <div class="flex gap-xs">
            <button @click="openEditRule(row._idx)" :title="t('common.edit')" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
              <span class="material-symbols-outlined text-lg">edit</span>
            </button>
            <button @click="deleteRule(row._idx)" :title="t('common.delete')" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
              <span class="material-symbols-outlined text-lg">delete</span>
            </button>
          </div>
        </template>
      </DataTable>
      <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center text-on-surface-variant">
        <span class="material-symbols-outlined text-3xl">admin_panel_settings</span>
        <p class="mt-sm">{{ t('ns.roleDetail.noPolicyRules') }}</p>
      </div>
    </div>

    <!-- Bindings Tab -->
    <div v-if="activeTab === 'bindings'" class="flex flex-col gap-md">
      <h3 class="text-headline-sm">{{ t('ns.roleDetail.roleBindingsCount', { count: roleBindings.length }) }}</h3>
      <DataTable v-if="roleBindings.length" :headers="bindingHeaders" :rows="roleBindings" row-key="name">
        <template #name="{ row }">
          <div class="flex items-center gap-sm min-w-0">
            <span class="material-symbols-outlined text-secondary text-lg shrink-0">link</span>
            <span class="font-mono text-code-sm font-semibold text-on-surface truncate" :title="row.name">{{ row.name }}</span>
          </div>
        </template>
        <template #namespace="{ row }"><span class="block font-mono text-code-sm text-on-surface-variant truncate" :title="row.namespace">{{ row.namespace }}</span></template>
        <template #roleKind="{ row }">
          <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">{{ row.roleKind }}</span>
        </template>
        <template #subjects="{ row }">
          <div class="flex flex-wrap gap-xs">
            <span v-for="(subj, si) in row.subjects" :key="si" class="px-2 py-0.5 bg-tertiary-container/10 text-tertiary rounded text-label-caps">
              {{ subj.kind }}: {{ subj.name }}
            </span>
          </div>
        </template>
        <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      </DataTable>
      <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center text-on-surface-variant">
        <span class="material-symbols-outlined text-3xl">link_off</span>
        <p class="mt-sm">{{ t('ns.roleDetail.noRoleBindings') }}</p>
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
    <h2 class="text-headline-md text-on-surface mt-md">{{ t('common.notFound', { name: 'Role' }) }}</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">{{ t('ns.roleDetail.notFoundMsg', { name: route.params.name, namespace: route.params.namespace }) }}</p>
    <button @click="router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('common.backTo', { name: 'RBAC' }) }}</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="t('common.deleteTitle', { name: 'Role' })" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('common.confirmDelete', { type: role?.scope === 'Cluster' ? 'ClusterRole' : 'Role', name: route.params.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.roleDetail.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>

  <!-- Edit Rule Modal -->
  <Modal v-model="showEditRuleModal" :title="editingRuleIndex === -1 ? t('common.addTitle', { name: 'Rule' }) : t('common.editTitle', { name: 'Rule' })" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.roleDetail.apiGroupsHint') }}</label>
        <input v-model="editForm.apiGroups" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder='e.g. "", apps, batch' />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.roleDetail.resourcesHint') }}</label>
        <input v-model="editForm.resources" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="e.g. pods, deployments, secrets" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.roleDetail.verbsHint') }}</label>
        <input v-model="editForm.verbs" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="e.g. get, list, watch, create, delete" />
      </div>
    </div>
    <template #actions>
      <button @click="showEditRuleModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="saveRuleEdit" :disabled="!editForm.verbs && !editForm.resources" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('common.save') }}</button>
    </template>
  </Modal>
</template>
