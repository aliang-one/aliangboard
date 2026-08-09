<script setup>
// 项目卡片网格(工作台 V2 P1):替代 WorkbenchList 的列表视图。
// 每张卡显示项目名/简介/ns/manifests/reconcile;点击 → WorkbenchDetail。
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { workbenchApi, authApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'

const router = useRouter()
const { t } = useI18n()
const projects = ref([])
const clusters = ref([])
const loading = ref(true)
const showCreate = ref(false)
const form = ref({ name: '', clusterId: '' })

const fmt = ts => ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : null

async function load() {
  loading.value = true
  try {
    const [pr, cr] = await Promise.all([workbenchApi.listProjects(), authApi.myClusters()])
    projects.value = pr.projects || []
    clusters.value = Array.isArray(cr) ? cr : (cr.clusters || [])
  } catch (e) { notify('error', e.message || t('workbench.card.loadFailed')) }
  finally { loading.value = false }
}
onMounted(load)

async function createProject() {
  try {
    await workbenchApi.createProject(form.value)
    showCreate.value = false
    form.value = { name: '', clusterId: '' }
    notify('success', t('workbench.card.created'))
    load()
  } catch (e) { notify('error', e.message || t('workbench.card.createFailed')) }
}

const clusterName = id => clusters.value.find(c => c.id === id)?.name || (id ? id.slice(0, 8) : '-')
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-md">
      <p class="text-on-surface-variant text-body-sm">{{ projects.length }} {{ t('workbench.shell.tabProjects') }}</p>
      <button @click="showCreate = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
        <span class="material-symbols-outlined text-sm">add</span> {{ t('workbench.card.create') }}
      </button>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant">
      <span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span>
    </div>

    <div v-else-if="!projects.length" class="py-xl text-center">
      <span class="material-symbols-outlined text-4xl text-on-surface-variant/30">folder_off</span>
      <p class="text-on-surface-variant mt-sm">{{ t('workbench.card.noProjects') }}</p>
    </div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
      <div v-for="p in projects" :key="p.id"
        @click="router.push('/workbench/' + p.id)"
        class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md cursor-pointer hover:border-primary/40 hover:shadow-md transition-all group">
        <!-- Name + cluster -->
        <div class="flex items-start justify-between mb-sm">
          <div>
            <h3 class="text-body-md font-bold text-on-surface group-hover:text-primary transition-colors">{{ p.name }}</h3>
            <p class="text-body-xs text-on-surface-variant">{{ clusterName(p.clusterId) }}</p>
          </div>
          <span class="material-symbols-outlined text-on-surface-variant/30 group-hover:text-primary transition-colors">arrow_forward</span>
        </div>
        <!-- Attribute chips -->
        <div class="flex flex-wrap gap-xs mb-sm">
          <span class="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-body-xs font-mono">{{ p.namespace || p.boundSA_namespace || 'default' }}</span>
          <span class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant text-body-xs">{{ t('workbench.card.manifests') }}: {{ p.manifestCount ?? '?' }}</span>
        </div>
        <!-- Reconcile status -->
        <div class="flex items-center gap-xs text-body-xs text-on-surface-variant">
          <span v-if="p.lastReconcile" class="flex items-center gap-0.5">
            <span class="w-1.5 h-1.5 rounded-full bg-status-running"></span>
            {{ t('workbench.card.reconciled') }}: {{ fmt(p.lastReconcile) }}
          </span>
          <span v-else class="flex items-center gap-0.5">
            <span class="w-1.5 h-1.5 rounded-full bg-on-surface-variant/30"></span>
            {{ t('workbench.card.neverReconciled') }}
          </span>
        </div>
      </div>
    </div>

    <!-- Create Modal -->
    <Modal v-model="showCreate" :title="t('workbench.card.create')" width="max-w-md">
      <div class="flex flex-col gap-md">
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.card.nameLabel') }}</label>
          <input v-model="form.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="my-project" />
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.card.selectCluster') }}</label>
          <select v-model="form.clusterId" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
            <option value="" disabled>{{ t('workbench.card.selectCluster') }}</option>
            <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
      </div>
      <template #actions>
        <button @click="showCreate = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="createProject" :disabled="!form.name.trim() || !form.clusterId" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ t('common.confirm') }}</button>
      </template>
    </Modal>
  </div>
</template>
