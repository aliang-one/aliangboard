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

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

// 主资源 rolebinding + 关联 role 查找走 Vue Query（15s/30s 轮询）；store CRUD 已接 invalidateResource，编辑后自动刷新。
const cid = computed(() => (store.currentCluster || 'cluster'))
const rbDetail = useResourceDetail({
  key: ['cluster', cid.value, 'rolebindings', route.params.name],
  fetcher: () => store.fetchRoleBinding(route.params.name, route.params.namespace),
  options: { refetchInterval: 15000 },
})
const rb = computed(() => rbDetail.data.value ?? store.getRoleBindingByName(route.params.name, route.params.namespace))
const rolesQuery = useResourceList({
  key: ['cluster', cid.value, 'roles'],
  fetcher: () => store.fetchRoles(),
  options: { refetchInterval: 30000 },
})
const allRoles = computed(() => rolesQuery.data.value || [])
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(route.params.namespace)}/rolebindings/${encodeURIComponent(route.params.name)}`,
})

const activeTab = ref('overview')
const showDeleteModal = ref(false)

// The referenced role — find 镜像 getRoleByName 逻辑：name 匹配 + scope=Cluster 或同 namespace
const referencedRole = computed(() => {
  if (!rb.value) return null
  return (rolesQuery.data.value || []).find(r => r.name === rb.value.roleName && (r.scope === 'Cluster' || r.namespace === rb.value.namespace)) || null
})

async function handleDelete() {
  await store.deleteRoleBinding(route.params.name, route.params.namespace)
  router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })
}

// === 结构化编辑 ===
const showEditModal = ref(false)
const editSubjects = ref([])
const editRoleName = ref('')
const editRoleKind = ref('Role')

function openEdit() {
  editSubjects.value = (rb.value?.subjects || []).map(s => ({ kind: s.kind, name: s.name, namespace: s.namespace || '' }))
  editRoleName.value = rb.value?.roleName || ''
  editRoleKind.value = rb.value?.roleKind || 'Role'
  showEditModal.value = true
}
function addSubject() {
  editSubjects.value.push({ kind: 'User', name: '', namespace: '' })
}
function removeSubject(idx) {
  editSubjects.value.splice(idx, 1)
}
function saveEdit() {
  store.updateRoleBinding(route.params.name, route.params.namespace, {
    subjects: editSubjects.value.map(s => {
      const o = { kind: s.kind, name: s.name }
      if (s.kind === 'ServiceAccount' && s.namespace) o.namespace = s.namespace
      return o
    }),
    roleName: editRoleName.value,
    roleKind: editRoleKind.value,
  })
  showEditModal.value = false
}
</script>

<template>
  <div class="animate-fade-in" v-if="rb">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: t('ns.roleBindingDetail.rbac'), route: `/ns/${route.params.namespace}/rbac` },
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
            <span class="px-2.5 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded-full font-medium">{{ t('ns.roleBindingDetail.roleBinding') }}</span>
            <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleBindingDetail.namespace') }}: <span class="text-primary font-medium">{{ rb.namespace }}</span></span>
            <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleBindingDetail.age') }}: {{ rb.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex gap-sm">
        <button @click="openEdit" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-colors">
          <span class="material-symbols-outlined">edit</span> {{ t('common.edit') }}
        </button>
        <button @click="showDeleteModal = true" class="flex items-center gap-sm px-md py-sm border border-error/30 text-error font-semibold rounded-lg hover:bg-error-container/10 transition-colors">
          <span class="material-symbols-outlined">delete</span> {{ t('common.delete') }}
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'subjects', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab === 'overview' ? t('common.status') : tab === 'subjects' ? t('ns.roleBindingDetail.subjectsTab') : 'YAML' }}
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">{{ t('ns.roleBindingDetail.details') }}</h3>
          <div class="grid grid-cols-2 gap-md">
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.roleBindingDetail.name') }}</p>
              <p class="font-mono text-code-sm text-on-surface font-semibold">{{ rb.name }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.roleBindingDetail.namespace') }}</p>
              <p class="font-mono text-code-sm text-primary">{{ rb.namespace }}</p>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.roleBindingDetail.roleRefKind') }}</p>
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-lg text-secondary">admin_panel_settings</span>
                <span class="text-body-md font-semibold text-on-surface">{{ rb.roleKind }}</span>
              </div>
            </div>
            <div class="p-md rounded-lg bg-surface-container-low">
              <p class="text-label-caps text-on-surface-variant mb-xs">{{ t('ns.roleBindingDetail.roleRefName') }}</p>
              <p class="font-mono text-code-sm text-primary font-semibold">{{ rb.roleName }}</p>
            </div>
          </div>
        </div>

        <!-- RoleRef card -->
        <div v-if="referencedRole" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('ns.roleBindingDetail.referencedRole') }}</h3>
          <div class="flex items-center gap-lg p-md rounded-lg bg-surface-container-low">
            <div class="w-10 h-10 rounded-lg bg-secondary-container/20 flex items-center justify-center">
              <span class="material-symbols-outlined text-secondary text-xl">admin_panel_settings</span>
            </div>
            <div class="flex-1">
              <p class="font-mono text-code-sm text-on-surface font-semibold">{{ referencedRole.name }}</p>
              <div class="flex items-center gap-md mt-xs">
                <span class="px-2 py-0.5 rounded-full text-label-caps font-medium" :class="referencedRole.scope === 'Cluster' ? 'bg-primary-container/20 text-primary' : 'bg-secondary-container/20 text-secondary'">
                  {{ referencedRole.scope === 'Cluster' ? t('ns.roleBindingDetail.clusterRole') : t('ns.roleBindingDetail.role') }}
                </span>
                <span class="text-body-sm text-on-surface-variant">{{ referencedRole.bindings }} {{ t('ns.roleBindingDetail.bindings') }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('ns.roleBindingDetail.summary') }}</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleBindingDetail.kind') }}</span>
              <span class="text-body-md font-semibold text-on-surface">{{ t('ns.roleBindingDetail.roleBinding') }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleBindingDetail.subjects') }}</span>
              <span class="text-body-md font-semibold text-primary">{{ rb.subjects?.length || 0 }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleBindingDetail.roleKind') }}</span>
              <span class="text-body-md text-on-surface">{{ rb.roleKind }}</span>
            </div>
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">{{ t('ns.roleBindingDetail.roleName') }}</span>
              <span class="text-body-md font-mono text-primary">{{ rb.roleName }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('common.age') }}</span>
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
          <h3 class="text-headline-sm">{{ t('ns.roleBindingDetail.subjectsTab') }} {{ t('ns.roleBindingDetail.subjectCount', { n: rb.subjects?.length || 0 }) }}</h3>
        </div>
        <table v-if="rb.subjects?.length" class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('ns.roleBindingDetail.subjectKind') }}</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('ns.roleBindingDetail.subjectName') }}</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">{{ t('ns.roleBindingDetail.subjectNamespace') }}</th>
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
          <p class="mt-sm">{{ t('ns.roleBindingDetail.noSubjects') }}</p>
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
    <h2 class="text-headline-md text-on-surface mt-md">{{ t('ns.roleBindingDetail.notFound') }}</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">{{ t('ns.roleBindingDetail.notFoundDetail', { name: route.params.name, ns: route.params.namespace }) }}</p>
    <button @click="router.push({ name: 'NsRBAC', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('ns.roleBindingDetail.backToRBAC') }}</button>
  </div>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="t('ns.roleBindingDetail.deleteModalTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant" v-html="t('ns.roleBindingDetail.deleteConfirm', { name: route.params.name })"></p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.roleBindingDetail.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>

  <!-- Edit Modal -->
  <Modal v-model="showEditModal" :title="t('ns.roleBindingDetail.editModalTitle')" width="max-w-2xl">
    <div class="flex flex-col gap-lg">
      <!-- RoleRef -->
      <div class="flex flex-col gap-md">
        <h4 class="text-label-caps text-on-surface-variant">{{ t('ns.roleBindingDetail.roleReference') }}</h4>
        <div class="grid grid-cols-3 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.roleBindingDetail.kindLabel') }}</label>
            <select v-model="editRoleKind" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
              <option value="Role">Role</option>
              <option value="ClusterRole">ClusterRole</option>
            </select>
          </div>
          <div class="col-span-2">
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.roleBindingDetail.nameLabel') }}</label>
            <input v-model="editRoleName" list="rb-role-list" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="t('ns.roleBindingDetail.namePlaceholder')" />
            <datalist id="rb-role-list">
              <option v-for="r in allRoles" :key="r.name" :value="r.name" />
            </datalist>
          </div>
        </div>
      </div>

      <!-- Subjects -->
      <div class="flex flex-col gap-md">
        <div class="flex items-center justify-between">
          <h4 class="text-label-caps text-on-surface-variant">{{ t('ns.roleBindingDetail.subjectsLabel') }}</h4>
          <button @click="addSubject" class="flex items-center gap-xs px-md py-xs bg-primary-container/10 text-primary text-body-sm font-semibold rounded-lg hover:bg-primary-container/20 transition-colors">
            <span class="material-symbols-outlined text-base">add</span> {{ t('ns.roleBindingDetail.addSubject') }}
          </button>
        </div>
        <div v-if="editSubjects.length" class="flex flex-col gap-sm divide-y divide-outline-variant/30">
          <div v-for="(s, idx) in editSubjects" :key="idx" class="flex items-end gap-sm pt-sm first:pt-0">
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.roleBindingDetail.kindPlaceholder') }}</label>
              <select v-model="s.kind" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
                <option value="User">User</option>
                <option value="Group">Group</option>
                <option value="ServiceAccount">ServiceAccount</option>
              </select>
            </div>
            <div class="flex-1">
              <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.roleBindingDetail.nameFieldPlaceholder') }}</label>
              <input v-model="s.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="t('ns.roleBindingDetail.nameFieldPlaceholder')" />
            </div>
            <div v-if="s.kind === 'ServiceAccount'" class="flex-1">
              <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.roleBindingDetail.namespacePlaceholder') }}</label>
              <input v-model="s.namespace" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="t('ns.roleBindingDetail.namespacePlaceholder')" />
            </div>
            <button @click="removeSubject(idx)" class="flex items-center justify-center w-10 h-10 mb-px border border-error/30 text-error rounded-lg hover:bg-error-container/10 transition-colors">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </div>
        </div>
        <div v-else class="p-md text-center text-body-sm text-on-surface-variant bg-surface-container-low rounded-lg">
          {{ t('ns.roleBindingDetail.noSubjects') }}
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.save') }}</button>
    </template>
  </Modal>
</template>
