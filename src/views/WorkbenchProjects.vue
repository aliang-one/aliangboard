<script setup>
// 项目卡片网格(工作台 V2 P1):替代 WorkbenchList 的列表视图。
// 每张卡显示项目名/简介/ns/manifests/reconcile;点击 → WorkbenchDetail。
import { ref, onMounted, watch } from 'vue'
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
const props = defineProps({ openCreate: { type: Boolean, default: false } })
// 顶栏胶囊快捷区「新建项目」(/workbench?create=1):进页即开创建弹窗
watch(() => props.openCreate, v => { if (v) showCreate.value = true }, { immediate: true })
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

const clusterName = id => clusters.value.find(c => c.id === id)?.name || (id ? id.slice(0, 8) : '')

// 无集群项目(2026-08-30):卡片就地换绑/解绑('' = 未绑定),成功后刷新列表
async function bindCluster(p, v) {
  try {
    await workbenchApi.updateProjectCluster(p.id, v)
    notify('success', t('workbench.bindClusterSaved'))
    load()
  } catch (e) { notify('error', e.message || t('workbench.card.loadFailed')) }
}
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
            <p v-if="p.clusterId" class="text-body-xs text-on-surface-variant">{{ clusterName(p.clusterId) }}</p>
            <span v-else data-test="unbound-badge" class="inline-block px-1.5 py-0.5 rounded bg-warning/10 text-warning text-body-xs">{{ t('workbench.unboundBadge') }}</span>
          </div>
          <span class="material-symbols-outlined text-on-surface-variant/30 group-hover:text-primary transition-colors">arrow_forward</span>
        </div>
        <!-- 换绑下拉(无集群项目也可事后绑定;整卡 click 进详情,须 stop) -->
        <select data-test="bind-cluster" :value="p.clusterId || ''" @click.stop @change="bindCluster(p, $event.target.value)"
          class="mb-sm bg-surface-container-low border border-outline-variant rounded px-xs py-0.5 text-body-xs text-on-surface-variant">
          <option value="">{{ t('workbench.unboundBadge') }}</option>
          <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
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
            <option value="">{{ t('workbench.card.noClusterOption') }}</option>
            <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
      </div>
      <template #actions>
        <button @click="showCreate = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="createProject" :disabled="!form.name.trim()" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ t('common.confirm') }}</button>
      </template>
    </Modal>
  </div>
</template>
