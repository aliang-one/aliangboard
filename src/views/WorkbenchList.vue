<script setup>
// 工作台项目列表(W2):任意平台用户,项目按 userId 归属。新建项目(绑集群)→ repo 初始化。
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { workbenchApi, authApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import DataTable from '@/components/common/DataTable.vue'

const router = useRouter()
const { t } = useI18n()
const projects = ref([])
const clusters = ref([])
const loading = ref(true)
const showCreate = ref(false)
const form = ref({ name: '', clusterId: '' })

const fmt = ts => ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'
const headers = [
  { key: 'name', label: t('workbench.list.tableProject') },
  { key: 'cluster', label: t('workbench.list.tableCluster') },
  { key: 'created', label: t('workbench.list.tableCreated') },
  { key: 'actions', label: '', align: 'right' },
]

async function load() {
  loading.value = true
  try {
    const [pr, cr] = await Promise.all([workbenchApi.listProjects(), authApi.myClusters()])
    projects.value = pr.projects || []
    clusters.value = Array.isArray(cr) ? cr : (cr.clusters || [])
  } catch (e) { notify('error', e.message || t('workbench.list.loadingFailed')) }
  finally { loading.value = false }
}
onMounted(load)

async function doCreate() {
  try {
    const res = await workbenchApi.createProject({ name: form.value.name.trim(), clusterId: form.value.clusterId })
    showCreate.value = false
    form.value = { name: '', clusterId: '' }
    notify('success', t('workbench.list.projectCreated'))
    router.push({ name: 'WorkbenchProject', params: { id: res.project.id } })
  } catch (e) { notify('error', e.message || t('workbench.list.createFailed')) }
}
</script>

<template>
  <section class="animate-fade-in p-md">
    <div class="flex items-center justify-between mb-md">
      <div>
        <h2 class="text-headline-lg font-bold text-on-surface flex items-center gap-sm">
          <span class="material-symbols-outlined">workspaces</span> {{ t('workbench.list.title') }}
        </h2>
        <p class="text-body-sm text-on-surface-variant mt-xs" v-html="t('workbench.list.subtitle')"></p>
      </div>
      <div class="flex items-center gap-sm">
        <button @click="router.push({ name: 'WorkbenchLedger' })" class="flex items-center gap-xs px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">
          <span class="material-symbols-outlined text-sm">menu_book</span> {{ t('workbench.list.clusterLedger') }}
        </button>
        <button @click="showCreate = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
          <span class="material-symbols-outlined text-sm">add</span> {{ t('workbench.list.newProject') }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <DataTable v-else :headers="headers" :rows="projects">
      <template #name="{ row }"><span class="text-body-sm font-semibold text-primary">{{ row.name }}</span></template>
      <template #cluster="{ row }"><span class="text-body-sm">{{ row.clusterName || (row.clusterId ? row.clusterId.slice(0, 8) : '-') }}</span></template>
      <template #created="{ row }"><span class="text-body-xs text-on-surface-variant">{{ fmt(row.createdAt) }}</span></template>
      <template #actions="{ row }">
        <button @click.stop="router.push({ name: 'WorkbenchProject', params: { id: row.id } })" class="p-1 rounded hover:bg-surface-container text-on-surface-variant hover:text-primary" title="Open"><span class="material-symbols-outlined text-base">folder_open</span></button>
      </template>
    </DataTable>

    <Modal v-model="showCreate" :title="t('workbench.list.createModalTitle')" width="max-w-md">
      <div class="flex flex-col gap-md">
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.list.projectNameLabel') }}</label>
          <input v-model="form.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="ci-cd-system" />
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.list.bindClusterLabel') }}</label>
          <select v-model="form.clusterId" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
            <option value="" disabled>{{ t('workbench.list.selectCluster') }}</option>
            <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }} ({{ c.apiServer }})</option>
          </select>
          <p v-if="!clusters.length" class="text-body-xs text-status-warning mt-xs" v-html="t('workbench.list.noClusterHint')"></p>
        </div>
      </div>
      <template #actions>
        <button @click="showCreate = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('workbench.list.cancel') }}</button>
        <button @click="doCreate" :disabled="!form.name.trim() || !form.clusterId" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ t('workbench.list.create') }}</button>
      </template>
    </Modal>
  </section>
</template>
