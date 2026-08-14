<script setup>
// 集群管理（admin only）：集群 CRUD（支持 token / 账密 / kubeconfig 三种凭据）
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'
import ClusterCard from '@/components/common/ClusterCard.vue'
import ClusterForm from '@/components/common/ClusterForm.vue'
import { useClusterStore } from '@/stores/cluster'

const { t } = useI18n()
const store = useClusterStore()

const clusters = ref([])
const loading = ref(true)
const showAddModal = ref(false)
const adding = ref(false)
const addForm = ref({ name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false })

async function load(force = false) {
  loading.value = true
  try { const res = await adminApi.clusters.list(force); clusters.value = res.clusters || [] }
  catch (e) { notify('error', e.message || t('admin.clusters.loadFailed')) }
  finally { loading.value = false }
}
onMounted(load)

async function doAdd() {
  adding.value = true
  try {
    // 文本字段 trim(kubeconfig 整块 trim 同样安全——YAML 首尾空白无意义)
    const payload = { ...addForm.value, name: addForm.value.name.trim(), apiServer: addForm.value.apiServer.trim(), token: addForm.value.token.trim(), username: addForm.value.username.trim(), password: addForm.value.password, kubeconfig: addForm.value.kubeconfig.trim() }
    await adminApi.clusters.create(payload)
    notify('success', t('admin.clusters.added', { name: payload.name }))
    showAddModal.value = false
    addForm.value = { name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false }
    load()
  } catch (e) { notify('error', e.message || t('admin.clusters.addFailed')) }
  finally { adding.value = false }
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

    <!-- 添加集群 Modal(表单抽至共享 ClusterForm) -->
    <Modal v-model="showAddModal" :title="$t('admin.clusters.addCluster')" width="max-w-xl">
      <ClusterForm :form="addForm" :submitting="adding" @submit="doAdd" @cancel="showAddModal = false" />
    </Modal>
  </section>
</template>
