<script setup>
// 项目卡片网格(工作台 V2 P1):替代 WorkbenchList 的列表视图。
// 每张卡显示项目名/简介/ns/manifests/reconcile;点击 → WorkbenchDetail。
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { workbenchApi, authApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import DropdownMenu from '@/components/common/DropdownMenu.vue'

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

// ═══ 项目卡片菜单(2026-09-01 可见性修复):重命名/删除入口从死组件 WorkbenchList 移植 ═══
// 形态裁决(spec §6):行内 blur 重命名 → 弹窗确认式;busy 防重替代 enter/blur 竞态守卫。
const showRename = ref(false)
const renameTarget = ref(null)
const renameText = ref('')
const renameBusy = ref(false)
function startRename(p) {
  renameTarget.value = p
  renameText.value = p.name || ''
  showRename.value = true
}
async function confirmRename() {
  if (!showRename.value || renameBusy.value) return
  const name = renameText.value.trim()
  if (!name) return                                    // 空名不发请求(确定钮同时禁用)
  if (name === renameTarget.value.name) { showRename.value = false; return }
  renameBusy.value = true
  try {
    await workbenchApi.updateProject(renameTarget.value.id, { name })
    const p = projects.value.find(x => x.id === renameTarget.value.id)
    if (p) p.name = name
    notify('success', t('workbench.card.projectRenamed', { name }))
    showRename.value = false
  } catch (e) {
    // 失败保留弹窗与输入可重试;透传服务端消息(与死组件/WorkbenchChat 同款)
    notify('error', e?.message || t('workbench.card.projectRenameFailed'))
  } finally { renameBusy.value = false }
}

// 删除:确认名与项目名(trim 后)一致才启用确定。M1:两侧都 trim——项目名可含首尾空白,
// 只比原文会让这类项目永远删不掉。deleteBusy(M2):删除在途拦第二次提交,否则双击的
// 第二发落在已删项目上 → 404 → 用户看到假「删除失败」。
const deleteTarget = ref(null)
const deleteConfirmText = ref('')
const deleteBusy = ref(false)
const deleteConfirmed = computed(() =>
  !!deleteTarget.value && deleteConfirmText.value.trim() === deleteTarget.value.name.trim())
function startDelete(p) {
  deleteTarget.value = p
  deleteConfirmText.value = ''
}
async function doDelete() {
  if (!deleteTarget.value || deleteBusy.value || !deleteConfirmed.value) return
  deleteBusy.value = true
  try {
    const res = await workbenchApi.deleteProject(deleteTarget.value.id, deleteConfirmText.value.trim())
    projects.value = projects.value.filter(x => x.id !== deleteTarget.value.id)
    deleteTarget.value = null
    // repo 目录清除失败时后端仍 200,但带 warning(数据已级联删、目录成孤儿):
    // 必须 error 级示警(终审 I2)——只报成功会让孤儿目录永远无人跟进。
    if (res?.warning) notify('error', t('workbench.card.projectDeletedWithWarning', { warning: res.warning }))
    else notify('success', t('workbench.card.projectDeleted'))
  } catch (e) { notify('error', e.message || t('workbench.card.projectDeleteFailed')) }
  finally { deleteBusy.value = false }
}

// 菜单项工厂(Task 2 在此追加删除项)
function cardActions(p) {
  return [
    { label: t('workbench.card.renameProject'), icon: 'edit', action: () => startRename(p) },
    { label: t('workbench.card.deleteProject'), icon: 'delete', danger: true, action: () => startDelete(p) },
  ]
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
          <div class="flex items-center gap-xs">
            <!-- 菜单恒可见低强调(触屏无 hover;hover 时加强),组件自带 stopPropagation 防误触整卡导航 -->
            <DropdownMenu :items="cardActions(p)" :trigger-label="t('workbench.card.projectActions')"
              class="opacity-60 group-hover:opacity-100 transition-opacity" />
            <span class="material-symbols-outlined text-on-surface-variant/30 group-hover:text-primary transition-colors">arrow_forward</span>
          </div>
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

    <!-- Rename Modal(可见性修复):空名禁用;失败保留可重试 -->
    <Modal v-model="showRename" :title="t('workbench.card.renameModalTitle')" width="max-w-md">
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.card.nameLabel') }}</label>
        <input v-model="renameText" data-testid="rename-input" @keyup.enter="confirmRename"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
      </div>
      <template #actions>
        <button @click="showRename = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="confirmRename" :disabled="!renameText.trim() || renameBusy" data-testid="rename-confirm-btn"
          class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ t('common.confirm') }}</button>
      </template>
    </Modal>

    <!-- Delete Modal:确认名逐字一致才启用;两侧 trim 对称;busy 防双发 -->
    <Modal :model-value="!!deleteTarget" @update:model-value="v => { if (!v) deleteTarget = null }"
      :title="t('workbench.card.confirmDeleteTitle')" width="max-w-md">
      <div v-if="deleteTarget" class="flex flex-col gap-md">
        <p class="text-body-sm text-on-surface-variant">{{ t('workbench.card.confirmDeleteHint') }}</p>
        <p><code class="px-sm py-0.5 bg-surface-container rounded text-on-surface font-mono text-body-sm">{{ deleteTarget.name }}</code></p>
        <input v-model="deleteConfirmText" data-testid="delete-confirm-input"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono"
          :placeholder="t('workbench.card.confirmDeletePlaceholder')" />
      </div>
      <template #actions>
        <button @click="deleteTarget = null" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="doDelete" :disabled="!deleteConfirmed || deleteBusy" data-testid="delete-confirm-btn"
          class="px-md py-sm bg-error text-on-error rounded-lg font-semibold disabled:opacity-40">{{ t('workbench.card.deleteProject') }}</button>
      </template>
    </Modal>
  </div>
</template>
