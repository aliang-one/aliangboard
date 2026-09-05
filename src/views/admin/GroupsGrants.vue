<script setup>
// W2 Phase A Task 5: admin「组与授权」——左组列表(新建/删除/成员管理),右 ns 授权编辑器(全量替换保存)。
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'

const { t } = useI18n()
const NS_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

const loading = ref(true)
const groups = ref([])
const allClusters = ref([])
const newGroupName = ref('')
const expandedId = ref(null)
const members = ref([])
const memberInput = ref('')
// 授权编辑器状态
const selSubject = ref(null) // group object
const selClusterId = ref('')
const grantRows = ref([]) // [{namespace, level}]
const nsInput = ref('')
const saving = ref(false)

const openClusters = computed(() => (allClusters.value || []).filter(c => c.nsAuthMode === 'open'))
const selCluster = computed(() => allClusters.value.find(c => c.id === selClusterId.value))

async function load() {
  loading.value = true
  try {
    const [g, c] = await Promise.all([adminApi.groups.list(), adminApi.clusters.list()])
    groups.value = g.groups || []
    allClusters.value = c.clusters || []
  } catch (e) { notify('error', e.message || t('common.loadFailed')) }
  finally { loading.value = false }
}
onMounted(load)

async function doCreateGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  try {
    await adminApi.groups.create(name)
    notify('success', t('admin.users.created', { name }))
    newGroupName.value = ''
    load()
  } catch (e) { notify('error', e.message || t('common.createFailed')) }
}
async function doDeleteGroup(g) {
  if (!confirm(t('admin.authz.deleteGroupConfirm', { name: g.name }))) return
  try {
    await adminApi.groups.remove(g.id)
    if (expandedId.value === g.id) { expandedId.value = null; members.value = [] }
    if (selSubject.value?.id === g.id) { selSubject.value = null; grantRows.value = [] }
    notify('success', t('common.deleted'))
    load()
  } catch (e) { notify('error', e.message || t('common.deleteFailed')) }
}
async function toggleExpand(g) {
  if (expandedId.value === g.id) { expandedId.value = null; return }
  expandedId.value = g.id
  members.value = []
  try { members.value = (await adminApi.groups.membersList(g.id)).members || [] }
  catch (e) { notify('error', e.message || t('common.loadFailed')) }
}
async function doAddMember() {
  const uname = memberInput.value.trim()
  if (!uname || !expandedId.value) return
  try {
    const u = ((await adminApi.users.list()).users || []).find(x => x.username === uname)
    if (!u) { notify('error', t('admin.authz.memberNotFound')); return }
    await adminApi.groups.members(expandedId.value, [u.id])
    memberInput.value = ''
    members.value = (await adminApi.groups.membersList(expandedId.value)).members || []
    load()
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
}
async function doRemoveMember(m) {
  try {
    await adminApi.groups.removeMember(expandedId.value, m.userId)
    members.value = (await adminApi.groups.membersList(expandedId.value)).members || []
    load()
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
}

function pickGroup(g) {
  selSubject.value = g
  selClusterId.value = ''
  grantRows.value = []
}
async function pickCluster(id) {
  selClusterId.value = id
  grantRows.value = []
  if (!selSubject.value || !id) return
  try { grantRows.value = ((await adminApi.grants.list({ subjectType: 'group', subjectId: selSubject.value.id, clusterId: id })).namespaces || []).map(r => ({ ...r })) }
  catch (e) { notify('error', e.message || t('common.loadFailed')) }
}
function nsError(name) { return !NS_RE.test(name) ? t('admin.authz.nsInvalid') : '' }
function doAddNs() {
  const ns = nsInput.value.trim()
  if (!ns) return
  if (!NS_RE.test(ns)) { notify('error', t('admin.authz.nsInvalid')); return }
  if (grantRows.value.some(r => r.namespace === ns)) { notify('error', t('admin.authz.nsExists')); return }
  grantRows.value.push({ namespace: ns, level: 'view' })
  nsInput.value = ''
}
function doRemoveNs(ns) { grantRows.value = grantRows.value.filter(r => r.namespace !== ns) }
async function doSaveGrants() {
  if (!selSubject.value || !selClusterId.value) return
  saving.value = true
  try {
    await adminApi.grants.save({ subjectType: 'group', subjectId: selSubject.value.id, clusterId: selClusterId.value, namespaces: grantRows.value.map(r => ({ namespace: r.namespace, level: r.level })) })
    notify('success', t('admin.authz.saved'))
    load()
  } catch (e) { notify('error', e.message || t('admin.authz.saveFailed')) }
  finally { saving.value = false }
}
</script>

<template>
  <section class="animate-fade-in p-md">
    <div class="mb-md">
      <h2 class="text-headline-lg font-bold text-on-surface">{{ $t('admin.authz.title') }}</h2>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('admin.authz.subtitle') }}</p>
    </div>

    <!-- open 模式风险提示条:open 集群不提供 namespace 隔离 -->
    <div v-if="openClusters.length" data-testid="open-mode-notice" class="mb-md flex items-start gap-sm rounded-lg border border-error/40 bg-error/5 px-md py-sm">
      <span class="material-symbols-outlined text-error text-base mt-0.5">warning</span>
      <p class="text-body-sm text-error">
        {{ $t('admin.authz.openNoIsolation', { names: openClusters.map(c => c.name).join(', ') }) }}
      </p>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <div v-else class="grid gap-md lg:grid-cols-2">
      <!-- 左栏:组列表 + 成员管理 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-low p-md">
        <div class="flex items-center justify-between mb-sm">
          <h3 class="text-title-md font-semibold text-on-surface">{{ $t('admin.authz.groups') }}</h3>
          <div class="flex items-center gap-xs">
            <input v-model="newGroupName" data-testid="new-group-input" :placeholder="$t('admin.authz.newGroupPlaceholder')" class="w-40 bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-body-sm" />
            <button data-testid="new-group-btn" @click="doCreateGroup" class="flex items-center gap-xs px-sm py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
              <span class="material-symbols-outlined text-sm">add</span>{{ $t('admin.authz.newGroup') }}
            </button>
          </div>
        </div>
        <p v-if="!groups.length" class="text-body-sm text-on-surface-variant py-sm">{{ $t('admin.authz.noGroups') }}</p>
        <div v-for="g in groups" :key="g.id" class="border border-outline-variant rounded-lg mb-xs bg-surface-container">
          <div :data-testid="`group-row-${g.id}`" class="flex items-center gap-sm px-md py-sm cursor-pointer hover:bg-surface-container-high" @click="toggleExpand(g)">
            <span class="material-symbols-outlined text-base text-on-surface-variant">{{ expandedId === g.id ? 'expand_less' : 'expand_more' }}</span>
            <span class="font-mono text-body-sm font-medium text-on-surface flex-1 min-w-0 truncate">{{ g.name }}</span>
            <span class="text-body-xs text-on-surface-variant">{{ $t('admin.authz.memberCount', { n: g.memberCount }) }}</span>
            <span class="text-body-xs text-on-surface-variant">{{ $t('admin.authz.grantCount', { n: g.grants }) }}</span>
            <button :data-testid="`grant-group-${g.id}`" @click.stop="pickGroup(g)" :title="$t('admin.authz.grants')" :class="['p-1 rounded relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-[\'\']', selSubject?.id === g.id ? 'bg-primary/10 text-primary' : 'hover:bg-primary/10 text-on-surface-variant hover:text-primary']"><span class="material-symbols-outlined text-base">verified_user</span></button>
            <button @click.stop="doDeleteGroup(g)" :title="$t('common.delete')" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
          <div v-if="expandedId === g.id" class="px-md pb-sm">
            <div class="flex items-center gap-xs mb-xs">
              <input v-model="memberInput" data-testid="member-add-input" :placeholder="$t('admin.authz.addMember')" class="flex-1 min-w-0 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-body-sm" @keyup.enter="doAddMember" />
              <button data-testid="member-add-btn" @click="doAddMember" class="px-sm py-xs border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high"><span class="material-symbols-outlined text-base align-middle">person_add</span></button>
            </div>
            <div v-for="m in members" :key="m.userId" class="flex items-center gap-sm py-xs">
              <span class="font-mono text-body-sm flex-1 min-w-0 truncate">{{ m.username }}</span>
              <button @click="doRemoveMember(m)" :title="$t('common.delete')" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"><span class="material-symbols-outlined text-base">person_remove</span></button>
            </div>
          </div>
        </div>
      </div>

      <!-- 右栏:ns 授权编辑器 -->
      <div class="rounded-xl border border-outline-variant bg-surface-container-low p-md">
        <h3 class="text-title-md font-semibold text-on-surface mb-sm">{{ $t('admin.authz.grants') }}</h3>
        <p v-if="!selSubject" class="text-body-sm text-on-surface-variant">{{ $t('admin.authz.selectGroup') }}</p>
        <template v-else>
          <div class="flex items-center gap-sm mb-sm flex-wrap">
            <span class="font-mono text-body-sm font-medium px-sm py-xs rounded bg-primary/10 text-primary">{{ selSubject.name }}</span>
            <span class="text-body-sm text-on-surface-variant">→</span>
            <select v-model="selClusterId" data-testid="cluster-select" class="bg-surface-container border border-outline-variant rounded-lg px-sm py-xs text-body-sm" @change="pickCluster(selClusterId)">
              <option value="" disabled>{{ $t('admin.authz.selectCluster') }}</option>
              <option v-for="c in allClusters" :key="c.id" :value="c.id" :data-testid="`grant-cluster-${c.id}`">{{ c.name }}{{ c.nsAuthMode === 'open' ? ' (open)' : '' }}</option>
            </select>
          </div>
          <p v-if="selCluster && selCluster.nsAuthMode === 'open'" class="text-body-xs text-error mb-sm">{{ $t('admin.authz.openNoIsolation', { names: selCluster.name }) }}</p>
          <template v-if="selClusterId">
            <div class="flex items-center gap-xs mb-sm">
              <input v-model="nsInput" data-testid="ns-add-input" :placeholder="$t('admin.authz.nsAdd')" class="flex-1 min-w-0 bg-surface-container border rounded-lg px-sm py-xs text-body-sm font-mono" :class="nsInput && nsError(nsInput) ? 'border-error' : 'border-outline-variant'" @keyup.enter="doAddNs" />
              <button data-testid="ns-add-btn" @click="doAddNs" class="px-sm py-xs border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high"><span class="material-symbols-outlined text-base align-middle">add</span></button>
            </div>
            <div v-for="r in grantRows" :key="r.namespace" :data-testid="`ns-row-${r.namespace}`" class="flex items-center gap-sm py-xs border-b border-outline-variant/50 last:border-0">
              <span class="font-mono text-body-sm flex-1 min-w-0 truncate">{{ r.namespace }}</span>
              <button @click="r.level = 'view'" :class="['px-sm py-xs rounded-lg text-body-xs font-medium border', r.level === 'view' ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant']">{{ $t('admin.authz.levelView') }}</button>
              <button @click="r.level = 'operate'" :class="['px-sm py-xs rounded-lg text-body-xs font-medium border', r.level === 'operate' ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant']">{{ $t('admin.authz.levelOperate') }}</button>
              <button @click="doRemoveNs(r.namespace)" :title="$t('common.delete')" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"><span class="material-symbols-outlined text-base">close</span></button>
            </div>
            <button data-testid="grant-save-btn" :disabled="saving" @click="doSaveGrants" class="mt-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm hover:opacity-90 disabled:opacity-50">{{ $t('admin.authz.save') }}</button>
          </template>
        </template>
      </div>
    </div>
  </section>
</template>
