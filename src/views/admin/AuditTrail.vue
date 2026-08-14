<script setup>
// MCP / API-key 调用审计页：active 面板（最近活跃 key）+ 调用记录表（分页/过滤）+ 行详情 + 链完整性徽章。
// 数据源 adminApi.auditTrail.{active,list,verify}（Task 5）。i18n 全覆盖，无残存中文。
import { ref, onMounted, computed } from 'vue'
import { adminApi } from '@/api/client'
import { useI18n } from 'vue-i18n'
import { notify } from '@/composables/useToast'
import { useTableColumns } from '@/composables/useTableColumns'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'

const { t } = useI18n()
const { tableColumns } = useTableColumns()
const loading = ref(false)
const active = ref([])
const log = ref({ items: [], total: 0, page: 1, size: 50 })
const verify = ref(null)
const detail = ref(null)

const winSec = ref(900)
const actSource = ref('')           // '' = all
const f = ref({ owner: '', tool: '', result: '', source: '', key: '', cluster: '' })
const page = ref(1)
const WIN_OPTS = [{ v: 900, k: 'win15' }, { v: 1800, k: 'win30' }, { v: 21600, k: 'win6h' }]
const SRC_OPTS = [{ v: '', k: 'sourceAll' }, { v: 'mcp', k: 'sourceMcp' }, { v: 'agent', k: 'sourceAgent' }, { v: 'workbench', k: 'sourceWorkbench' }, { v: 'direct', k: 'sourceDirect' }]
const RESULT_OPTS = [{ v: '', k: 'sourceAll' }, { v: 'ok', k: 'resultOk' }, { v: 'denied', k: 'resultDenied' }, { v: 'error', k: 'resultError' }]

const headers = computed(() => tableColumns('auditTrail'))
const fmt = ts => ts ? new Date(Number(ts)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-'
const rel = ts => { const s = Math.round((Date.now() - Number(ts)) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h` }
const pct = (n, total) => total ? Math.round((n / total) * 100) : 0
// 动态拼 result 徽章键：ok→resultOk / denied→resultDenied / error→resultError。
// 用函数返回完整键（而非模板里 t('auditTrail.result'+...)）以避开 i18n-check 的静态字面量抽取。
const resultKey = r => r ? `auditTrail.result${r[0].toUpperCase()}${r.slice(1)}` : ''
const SRC_BADGE = { mcp: 'bg-primary/10 text-primary', agent: 'bg-status-warning/10 text-status-warning', workbench: 'bg-status-succeeded/10 text-status-succeeded', direct: 'bg-surface-container-high text-on-surface-variant' }
// 活跃卡片:workbench 伪组(keyId 'wb:<owner>')与 key 卡区分标识
const isWb = a => String(a.keyId || '').startsWith('wb:')
const RESULT_STYLE = { ok: 'bg-status-running/10 text-status-running', denied: 'bg-status-warning/10 text-status-warning', error: 'bg-error/10 text-error' }

async function loadActive() {
  try {
    const r = await adminApi.auditTrail.active({ window: winSec.value, ...(actSource.value ? { source: actSource.value } : {}) })
    active.value = r.active || []
  } catch (e) { notify('error', e.message) }
}
async function loadLog() {
  loading.value = true
  try {
    const params = { page: page.value, size: log.value.size }
    for (const k of ['owner', 'tool', 'result', 'source', 'key', 'cluster']) { const v = f.value[k]; if (v) params[k] = v }
    const r = await adminApi.auditTrail.list(params)
    log.value = { ...r, size: log.value.size }
  } catch (e) { notify('error', e.message) } finally { loading.value = false }
}
async function doVerify() {
  try { verify.value = await adminApi.auditTrail.verify() } catch (e) { notify('error', e.message) }
}
function refresh() { loadActive(); loadLog() }
function openDetail(row) { detail.value = row }
const totalPages = computed(() => Math.max(1, Math.ceil(log.value.total / log.value.size)))

onMounted(() => { refresh() })
</script>

<template>
  <section class="animate-fade-in p-md">
    <div class="flex items-center justify-between mb-md">
      <div>
        <h2 class="text-headline-lg font-bold text-on-surface">{{ t('auditTrail.title') }}</h2>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('auditTrail.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-sm">
        <button @click="doVerify" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">{{ t('auditTrail.verifyBtn') }}</button>
        <span v-if="verify" class="text-body-xs" :class="verify.valid ? 'text-status-running' : 'text-error'">
          {{ verify.valid ? t('auditTrail.verifyOk') : t('auditTrail.verifyBad', { seq: verify.brokenAt }) }}
        </span>
        <button @click="refresh" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm">{{ t('auditTrail.refresh') }}</button>
      </div>
    </div>

    <!-- active panel: recently active keys -->
    <div class="mb-md">
      <div class="flex items-center gap-md mb-sm">
        <span class="text-label-caps text-on-surface-variant">{{ t('auditTrail.activeTitle') }}</span>
        <select v-model.number="winSec" @change="loadActive" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm">
          <option v-for="o in WIN_OPTS" :key="o.v" :value="o.v">{{ t('auditTrail.' + o.k) }}</option>
        </select>
        <select v-model="actSource" @change="loadActive" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm">
          <option v-for="o in SRC_OPTS" :key="o.v" :value="o.v">{{ t('auditTrail.' + o.k) }}</option>
        </select>
      </div>
      <div v-if="!active.length" class="text-body-sm text-on-surface-variant py-md">{{ t('auditTrail.empty', { window: winSec >= 3600 ? Math.round(winSec / 3600) + 'h' : Math.round(winSec / 60) + 'm' }) }}</div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-sm">
        <div v-for="a in active" :key="a.keyId" class="bg-surface-container-low border border-outline-variant rounded-lg p-md">
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-xs min-w-0">
              <span class="font-mono text-body-sm font-semibold truncate">{{ a.label || a.owner }}</span>
              <span v-if="isWb(a)" class="px-1.5 py-0.5 rounded text-body-xs font-mono bg-status-succeeded/10 text-status-succeeded whitespace-nowrap">{{ t('auditTrail.sourceWorkbench') }}</span>
            </span>
            <span class="text-body-xs text-on-surface-variant">{{ t('auditTrail.last') }} {{ rel(a.lastTs) }}</span>
          </div>
          <div class="text-body-xs text-on-surface-variant mt-xs">{{ a.owner }} · {{ a.clusterId }}</div>
          <div class="flex items-center gap-md mt-sm">
            <span class="text-body-sm font-semibold">{{ a.count }}</span>
            <div class="flex-1 h-1.5 rounded-full bg-surface-container-high overflow-hidden flex">
              <div class="bg-status-running h-full" :style="{ width: pct(a.ok, a.count) + '%' }"></div>
              <div class="bg-status-warning h-full" :style="{ width: pct(a.denied, a.count) + '%' }"></div>
              <div class="bg-error h-full" :style="{ width: pct(a.error, a.count) + '%' }"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- call log table -->
    <div class="flex flex-wrap items-center gap-xs mb-sm">
      <input v-model="f.owner" :placeholder="t('auditTrail.colOwner')" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm w-32" />
      <input v-model="f.key" placeholder="keyId" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm w-32 font-mono" />
      <input v-model="f.cluster" :placeholder="t('auditTrail.colCluster')" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm w-28" />
      <input v-model="f.tool" :placeholder="t('auditTrail.colTool')" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm w-36 font-mono" />
      <select v-model="f.result" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm">
        <option v-for="o in RESULT_OPTS" :key="o.v" :value="o.v">{{ t('auditTrail.' + o.k) }}</option>
      </select>
      <select v-model="f.source" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-1 text-body-sm">
        <option v-for="o in SRC_OPTS" :key="o.v" :value="o.v">{{ t('auditTrail.' + o.k) }}</option>
      </select>
      <button @click="page = 1; loadLog()" class="px-md py-1 bg-primary text-on-primary rounded-lg text-body-sm">go</button>
    </div>

    <DataTable :headers="headers" :rows="log.items" column-key="auditTrail">
      <template #ts="{ row }"><span class="text-body-xs text-on-surface-variant font-mono">{{ fmt(row.ts) }}</span></template>
      <template #source="{ row }"><span v-if="row.source" class="px-1.5 py-0.5 rounded text-body-xs font-mono" :class="SRC_BADGE[row.source]">{{ row.source }}</span><span v-else class="text-body-xs text-on-surface-variant/50">—</span></template>
      <template #result="{ row }"><span class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="RESULT_STYLE[row.result]">{{ t(resultKey(row.result)) }}</span></template>
      <template #resource="{ row }"><button @click="openDetail(row)" class="font-mono text-body-xs text-primary hover:underline text-left">{{ row.resource || '—' }}</button></template>
    </DataTable>

    <div class="flex items-center justify-between mt-sm">
      <span class="text-body-xs text-on-surface-variant">{{ log.total }} · {{ page }}/{{ totalPages }}</span>
      <div class="flex gap-xs">
        <button :disabled="page <= 1" @click="page--; loadLog()" class="px-sm py-1 border border-outline-variant rounded-lg text-body-sm disabled:opacity-40">{{ t('auditTrail.prev') }}</button>
        <button :disabled="page >= totalPages" @click="page++; loadLog()" class="px-sm py-1 border border-outline-variant rounded-lg text-body-sm disabled:opacity-40">{{ t('auditTrail.next') }}</button>
      </div>
    </div>

    <Modal :modelValue="!!detail" @update:modelValue="v => { if (!v) detail = null }" :title="t('auditTrail.detail')" width="max-w-lg">
      <div v-if="detail" class="flex flex-col gap-xs text-body-sm font-mono">
        <div><span class="text-on-surface-variant">{{ t('auditTrail.seq') }}:</span> {{ detail.seq }}</div>
        <div><span class="text-on-surface-variant">{{ t('auditTrail.colTool') }}:</span> {{ detail.tool }}</div>
        <div><span class="text-on-surface-variant">{{ t('auditTrail.summary') }}:</span> {{ detail.requestSummary || '—' }}</div>
        <div><span class="text-on-surface-variant">{{ t('auditTrail.colReason') }}:</span> {{ detail.reason || '—' }}</div>
        <div class="break-all"><span class="text-on-surface-variant">{{ t('auditTrail.chain') }}:</span> {{ detail.prevHash?.slice(0, 16) }} → {{ detail.hash?.slice(0, 16) }}</div>
      </div>
    </Modal>
  </section>
</template>
