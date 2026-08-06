<script setup>
// 集群台账(W3):每集群一份 cluster-context repo。INDEX.md 是平台 survey 的事实层。
// admin 可 bootstrap(survey 集群 → 生成 INDEX.md);语义层由 agent 在使用中补(W4/W5)。
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { workbenchApi, authApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'

const { t } = useI18n()
const auth = useAuthStore()
const clusters = ref([])
const clusterId = ref('')
const ledger = ref(null)   // { exists, files, index }
const loading = ref(false)
const bootstrapping = ref(false)

async function loadClusters() {
  try {
    const cr = await authApi.myClusters()
    clusters.value = Array.isArray(cr) ? cr : (cr.clusters || [])
    if (clusters.value[0]) clusterId.value = clusters.value[0].id
  } catch (e) { notify('error', e.message || t('common.error')) }
}
onMounted(async () => { await loadClusters(); if (clusterId.value) await loadLedger() })
watch(clusterId, () => { if (clusterId.value) loadLedger() })

async function loadLedger() {
  loading.value = true
  try { ledger.value = await workbenchApi.getLedger(clusterId.value) }
  catch (e) { notify('error', e.message || t('workbench.ledger.loadFailed')) }
  finally { loading.value = false }
}

async function bootstrap() {
  if (!confirm(t('workbench.ledger.confirmBootstrap'))) return
  bootstrapping.value = true
  try {
    const res = await workbenchApi.bootstrapLedger(clusterId.value)
    ledger.value = { exists: true, files: res.files, index: res.index }
    notify('success', t('workbench.ledger.bootstrapSuccess'))
  } catch (e) { notify('error', e.message || t('workbench.ledger.bootstrapFailed')) }
  finally { bootstrapping.value = false }
}

const distilling = ref(false)
const applying = ref(false)
const distillResult = ref(null)   // { proposed, current, summary, stats }
const proposedEdit = ref('')

async function distill() {
  distilling.value = true
  try {
    const r = await workbenchApi.distill(clusterId.value)
    distillResult.value = r
    proposedEdit.value = r.proposed
    notify('success', t('workbench.ledger.distillDone', { summary: r.summary }))
  } catch (e) { notify('error', e.message || t('workbench.ledger.distillFailed')) }
  finally { distilling.value = false }
}
async function applyDistill() {
  applying.value = true
  try {
    await workbenchApi.applyDistill(clusterId.value, proposedEdit.value)
    notify('success', t('workbench.ledger.learningsApplied'))
    distillResult.value = null
    await loadLedger()
  } catch (e) { notify('error', e.message || t('workbench.ledger.applyFailed')) }
  finally { applying.value = false }
}
function openPending() {
  const p = ledger.value?.pending
  if (!p) return
  distillResult.value = { proposed: p.proposed, current: p.current, summary: p.summary }
  proposedEdit.value = p.proposed
}
async function dismissPending() {
  try { await workbenchApi.dismissDistill(clusterId.value); await loadLedger() }
  catch (e) { notify('error', e.message || t('common.error')) }
}

const verifiedAt = computed(() => {
  const m = ledger.value?.index?.match(/^verified_at:\s*(.+)$/m)
  return m ? m[1].trim() : null
})
</script>

<template>
  <section class="animate-fade-in p-md max-w-5xl flex flex-col gap-md">
    <div class="flex items-center justify-between gap-md flex-wrap">
      <div>
        <h2 class="text-headline-lg font-bold text-on-surface flex items-center gap-sm"><span class="material-symbols-outlined">menu_book</span> {{ t('workbench.ledger.title') }}</h2>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('workbench.ledger.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-sm">
        <select v-model="clusterId" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm min-w-[180px]">
          <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button v-if="auth.isAdmin" @click="bootstrap" :disabled="!clusterId || bootstrapping" class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">
          <span class="material-symbols-outlined text-sm">{{ bootstrapping ? 'progress_activity' : 'auto_awesome' }}</span> {{ bootstrapping ? t('workbench.ledger.bootstrapping') : t('workbench.ledger.bootstrap') }}
        </button>
        <button v-if="auth.isAdmin" @click="distill" :disabled="!clusterId || distilling" class="flex items-center gap-xs px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container disabled:opacity-40" :title="t('workbench.ledger.distillTitle')">
          <span class="material-symbols-outlined text-sm">{{ distilling ? 'progress_activity' : 'psychology' }}</span> {{ distilling ? t('workbench.ledger.distilling') : t('workbench.ledger.distill') }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <template v-else-if="ledger">
      <div v-if="ledger.pending" class="flex items-center gap-sm bg-status-warning/10 border border-status-warning/30 rounded-lg px-md py-sm text-body-sm">
        <span class="material-symbols-outlined text-status-warning">schedule</span>
        <span class="text-status-warning">{{ t('workbench.ledger.pendingReview', { summary: ledger.pending.summary }) }}</span>
        <button @click="openPending" class="ml-auto px-md py-xs bg-primary text-on-primary rounded text-body-xs font-semibold">{{ t('workbench.ledger.viewDiff') }}</button>
        <button @click="dismissPending" class="px-md py-xs border border-outline-variant rounded text-body-xs">{{ t('workbench.ledger.dismiss') }}</button>
      </div>
      <div v-if="ledger.exists" class="flex flex-col gap-sm">
        <div class="flex items-center gap-md text-body-xs text-on-surface-variant">
          <span v-if="verifiedAt" class="flex items-center gap-xs"><span class="material-symbols-outlined text-sm">schedule</span>{{ t('workbench.ledger.verifiedAt') }}: <span class="font-mono">{{ verifiedAt }}</span></span>
          <span>{{ t('workbench.ledger.filesCount', { n: (ledger.files || []).length }) }}</span>
        </div>
        <p class="text-label-caps text-on-surface-variant">{{ t('workbench.ledger.indexLabel') }}</p>
        <pre class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md font-mono text-body-sm whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto">{{ ledger.index }}</pre>
        <template v-if="ledger.learnings">
          <p class="text-label-caps text-on-surface-variant">{{ t('workbench.ledger.learningsLabel') }}</p>
          <pre class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md font-mono text-body-sm whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto">{{ ledger.learnings }}</pre>
        </template>
        <details class="bg-surface-container-low border border-outline-variant rounded-lg">
          <summary class="cursor-pointer px-md py-sm text-body-sm text-on-surface-variant">{{ t('workbench.ledger.filesTitle') }}</summary>
          <div class="px-md pb-md flex flex-col gap-xs">
            <div v-for="f in ledger.files" :key="f" class="font-mono text-body-xs text-on-surface-variant">{{ t('workbench.ledger.fileItem', { file: f }) }}</div>
          </div>
        </details>
      </div>
      <div v-else class="bg-surface-container-low border border-outline-variant rounded-lg p-xl text-center">
        <span class="material-symbols-outlined text-4xl text-on-surface-variant/40">menu_book</span>
        <p class="text-body-sm text-on-surface-variant mt-md">{{ t('workbench.ledger.noLedger') }}<span v-if="auth.isAdmin">{{ t('workbench.ledger.noLedgerAdmin') }}</span><span v-else>{{ t('workbench.ledger.noLedgerUser') }}</span></p>
      </div>
    </template>

    <!-- 蒸馏 diff 审批(现有 vs 蒸馏后可编辑)-->
    <Modal :modelValue="!!distillResult" @update:modelValue="v => { if (!v) distillResult = null }" :title="t('workbench.ledger.distillModalTitle')" width="max-w-4xl">
      <div v-if="distillResult" class="flex flex-col gap-md">
        <p class="text-body-sm text-on-surface-variant">{{ t('workbench.ledger.distillModalDesc', { summary: distillResult.summary }) }}</p>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <p class="text-body-xs text-on-surface-variant mb-xs">{{ t('workbench.ledger.currentLearnings') }}</p>
            <pre class="bg-surface-container-lowest border border-outline-variant rounded-lg p-sm font-mono text-body-xs whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto">{{ distillResult.current || t('workbench.ledger.empty') }}</pre>
          </div>
          <div>
            <p class="text-body-xs text-on-surface-variant mb-xs">{{ t('workbench.ledger.distilledEdit') }}</p>
            <textarea v-model="proposedEdit" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg p-sm font-mono text-body-xs max-h-[50vh] min-h-[40vh] resize-none outline-none"></textarea>
          </div>
        </div>
      </div>
      <template #actions>
        <button @click="distillResult = null" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="applyDistill" :disabled="applying" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ applying ? t('workbench.ledger.applying') : t('common.apply') }}</button>
      </template>
    </Modal>
  </section>
</template>
