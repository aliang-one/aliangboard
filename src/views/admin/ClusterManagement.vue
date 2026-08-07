<script setup>
// 集群管理（admin only）：集群 CRUD（支持 token / 账密 / kubeconfig 三种凭据）
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'
import ClusterCard from '@/components/common/ClusterCard.vue'
import { useClusterStore } from '@/stores/cluster'

const { t } = useI18n()
const store = useClusterStore()

const clusters = ref([])
const loading = ref(true)
const showAddModal = ref(false)
const addForm = ref({ name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false })

async function load(force = false) {
  loading.value = true
  try { const res = await adminApi.clusters.list(force); clusters.value = res.clusters || [] }
  catch (e) { notify('error', e.message || t('admin.clusters.loadFailed')) }
  finally { loading.value = false }
}
onMounted(load)

async function doAdd() {
  try {
    await adminApi.clusters.create(addForm.value)
    notify('success', t('admin.clusters.added', { name: addForm.value.name }))
    showAddModal.value = false
    addForm.value = { name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false }
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
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.clusters.clusterName') }}</label><input v-model="addForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="prod-cluster" /></div>
        <!-- 凭据方式切换 -->
        <div class="flex gap-xs">
          <button v-for="m in [{k:'kubeconfig',l:$t('admin.clusters.authKubeconfig')},{k:'token',l:$t('admin.clusters.authToken')},{k:'basic',l:$t('admin.clusters.authBasic')}]" :key="m.k" @click="addForm.authMethod = m.k"
            class="px-sm py-xs rounded-lg border text-body-sm" :class="addForm.authMethod === m.k ? 'bg-primary text-on-primary border-primary font-semibold' : 'border-outline-variant text-on-surface-variant'">{{ m.l }}</button>
        </div>
        <!-- Kubeconfig -->
        <div v-if="addForm.authMethod === 'kubeconfig'">
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.clusters.pasteKubeconfig') }}</label>
          <textarea v-model="addForm.kubeconfig" rows="8" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="apiVersion: v1&#10;kind: Config&#10;..."></textarea>
        </div>
        <!-- Token -->
        <div v-if="addForm.authMethod === 'token'" class="flex flex-col gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">API Server</label><input v-model="addForm.apiServer" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="https://10.0.0.1:6443" /></div>
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">Bearer Token</label><input v-model="addForm.token" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="eyJhb..." /></div>
        </div>
        <!-- Basic -->
        <div v-if="addForm.authMethod === 'basic'" class="flex flex-col gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">API Server</label><input v-model="addForm.apiServer" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="https://10.0.0.1:6443" /></div>
          <div class="grid grid-cols-2 gap-sm">
            <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.clusters.username') }}</label><input v-model="addForm.username" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
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
