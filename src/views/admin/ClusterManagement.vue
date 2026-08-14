<script setup>
// 集群管理（admin only）：集群 CRUD（支持 token / 账密 / kubeconfig 三种凭据）
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'
import ClusterCard from '@/components/common/ClusterCard.vue'
import { useClusterStore } from '@/stores/cluster'
import { useRequiredFields } from '@/composables/useRequiredFields'

const { t } = useI18n()
const store = useClusterStore()

const clusters = ref([])
const loading = ref(true)
const showAddModal = ref(false)
const addForm = ref({ name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false })
const { errors: addErrors, validate: validateAdd, clear: clearAddError, reset: resetAddErrors } = useRequiredFields()

// 按凭据方式返回必填字段(与服务端 admin.mjs POST /api/admin/clusters 的校验对齐:
// name 恒必填;凭据 kubeconfig/token/basic 各自必填,basic 密码可空)
function requiredForAdd() {
  const byAuth = {
    kubeconfig: ['kubeconfig'],
    token: ['apiServer', 'token'],
    basic: ['apiServer', 'username'],
  }
  return ['name', ...(byAuth[addForm.value.authMethod] || [])]
}

async function load(force = false) {
  loading.value = true
  try { const res = await adminApi.clusters.list(force); clusters.value = res.clusters || [] }
  catch (e) { notify('error', e.message || t('admin.clusters.loadFailed')) }
  finally { loading.value = false }
}
onMounted(load)

async function doAdd() {
  if (!validateAdd(addForm.value, requiredForAdd())) { notify('error', t('admin.clusters.missingRequired')); return }
  try {
    // 文本字段 trim(kubeconfig 整块 trim 同样安全——YAML 首尾空白无意义)
    const payload = { ...addForm.value, name: addForm.value.name.trim(), apiServer: addForm.value.apiServer.trim(), token: addForm.value.token.trim(), username: addForm.value.username.trim(), password: addForm.value.password, kubeconfig: addForm.value.kubeconfig.trim() }
    await adminApi.clusters.create(payload)
    notify('success', t('admin.clusters.added', { name: payload.name }))
    showAddModal.value = false
    addForm.value = { name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false }
    resetAddErrors()
    load()
  } catch (e) { notify('error', e.message || t('admin.clusters.addFailed')) }
}
async function doRemove(c) {
  if (!confirm(t('admin.clusters.deleteConfirm', { name: c.name }))) return
  try { await adminApi.clusters.remove(c.id); notify('success', t('admin.clusters.deleted')); load() }
  catch (e) { notify('error', e.message || t('admin.clusters.deleteFailed')) }
}
</script>

<template>
  <section class="animate-fade-in p-md">
    <div class="flex items-center justify-between mb-md">
      <div><h2 class="text-headline-lg font-bold text-on-surface">{{ $t('admin.clusters.title') }}</h2><p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('admin.clusters.subtitle') }}</p></div>
      <div class="flex items-center gap-sm">
        <button @click="load(true)" :disabled="loading" :title="$t('common.sync')" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          <span class="material-symbols-outlined text-sm" :class="loading ? 'animate-spin' : ''">{{ loading ? 'progress_activity' : 'refresh' }}</span>
          <span class="hidden md:inline">{{ $t('common.sync') }}</span>
        </button>
        <button @click="showAddModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
          <span class="material-symbols-outlined text-sm">add</span> {{ $t('admin.clusters.addCluster') }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <div v-else-if="clusters.length" class="grid grid-cols-1 md:grid-cols-2 gap-md">
      <ClusterCard v-for="c in clusters" :key="c.id" :cluster="c" :active="c.name === store.currentCluster" @remove="doRemove(c)" />
    </div>
    <div v-else class="rounded-xl border border-dashed border-outline-variant/50 py-xl text-center">
      <span class="material-symbols-outlined text-3xl text-surface-container-high">cloud_off</span>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('admin.clusters.emptyHint') }}</p>
    </div>

    <!-- 添加集群 Modal -->
    <Modal v-model="showAddModal" :title="$t('admin.clusters.addCluster')" width="max-w-xl">
      <div class="flex flex-col gap-md">
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.clusters.clusterName') }} <span class="text-error">*</span></label><input v-model="addForm.name" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono', addErrors.name ? 'border-error' : 'border-outline-variant']" placeholder="prod-cluster" @input="clearAddError('name')" />
          <p v-if="addErrors.name" data-testid="form-error-name" class="text-body-xs text-error mt-xs">{{ $t('common.requiredHint') }}</p>
        </div>
        <!-- 凭据方式切换 -->
        <div class="flex gap-xs">
          <button v-for="m in [{k:'kubeconfig',l:$t('admin.clusters.authKubeconfig')},{k:'token',l:$t('admin.clusters.authToken')},{k:'basic',l:$t('admin.clusters.authBasic')}]" :key="m.k" @click="addForm.authMethod = m.k; resetAddErrors()"
            class="px-sm py-xs rounded-lg border text-body-sm" :class="addForm.authMethod === m.k ? 'bg-primary text-on-primary border-primary font-semibold' : 'border-outline-variant text-on-surface-variant'">{{ m.l }}</button>
        </div>
        <!-- Kubeconfig -->
        <div v-if="addForm.authMethod === 'kubeconfig'">
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.clusters.pasteKubeconfig') }} <span class="text-error">*</span></label>
          <textarea v-model="addForm.kubeconfig" rows="8" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary', addErrors.kubeconfig ? 'border-error' : 'border-outline-variant']" placeholder="apiVersion: v1&#10;kind: Config&#10;..." @input="clearAddError('kubeconfig')"></textarea>
          <p v-if="addErrors.kubeconfig" data-testid="form-error-kubeconfig" class="text-body-xs text-error mt-xs">{{ $t('common.requiredHint') }}</p>
        </div>
        <!-- Token -->
        <div v-if="addForm.authMethod === 'token'" class="flex flex-col gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">API Server <span class="text-error">*</span></label><input v-model="addForm.apiServer" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono', addErrors.apiServer ? 'border-error' : 'border-outline-variant']" placeholder="https://10.0.0.1:6443" @input="clearAddError('apiServer')" />
            <p v-if="addErrors.apiServer" data-testid="form-error-apiServer" class="text-body-xs text-error mt-xs">{{ $t('common.requiredHint') }}</p>
          </div>
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">Bearer Token <span class="text-error">*</span></label><input v-model="addForm.token" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono', addErrors.token ? 'border-error' : 'border-outline-variant']" placeholder="eyJhb..." @input="clearAddError('token')" />
            <p v-if="addErrors.token" data-testid="form-error-token" class="text-body-xs text-error mt-xs">{{ $t('common.requiredHint') }}</p>
          </div>
        </div>
        <!-- Basic -->
        <div v-if="addForm.authMethod === 'basic'" class="flex flex-col gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">API Server <span class="text-error">*</span></label><input v-model="addForm.apiServer" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono', addErrors.apiServer ? 'border-error' : 'border-outline-variant']" placeholder="https://10.0.0.1:6443" @input="clearAddError('apiServer')" />
            <p v-if="addErrors.apiServer" data-testid="form-error-apiServer" class="text-body-xs text-error mt-xs">{{ $t('common.requiredHint') }}</p>
          </div>
          <div class="grid grid-cols-2 gap-sm">
            <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.clusters.username') }} <span class="text-error">*</span></label><input v-model="addForm.username" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono', addErrors.username ? 'border-error' : 'border-outline-variant']" @input="clearAddError('username')" />
              <p v-if="addErrors.username" data-testid="form-error-username" class="text-body-xs text-error mt-xs">{{ $t('common.requiredHint') }}</p>
            </div>
            <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.clusters.password') }}</label><input v-model="addForm.password" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
          </div>
        </div>
        <label class="flex items-center gap-sm text-body-sm cursor-pointer"><input type="checkbox" v-model="addForm.insecure" class="h-4 w-4 accent-primary" /> {{ $t('admin.clusters.insecureTls') }}</label>
      </div>
      <template #actions>
        <button @click="showAddModal = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ $t('common.cancel') }}</button>
        <button @click="doAdd" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ $t('admin.clusters.addAndVerify') }}</button>
      </template>
    </Modal>
  </section>
</template>
