<script setup>
// 用户管理（admin only）：用户 CRUD + 分配集群
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi, authApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useTableColumns } from '@/composables/useTableColumns'
import Modal from '@/components/common/Modal.vue'
import DataTable from '@/components/common/DataTable.vue'
import { useRequiredFields } from '@/composables/useRequiredFields'

const { t } = useI18n()
const { tableColumns } = useTableColumns()
const users = ref([])
const allClusters = ref([])
const loading = ref(true)
const showCreateModal = ref(false)
const showAssignModal = ref(false)
const showResetModal = ref(false)
const targetUser = ref(null)
const createForm = ref({ username: '', password: '', role: 'user', displayName: '' })
const resetForm = ref({ newPassword: '' })
const assignClusterIds = ref([])
const { errors: createErrors, validate: validateCreate, clear: clearCreateError, reset: resetCreateErrors } = useRequiredFields()
const { errors: resetErrors, validate: validateReset, clear: clearResetError, reset: resetResetErrors } = useRequiredFields()

async function load() {
  loading.value = true
  try {
    const [u, c] = await Promise.all([adminApi.users.list(), adminApi.clusters.list()])
    users.value = u.users || []
    allClusters.value = c.clusters || []
  } catch (e) { notify('error', e.message || t('common.loadFailed')) }
  finally { loading.value = false }
}
onMounted(load)

async function doCreate() {
  if (!validateCreate(createForm.value, ['username', 'password'])) { notify('error', t('admin.users.missingRequired')); return }
  try {
    await adminApi.users.create({ ...createForm.value, username: createForm.value.username.trim(), displayName: createForm.value.displayName.trim() })
    notify('success', t('admin.users.created', { name: createForm.value.username.trim() }))
    showCreateModal.value = false
    createForm.value = { username: '', password: '', role: 'user', displayName: '' }
    resetCreateErrors()
    load()
  } catch (e) { notify('error', e.message || t('common.createFailed')) }
}
async function doDelete(u) {
  if (!confirm(t('admin.users.deleteConfirm', { name: u.username }))) return
  try { await adminApi.users.remove(u.id); notify('success', t('common.deleted')); load() }
  catch (e) { notify('error', e.message || t('common.deleteFailed')) }
}
async function toggleDisable(u) {
  try { await adminApi.users.patch(u.id, { disabled: u.disabled ? 0 : 1 }); notify('success', u.disabled ? t('common.enabled') : t('common.disabled')); load() }
  catch (e) { notify('error', e.message || t('common.opFailed')) }
}
function openAssign(u) { targetUser.value = u; assignClusterIds.value = [...(u.clusterIds || [])]; showAssignModal.value = true }
async function doAssign() {
  try { await adminApi.users.assignClusters(targetUser.value.id, assignClusterIds.value); notify('success', t('admin.users.assignUpdated')); showAssignModal.value = false; load() }
  catch (e) { notify('error', e.message || t('admin.users.assignFailed')) }
}
function openReset(u) { targetUser.value = u; resetForm.value = { newPassword: '' }; resetResetErrors(); showResetModal.value = true }
async function doReset() {
  if (!validateReset(resetForm.value, ['newPassword'])) { notify('error', t('admin.users.missingRequired')); return }
  try { await adminApi.users.resetPassword(targetUser.value.id, resetForm.value.newPassword); notify('success', t('admin.users.passwordReset')); showResetModal.value = false }
  catch (e) { notify('error', e.message || t('admin.users.resetFailed')) }
}
function clusterName(id) { return allClusters.value.find(c => c.id === id)?.name || id.slice(0, 8) }

const headers = computed(() => tableColumns('userMgmt'))
</script>

<template>
  <section class="animate-fade-in p-md">
    <div class="flex items-center justify-between mb-md">
      <div><h2 class="text-headline-lg font-bold text-on-surface">{{ $t('admin.users.title') }}</h2><p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('admin.users.subtitle') }}</p></div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
        <span class="material-symbols-outlined text-sm">person_add</span> {{ $t('admin.users.addUser') }}
      </button>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <DataTable v-else :headers="headers" :rows="users" column-key="userMgmt" row-key="id">
      <template #username="{ row }"><span class="font-mono text-body-sm font-medium">{{ row.username }}</span></template>
      <template #role="{ row }"><span class="px-1.5 py-0.5 rounded text-body-xs font-medium" :class="row.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant'">{{ row.role }}</span></template>
      <template #displayName="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.displayName || '—' }}</span></template>
      <template #assignedClusters="{ row }"><span class="text-body-xs text-on-surface-variant">{{ $t('admin.users.clusterCount', { n: (row.clusterIds || []).length, list: (row.clusterIds || []).map(clusterName).join(', ') || $t('common.none') }) }}</span></template>
      <template #status="{ row }"><span :class="row.disabled ? 'text-error' : 'text-status-running'" class="text-body-xs font-medium">{{ row.disabled ? $t('admin.users.disabled') : $t('admin.users.active') }}</span></template>
      <template #actions="{ row }">
        <div class="flex items-center justify-end gap-xs">
          <button @click.stop="openAssign(row)" class="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="$t('admin.users.assignClusters')"><span class="material-symbols-outlined text-base">share</span></button>
          <button @click.stop="openReset(row)" class="p-1 rounded hover:bg-tertiary-container/10 text-on-surface-variant hover:text-tertiary-container relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="$t('admin.users.resetPassword')"><span class="material-symbols-outlined text-base">key</span></button>
          <button @click.stop="toggleDisable(row)" class="p-1 rounded hover:bg-surface-container text-on-surface-variant relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="row.disabled ? $t('admin.users.enable') : $t('admin.users.disable')"><span class="material-symbols-outlined text-base">{{ row.disabled ? 'check_circle' : 'block' }}</span></button>
          <button @click.stop="doDelete(row)" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="$t('common.delete')"><span class="material-symbols-outlined text-base">delete</span></button>
        </div>
      </template>
    </DataTable>

    <!-- 创建用户 Modal -->
    <Modal v-model="showCreateModal" :title="$t('admin.users.addUser')" width="max-w-md">
      <div class="flex flex-col gap-md">
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.users.colUsername') }} <span class="text-error">*</span></label><input v-model="createForm.username" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono', createErrors.username ? 'border-error' : 'border-outline-variant']" @input="clearCreateError('username')" />
          <p v-if="createErrors.username" data-testid="form-error-username" class="text-body-xs text-error mt-xs">{{ $t('common.requiredHint') }}</p>
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.users.password') }} <span class="text-error">*</span></label><input v-model="createForm.password" type="password" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm', createErrors.password ? 'border-error' : 'border-outline-variant']" @input="clearCreateError('password')" />
          <p v-if="createErrors.password" data-testid="form-error-password" class="text-body-xs text-error mt-xs">{{ $t('common.requiredHint') }}</p>
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.users.displayNameOptional') }}</label><input v-model="createForm.displayName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('common.role') }}</label>
          <div class="flex gap-xs">
            <button @click="createForm.role = 'user'" class="px-md py-sm rounded-lg border text-body-sm" :class="createForm.role === 'user' ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'">{{ $t('admin.users.roleUser') }}</button>
            <button @click="createForm.role = 'admin'" class="px-md py-sm rounded-lg border text-body-sm" :class="createForm.role === 'admin' ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'">{{ $t('admin.users.roleAdmin') }}</button>
          </div>
        </div>
      </div>
      <template #actions>
        <button @click="showCreateModal = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ $t('common.cancel') }}</button>
        <button @click="doCreate" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ $t('common.create') }}</button>
      </template>
    </Modal>

    <!-- 分配集群 Modal -->
    <Modal v-model="showAssignModal" :title="$t('admin.users.assignClustersTitle', { name: targetUser?.username || '' })" width="max-w-lg">
      <div class="flex flex-col gap-xs">
        <label v-for="c in allClusters" :key="c.id" class="flex items-center gap-sm px-md py-sm rounded-lg border border-outline-variant hover:bg-surface-container-low cursor-pointer">
          <input type="checkbox" :value="c.id" v-model="assignClusterIds" class="h-4 w-4 accent-primary" />
          <span class="font-mono text-body-sm">{{ c.name }}</span>
          <span class="text-body-xs text-on-surface-variant ml-auto">{{ c.version }}</span>
        </label>
        <p v-if="!allClusters.length" class="text-body-sm text-on-surface-variant text-center py-sm">{{ $t('admin.users.noClustersToAssign') }}</p>
      </div>
      <template #actions>
        <button @click="showAssignModal = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ $t('common.cancel') }}</button>
        <button @click="doAssign" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ $t('admin.users.saveAssignment') }}</button>
      </template>
    </Modal>

    <!-- 重置密码 Modal -->
    <Modal v-model="showResetModal" :title="$t('admin.users.resetPasswordTitle', { name: targetUser?.username || '' })" width="max-w-sm">
      <input v-model="resetForm.newPassword" type="password" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm', resetErrors.newPassword ? 'border-error' : 'border-outline-variant']" :placeholder="$t('admin.users.newPassword')" @input="clearResetError('newPassword')" />
      <p v-if="resetErrors.newPassword" data-testid="form-error-newPassword" class="text-body-xs text-error mt-xs">{{ $t('common.requiredHint') }}</p>
      <template #actions>
        <button @click="showResetModal = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ $t('common.cancel') }}</button>
        <button @click="doReset" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ $t('admin.users.reset') }}</button>
      </template>
    </Modal>
  </section>
</template>
