<script setup>
// API Keys 管理(admin):签发(明文仅此次)/列表/吊销。后端 /api/admin/apikeys,逻辑见 server/auth-keys.mjs。
// 列表用通用 DataTable(紧凑一行一条,与 workload 等列表一致),不用大卡片。
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { notify } from '@/composables/useToast'
import { useTableColumns } from '@/composables/useTableColumns'
import Modal from '@/components/common/Modal.vue'
import DataTable from '@/components/common/DataTable.vue'
import ToolOverrideEditor from '@/components/common/ToolOverrideEditor.vue'
import NsAllowlistEditor from '@/components/common/NsAllowlistEditor.vue'

const { t } = useI18n()
const { tableColumns } = useTableColumns()
const auth = useAuthStore()
const apikeys = ref([])
const clusters = ref([])
const loading = ref(true)
const showMintModal = ref(false)
const mintForm = ref({ mode: 'managed', owner: '', clusterId: '', boundSA_namespace: '', boundSA_name: '', tier: 'read', label: '' })
const mintErrors = ref({}) // 必填校验行内提示:字段名 → 是否缺(owner 服务端兜底当前用户,非必填)
const newKey = ref(null) // 签发成功后展示明文(仅此次)

const mintOverrides = ref({ allow: [], deny: [] })        // mint 用
const editOverrides = ref({ allow: [], deny: [] })        // edit 用
const showOverrideModal = ref(false)
const editingKey = ref(null)

const mintExtraNs = ref([])        // mint ns allowlist 用
const editExtraNs = ref([])        // edit ns allowlist 用
const showNsModal = ref(false)

// 列表展示:把 DB 的 tool_overrides 串解析成摘要
const overrideSummary = k => {
  if (!k.tool_overrides) return ''
  let ov; try { ov = JSON.parse(k.tool_overrides) } catch { return t('admin.apiKeys.overrideCorrupted') }
  const parts = []; (ov.allow || []).forEach(t => parts.push(`+${t}`)); (ov.deny || []).forEach(t => parts.push(`−${t}`))
  return parts.join(' ') || ''
}
// {allow,deny} 对象 → PATCH 载荷(空→null)
const overridesPayload = ov => (ov && ((ov.allow || []).length || (ov.deny || []).length)) ? { allow: ov.allow || [], deny: ov.deny || [] } : null

function openOverrideEditor(k) {
  editingKey.value = k
  let ov = { allow: [], deny: [] }
  if (k.tool_overrides) { try { const p = JSON.parse(k.tool_overrides); ov = { allow: p.allow || [], deny: p.deny || [] } } catch { /* 损坏→空 */ } }
  editOverrides.value = ov
  showOverrideModal.value = true
}
async function saveOverrides() {
  try {
    await adminApi.apikeys.updateOverrides(editingKey.value.id, overridesPayload(editOverrides.value))
    notify('success', t('admin.apiKeys.overridesUpdated')); showOverrideModal.value = false; load()
  } catch (e) { notify('error', e.message || t('admin.apiKeys.updateFailed')) }
}

// 列表展示:把 DB 的 allowed_namespaces 串解析成额外 ns 摘要
const nsSummary = k => {
  let extra = []
  if (k.allowed_namespaces) { try { extra = JSON.parse(k.allowed_namespaces) } catch { extra = [] } }
  if (!Array.isArray(extra)) extra = []
  return extra.length ? `+ ${extra.join(', ')}` : ''
}
function openNsEditor(k) {
  editingKey.value = k
  let extra = []
  if (k.allowed_namespaces) { try { extra = JSON.parse(k.allowed_namespaces) } catch { extra = [] } }
  if (!Array.isArray(extra)) extra = []
  editExtraNs.value = extra
  showNsModal.value = true
}
async function saveNamespaces() {
  try {
    const res = await adminApi.apikeys.updateNamespaces(editingKey.value.id, editExtraNs.value)
    // BYO key 平台不代建 RBAC:成功但要提示新 ns 的 RoleBinding 需自建(与 repair 需 takeover 同立场)。
    notify('success', res?.rbac === 'byo-self-managed' ? t('nsAllowlist.updatedByo') : t('nsAllowlist.updated'))
    showNsModal.value = false; load()
  } catch (e) { notify('error', e.message || t('nsAllowlist.updateFailed')) }
}

const clusterName = id => clusters.value.find(c => c.id === id)?.name || (id ? id.slice(0, 8) : '-')
const fmt = ts => ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'
const TIER_STYLE = { read: 'bg-status-running/10 text-status-running', operator: 'bg-status-warning/10 text-status-warning', admin: 'bg-error/10 text-error' }
const headers = computed(() => tableColumns('apiKeys'))

async function load() {
  loading.value = true
  try {
    const [kr, cr] = await Promise.all([adminApi.apikeys.list(), adminApi.clusters.list()])
    apikeys.value = kr.apikeys || []
    clusters.value = cr.clusters || []
  } catch (e) { notify('error', e.message || t('common.loadFailed')) }
  finally { loading.value = false }
}
// SA 健康(id → {ok, detail, managed});探测失败不阻塞列表。
const saHealth = ref({})
async function loadHealth() {
  try { const res = await adminApi.apikeys.health(); saHealth.value = Object.fromEntries((res.health || []).map(h => [h.id, h])) } catch { /* 网关旧版本无此端点:静默降级 */ }
}
// 漂移三态(spec 2026-08-27):绿=ok且无漂移;黄=ok但 RBAC drift/over;红=SA 不可达。旧网关无 rbac → 退化两态。
const camelize = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const dotColor = (h) => !h ? 'var(--md-sys-color-outline-variant, #9ca3af)' : !h.ok ? '#dc2626' : (h.rbac?.status && h.rbac.status !== 'ok') ? '#f59e0b' : '#10b981'
const dotTitle = (h) => {
  if (!h) return ''
  const issues = (h.rbac?.issues || []).map(i => `${t(`admin.apiKeys.drift.${camelize(i.type)}`)}${i.ns ? ` (${i.ns}${i.name ? '/' + i.name : ''})` : ''}`)
  return [h.detail, ...issues, h.rbac?.status === 'over' ? t('admin.apiKeys.drift.foreignHint') : ''].filter(Boolean).join('\n')
}
const needsRepair = (row) => { const h = saHealth.value[row.id]; return !!(h && (!h.ok || h.rbac?.status === 'drift')) }
async function repairSa(row) {
  try {
    const res = await adminApi.apikeys.repairSa(row.id, row.saManaged ? {} : { takeover: true })
    notify('success', t('admin.apiKeys.repairDone', { sa: res.boundSA }))
    await load(); await loadHealth()
  } catch (e) { notify('error', e.message || t('admin.apiKeys.repairFailed')) }
}
onMounted(() => { mintForm.value.owner = auth.user?.username || ''; load(); loadHealth() })

// 必填校验:空/纯空格视为缺。与服务端 mintKey 必填字段对齐(客户端先拦,
// 不让用户看到裸的「mintKey 缺少必填字段」400)。
const MINT_REQUIRED_BY_MODE = {
  managed: ['clusterId', 'boundSA_namespace'],
  byo: ['clusterId', 'boundSA_namespace', 'boundSA_name'],
}
function validateMint() {
  const required = MINT_REQUIRED_BY_MODE[mintForm.value.mode] || MINT_REQUIRED_BY_MODE.byo
  mintErrors.value = Object.fromEntries(
    required.filter(k => !String(mintForm.value[k] || '').trim()).map(k => [k, true])
  )
  return !Object.keys(mintErrors.value).length
}
function clearMintError(k) { if (mintErrors.value[k]) delete mintErrors.value[k] }

async function doMint() {
  if (!validateMint()) { notify('error', t('admin.apiKeys.mintMissingRequired')); return }
  try {
    const payload = {
      ...mintForm.value,
      clusterId: mintForm.value.clusterId,
      boundSA_namespace: mintForm.value.boundSA_namespace.trim(),
      boundSA_name: mintForm.value.boundSA_name.trim(),
      owner: mintForm.value.owner.trim(),
      label: mintForm.value.label.trim(),
      tool_overrides: overridesPayload(mintOverrides.value),
      allowed_namespaces: mintExtraNs.value.length ? mintExtraNs.value : null,
    }
    if (mintForm.value.mode === 'managed') delete payload.boundSA_name  // 服务端代建
    const res = await adminApi.apikeys.create(payload)
    newKey.value = res.apikey
    showMintModal.value = false
    mintForm.value = { mode: 'managed', owner: auth.user?.username || '', clusterId: '', boundSA_namespace: '', boundSA_name: '', tier: 'read', label: '' }
    mintOverrides.value = { allow: [], deny: [] }
    mintExtraNs.value = []
    mintErrors.value = {}
    notify('success', t('admin.apiKeys.minted'))
    load()
  } catch (e) { notify('error', e.message || t('admin.apiKeys.mintFailed')) }
}
async function copyPlaintext() {
  try { await navigator.clipboard.writeText(newKey.value.plaintext); notify('success', t('common.copySuccess')) }
  catch { notify('error', t('admin.apiKeys.copyFailedManual')) }
}
async function doRevoke(k) {
  if (!confirm(t('admin.apiKeys.revokeConfirm', { prefix: k.prefix, owner: k.owner }))) return
  try { await adminApi.apikeys.remove(k.id); notify('success', t('admin.apiKeys.revoked')); load() }
  catch (e) { notify('error', e.message || t('admin.apiKeys.revokeFailed')) }
}
</script>

<template>
  <section class="animate-fade-in p-md">
    <div class="flex items-center justify-between mb-md">
      <div><h2 class="text-headline-lg font-bold text-on-surface">{{ $t('admin.apiKeys.title') }}</h2><p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('admin.apiKeys.subtitle') }}</p></div>
      <button @click="mintOverrides = { allow: [], deny: [] }; mintExtraNs = []; mintErrors = {}; showMintModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
        <span class="material-symbols-outlined text-sm">add</span> {{ $t('admin.apiKeys.mintKey') }}
      </button>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <DataTable v-else :headers="headers" :rows="apikeys" column-key="apiKeys">
      <template #prefix="{ row }"><span class="font-mono text-body-sm font-semibold">{{ row.prefix }}…</span></template>
      <template #tier="{ row }"><span class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="TIER_STYLE[row.tier]">{{ row.tier }}</span></template>
      <template #overrides="{ row }">
        <span v-if="overrideSummary(row)" class="font-mono text-body-xs text-on-surface-variant">{{ overrideSummary(row) }}</span>
        <span v-else class="text-body-xs text-on-surface-variant/50">—</span>
      </template>
      <template #nsAllowlist="{ row }">
        <span v-if="nsSummary(row)" class="font-mono text-body-xs text-on-surface-variant">{{ nsSummary(row) }}</span>
        <span v-else class="text-body-xs text-on-surface-variant/50">—</span>
      </template>
      <template #boundSA="{ row }">
        <div class="flex items-center gap-xs">
          <span class="inline-block w-2 h-2 rounded-full shrink-0" :style="{ background: dotColor(saHealth[row.id]) }" :title="dotTitle(saHealth[row.id])"></span>
          <span class="font-mono text-body-xs text-on-surface-variant">{{ row.boundSA_namespace }}/{{ row.boundSA_name }}</span>
          <span v-if="row.saManaged" class="px-xs rounded-full text-[10px] leading-4 border border-outline-variant text-on-surface-variant">{{ $t('admin.apiKeys.managedBadge') }}</span>
          <button v-if="needsRepair(row)" data-testid="sa-repair" class="text-body-xs text-primary underline underline-offset-2" @click="repairSa(row)">{{ row.saManaged ? $t('admin.apiKeys.repair') : $t('admin.apiKeys.repairTakeover') }}</button>
        </div>
      </template>
      <template #cluster="{ row }"><span class="text-body-sm">{{ clusterName(row.clusterId) }}</span></template>
      <template #state="{ row }">
        <span v-if="row.revokedAt" class="text-body-xs text-error">{{ $t('admin.apiKeys.revokedBadge') }}</span>
        <span v-else class="text-body-xs text-status-running flex items-center gap-0.5"><span class="w-1.5 h-1.5 rounded-full bg-status-running inline-block"></span>active</span>
      </template>
      <template #created="{ row }"><span class="text-body-xs text-on-surface-variant">{{ fmt(row.createdAt) }}</span></template>
      <template #actions="{ row }">
        <button v-if="!row.revokedAt" @click.stop="openNsEditor(row)" class="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary" :title="$t('nsAllowlist.editNs')"><span class="material-symbols-outlined text-base">filter_alt</span></button>
        <button v-if="!row.revokedAt" @click.stop="openOverrideEditor(row)" class="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary" :title="$t('admin.apiKeys.editOverrides')"><span class="material-symbols-outlined text-base">tune</span></button>
        <button v-if="!row.revokedAt" @click.stop="doRevoke(row)" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error" :title="$t('admin.apiKeys.revoke')"><span class="material-symbols-outlined text-base">block</span></button>
      </template>
    </DataTable>

    <!-- 签发 Modal -->
    <Modal v-model="showMintModal" :title="$t('admin.apiKeys.mintKey')" width="max-w-xl">
      <div class="flex flex-col gap-md">
        <div class="grid grid-cols-2 gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.apiKeys.owner') }}</label><input v-model="mintForm.owner" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="alice" /></div>
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.apiKeys.labelOptional') }}</label><input v-model="mintForm.label" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="debug-laptop" /></div>
        </div>
        <div class="flex gap-xs mb-sm">
          <button type="button" data-testid="mint-mode-managed" :class="['px-md py-xs rounded-full text-body-xs border transition-colors', mintForm.mode==='managed' ? 'bg-primary-container text-on-primary-container border-primary' : 'border-outline-variant text-on-surface-variant']" @click="mintForm.mode='managed'">{{ $t('admin.apiKeys.modeManaged') }}</button>
          <button type="button" data-testid="mint-mode-byo" :class="['px-md py-xs rounded-full text-body-xs border transition-colors', mintForm.mode==='byo' ? 'bg-primary-container text-on-primary-container border-primary' : 'border-outline-variant text-on-surface-variant']" @click="mintForm.mode='byo'">{{ $t('admin.apiKeys.modeByo') }}</button>
        </div>
        <p class="text-body-xs text-on-surface-variant mb-sm">{{ mintForm.mode==='managed' ? $t('admin.apiKeys.modeManagedHint') : $t('admin.apiKeys.modeByoHint') }}</p>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.apiKeys.bindCluster') }} <span class="text-error">*</span></label>
          <select v-model="mintForm.clusterId" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm', mintErrors.clusterId ? 'border-error' : 'border-outline-variant']" @change="clearMintError('clusterId')">
            <option value="" disabled>{{ $t('admin.apiKeys.selectCluster') }}</option>
            <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }} ({{ c.apiServer }})</option>
          </select>
          <p v-if="mintErrors.clusterId" data-testid="mint-error-clusterId" class="text-body-xs text-error mt-xs">{{ $t('admin.apiKeys.requiredHint') }}</p>
          <!-- 空集群显式提示:否则下拉永远选不了,用户无从下手 -->
          <p v-if="!clusters.length && !loading" class="text-body-xs text-on-surface-variant mt-xs flex items-center gap-xs">
            <span class="material-symbols-outlined text-sm">info</span>{{ $t('admin.apiKeys.noClustersHint') }}
          </p>
        </div>
        <div class="grid grid-cols-2 gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t(mintForm.mode==='managed' ? 'admin.apiKeys.bindSaNamespaceManaged' : 'admin.apiKeys.bindSaNamespace') }} <span class="text-error">*</span></label><input v-model="mintForm.boundSA_namespace" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono', mintErrors.boundSA_namespace ? 'border-error' : 'border-outline-variant']" placeholder="default" @input="clearMintError('boundSA_namespace')" />
            <p v-if="mintErrors.boundSA_namespace" data-testid="mint-error-boundSA_namespace" class="text-body-xs text-error mt-xs">{{ $t('admin.apiKeys.requiredHint') }}</p>
          </div>
          <div v-if="mintForm.mode === 'byo'"><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.apiKeys.bindSaName') }} <span class="text-error">*</span></label><input v-model="mintForm.boundSA_name" :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono', mintErrors.boundSA_name ? 'border-error' : 'border-outline-variant']" placeholder="aliangboard-smoke" @input="clearMintError('boundSA_name')" />
            <p v-if="mintErrors.boundSA_name" data-testid="mint-error-boundSA_name" class="text-body-xs text-error mt-xs">{{ $t('admin.apiKeys.requiredHint') }}</p>
          </div>
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.apiKeys.tier') }}</label>
          <select v-model="mintForm.tier" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
            <option value="read">{{ $t('admin.apiKeys.tierRead') }}</option>
            <option value="operator">{{ $t('admin.apiKeys.tierOperator') }}</option>
            <option value="admin">{{ $t('admin.apiKeys.tierAdmin') }}</option>
          </select>
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.apiKeys.advancedOverrides') }}</label>
          <ToolOverrideEditor :tier="mintForm.tier" v-model="mintOverrides" />
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('nsAllowlist.advanced') }}</label>
          <NsAllowlistEditor :bound-ns="mintForm.boundSA_namespace" :cluster-id="mintForm.clusterId" v-model="mintExtraNs" />
        </div>
        <p class="text-body-xs text-on-surface-variant bg-surface-container-low rounded-lg p-sm">{{ $t('admin.apiKeys.saMustExist') }}</p>
      </div>
      <template #actions>
        <button @click="showMintModal = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ $t('common.cancel') }}</button>
        <button @click="doMint" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ $t('admin.apiKeys.mint') }}</button>
      </template>
    </Modal>

    <!-- 明文展示(仅此次)Modal -->
    <Modal :modelValue="!!newKey" @update:modelValue="v => { if (!v) newKey = null }" :title="$t('admin.apiKeys.mintedTitle')" width="max-w-xl">
      <div v-if="newKey" class="flex flex-col gap-md">
        <div class="bg-error/5 border border-error/20 rounded-lg p-md">
          <p class="text-body-sm text-error font-semibold flex items-center gap-xs"><span class="material-symbols-outlined text-base">warning</span> {{ $t('admin.apiKeys.plaintextWarning') }}</p>
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('admin.apiKeys.plaintextKey') }}</label>
          <div class="flex gap-xs">
            <input :value="newKey.plaintext" readonly class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
            <button @click="copyPlaintext" class="px-md py-sm bg-primary text-on-primary rounded-lg shrink-0 flex items-center gap-xs"><span class="material-symbols-outlined text-base">content_copy</span>{{ $t('admin.apiKeys.copy') }}</button>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-sm text-body-xs text-on-surface-variant">
          <div>prefix: <span class="font-mono">{{ newKey.prefix }}</span></div>
          <div>tier: {{ newKey.tier }}</div>
          <div>owner: {{ newKey.owner }}</div>
          <div>SA: {{ newKey.boundSA_namespace }}/{{ newKey.boundSA_name }}</div>
        </div>
      </div>
      <template #actions>
        <button @click="newKey = null" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ $t('admin.apiKeys.copiedSaved') }}</button>
      </template>
    </Modal>

    <!-- 编辑工具覆盖 Modal -->
    <Modal v-model="showOverrideModal" :title="$t('admin.apiKeys.editOverridesTitle', { prefix: editingKey?.prefix })" width="max-w-xl">
      <div v-if="editingKey" class="flex flex-col gap-md">
        <p class="text-body-xs text-on-surface-variant" v-html="$t('admin.apiKeys.overrideMeta', { tier: editingKey.tier, ns: editingKey.boundSA_namespace, name: editingKey.boundSA_name })"></p>
        <ToolOverrideEditor :tier="editingKey.tier" v-model="editOverrides" />
      </div>
      <template #actions>
        <button @click="showOverrideModal = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ $t('common.cancel') }}</button>
        <button @click="saveOverrides" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ $t('common.save') }}</button>
      </template>
    </Modal>

    <!-- 编辑 namespace 允许集 Modal -->
    <Modal v-model="showNsModal" :title="$t('nsAllowlist.editNsTitle', { prefix: editingKey?.prefix })" width="max-w-xl">
      <div v-if="editingKey" class="flex flex-col gap-md">
        <p class="text-body-xs text-on-surface-variant">{{ $t('nsAllowlist.nsMeta', { ns: editingKey.boundSA_namespace, name: editingKey.boundSA_name }) }}</p>
        <NsAllowlistEditor :bound-ns="editingKey.boundSA_namespace" :cluster-id="editingKey?.clusterId" v-model="editExtraNs" />
      </div>
      <template #actions>
        <button @click="showNsModal = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ $t('common.cancel') }}</button>
        <button @click="saveNamespaces" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ $t('common.save') }}</button>
      </template>
    </Modal>
  </section>
</template>
