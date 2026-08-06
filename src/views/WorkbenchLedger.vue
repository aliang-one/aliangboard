<script setup>
// 集群台账(W3):每集群一份 cluster-context repo。INDEX.md 是平台 survey 的事实层。
// admin 可 bootstrap(survey 集群 → 生成 INDEX.md);语义层由 agent 在使用中补(W4/W5)。
import { ref, computed, onMounted, watch } from 'vue'
import { workbenchApi, authApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { notify } from '@/composables/useToast'

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
  } catch (e) { notify('error', e.message || '加载集群失败') }
}
onMounted(async () => { await loadClusters(); if (clusterId.value) await loadLedger() })
watch(clusterId, () => { if (clusterId.value) loadLedger() })

async function loadLedger() {
  loading.value = true
  try { ledger.value = await workbenchApi.getLedger(clusterId.value) }
  catch (e) { notify('error', e.message || '读取台账失败') }
  finally { loading.value = false }
}

async function bootstrap() {
  if (!confirm('用平台直连凭据 survey 集群,生成/覆盖 INDEX.md(事实层)。继续?')) return
  bootstrapping.value = true
  try {
    const res = await workbenchApi.bootstrapLedger(clusterId.value)
    ledger.value = { exists: true, files: res.files, index: res.index }
    notify('success', '台账已 bootstrap')
  } catch (e) { notify('error', e.message || 'bootstrap 失败') }
  finally { bootstrapping.value = false }
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
        <h2 class="text-headline-lg font-bold text-on-surface flex items-center gap-sm"><span class="material-symbols-outlined">menu_book</span> 集群台账</h2>
        <p class="text-body-sm text-on-surface-variant mt-xs">每集群一份 cluster-context repo。INDEX.md 是平台 survey 的事实层(有什么);语义解读由 agent 在使用中补到 capabilities/。verified_at 防 drift。</p>
      </div>
      <div class="flex items-center gap-sm">
        <select v-model="clusterId" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm min-w-[180px]">
          <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button v-if="auth.isAdmin" @click="bootstrap" :disabled="!clusterId || bootstrapping" class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">
          <span class="material-symbols-outlined text-sm">{{ bootstrapping ? 'progress_activity' : 'auto_awesome' }}</span> {{ bootstrapping ? 'survey 中…' : 'Bootstrap INDEX' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <template v-else-if="ledger">
      <div v-if="ledger.exists" class="flex flex-col gap-sm">
        <div class="flex items-center gap-md text-body-xs text-on-surface-variant">
          <span v-if="verifiedAt" class="flex items-center gap-xs"><span class="material-symbols-outlined text-sm">schedule</span>verified_at: <span class="font-mono">{{ verifiedAt }}</span></span>
          <span>{{ (ledger.files || []).length }} 个文件</span>
        </div>
        <pre class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md font-mono text-body-sm whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto">{{ ledger.index }}</pre>
        <details class="bg-surface-container-low border border-outline-variant rounded-lg">
          <summary class="cursor-pointer px-md py-sm text-body-sm text-on-surface-variant">台账文件</summary>
          <div class="px-md pb-md flex flex-col gap-xs">
            <div v-for="f in ledger.files" :key="f" class="font-mono text-body-xs text-on-surface-variant">📄 {{ f }}</div>
          </div>
        </details>
      </div>
      <div v-else class="bg-surface-container-low border border-outline-variant rounded-lg p-xl text-center">
        <span class="material-symbols-outlined text-4xl text-on-surface-variant/40">menu_book</span>
        <p class="text-body-sm text-on-surface-variant mt-md">该集群还没有台账。<span v-if="auth.isAdmin">点「Bootstrap INDEX」用平台凭据 survey 生成。</span><span v-else>请联系管理员 bootstrap。</span></p>
      </div>
    </template>
  </section>
</template>
