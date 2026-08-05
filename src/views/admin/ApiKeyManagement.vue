<script setup>
// API Keys 管理(admin):签发(明文仅此次)/列表/吊销。后端 /api/admin/apikeys,逻辑见 server/auth-keys.mjs。
// 列表用通用 DataTable(紧凑一行一条,与 workload 等列表一致),不用大卡片。
import { ref, onMounted } from 'vue'
import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'
import DataTable from '@/components/common/DataTable.vue'

const auth = useAuthStore()
const apikeys = ref([])
const clusters = ref([])
const loading = ref(true)
const showMintModal = ref(false)
const mintForm = ref({ owner: '', clusterId: '', boundSA_namespace: '', boundSA_name: '', tier: 'read', label: '' })
const newKey = ref(null) // 签发成功后展示明文(仅此次)

const clusterName = id => clusters.value.find(c => c.id === id)?.name || (id ? id.slice(0, 8) : '-')
const fmt = ts => ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'
const TIER_STYLE = { read: 'bg-status-running/10 text-status-running', operator: 'bg-status-warning/10 text-status-warning', admin: 'bg-error/10 text-error' }
const headers = [
  { key: 'prefix', label: 'Key' },
  { key: 'tier', label: '权限' },
  { key: 'owner', label: '归属人' },
  { key: 'boundSA', label: '绑定 SA' },
  { key: 'cluster', label: '集群' },
  { key: 'state', label: '状态' },
  { key: 'created', label: '创建' },
  { key: 'actions', label: '', align: 'right' },
]

async function load() {
  loading.value = true
  try {
    const [kr, cr] = await Promise.all([adminApi.apikeys.list(), adminApi.clusters.list()])
    apikeys.value = kr.apikeys || []
    clusters.value = cr.clusters || []
  } catch (e) { notify('error', e.message || '加载失败') }
  finally { loading.value = false }
}
onMounted(() => { mintForm.value.owner = auth.user?.username || ''; load() })

async function doMint() {
  try {
    const res = await adminApi.apikeys.create(mintForm.value)
    newKey.value = res.apikey
    showMintModal.value = false
    mintForm.value = { owner: auth.user?.username || '', clusterId: '', boundSA_namespace: '', boundSA_name: '', tier: 'read', label: '' }
    notify('success', '已签发(明文仅此次可见,请立即复制)')
    load()
  } catch (e) { notify('error', e.message || '签发失败') }
}
async function copyPlaintext() {
  try { await navigator.clipboard.writeText(newKey.value.plaintext); notify('success', '已复制') }
  catch { notify('error', '复制失败,手动选中复制') }
}
async function doRevoke(k) {
  if (!confirm(`吊销 API key ${k.prefix}…(owner=${k.owner})?吊销后该 key 立即失效。`)) return
  try { await adminApi.apikeys.remove(k.id); notify('success', '已吊销'); load() }
  catch (e) { notify('error', e.message || '吊销失败') }
}
</script>

<template>
  <section class="animate-fade-in p-md">
    <div class="flex items-center justify-between mb-md">
      <div><h2 class="text-headline-lg font-bold text-on-surface">API Keys 管理</h2><p class="text-body-sm text-on-surface-variant mt-xs">签发/吊销 API key(绑定 K8s ServiceAccount,按 tier 授权;明文仅签发时可见)</p></div>
      <button @click="showMintModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
        <span class="material-symbols-outlined text-sm">add</span> 签发 API Key
      </button>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <DataTable v-else :headers="headers" :rows="apikeys">
      <template #prefix="{ row }"><span class="font-mono text-body-sm font-semibold">{{ row.prefix }}…</span></template>
      <template #tier="{ row }"><span class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="TIER_STYLE[row.tier]">{{ row.tier }}</span></template>
      <template #boundSA="{ row }"><span class="font-mono text-body-xs text-on-surface-variant">{{ row.boundSA_namespace }}/{{ row.boundSA_name }}</span></template>
      <template #cluster="{ row }"><span class="text-body-sm">{{ clusterName(row.clusterId) }}</span></template>
      <template #state="{ row }">
        <span v-if="row.revokedAt" class="text-body-xs text-error">已吊销</span>
        <span v-else class="text-body-xs text-status-running flex items-center gap-0.5"><span class="w-1.5 h-1.5 rounded-full bg-status-running inline-block"></span>active</span>
      </template>
      <template #created="{ row }"><span class="text-body-xs text-on-surface-variant">{{ fmt(row.createdAt) }}</span></template>
      <template #actions="{ row }">
        <button v-if="!row.revokedAt" @click.stop="doRevoke(row)" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error" title="吊销"><span class="material-symbols-outlined text-base">block</span></button>
      </template>
    </DataTable>

    <!-- 签发 Modal -->
    <Modal v-model="showMintModal" title="签发 API Key" width="max-w-xl">
      <div class="flex flex-col gap-md">
        <div class="grid grid-cols-2 gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">归属人(owner)</label><input v-model="mintForm.owner" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="alice" /></div>
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">标签(可选)</label><input v-model="mintForm.label" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="debug-laptop" /></div>
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">绑定集群</label>
          <select v-model="mintForm.clusterId" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
            <option value="" disabled>选择集群</option>
            <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }} ({{ c.apiServer }})</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">绑定 SA namespace</label><input v-model="mintForm.boundSA_namespace" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="default" /></div>
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">绑定 SA name</label><input v-model="mintForm.boundSA_name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="aliangboard-smoke" /></div>
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">权限档(tier)</label>
          <select v-model="mintForm.tier" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
            <option value="read">read(只读:get/list/logs/events/can_i)</option>
            <option value="operator">operator(read + scale/restart)</option>
            <option value="admin">admin(全部,含危险——仅 agent 人审路径)</option>
          </select>
        </div>
        <p class="text-body-xs text-on-surface-variant bg-surface-container-low rounded-lg p-sm">⚠️ 该 SA 必须已存在于集群(平台不自动建)。read/operator 档 SA 给 clusterrole=view 即可;SA 的 RBAC 决定 key 实际能做什么。</p>
      </div>
      <template #actions>
        <button @click="showMintModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
        <button @click="doMint" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">签发</button>
      </template>
    </Modal>

    <!-- 明文展示(仅此次)Modal -->
    <Modal :modelValue="!!newKey" @update:modelValue="v => { if (!v) newKey = null }" title="API Key 已签发(明文仅此次可见)" width="max-w-xl">
      <div v-if="newKey" class="flex flex-col gap-md">
        <div class="bg-error/5 border border-error/20 rounded-lg p-md">
          <p class="text-body-sm text-error font-semibold flex items-center gap-xs"><span class="material-symbols-outlined text-base">warning</span> 关闭后此明文不可再见(库里只存哈希)。立即复制并交给归属人。</p>
        </div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">明文 key</label>
          <div class="flex gap-xs">
            <input :value="newKey.plaintext" readonly class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
            <button @click="copyPlaintext" class="px-md py-sm bg-primary text-on-primary rounded-lg shrink-0 flex items-center gap-xs"><span class="material-symbols-outlined text-base">content_copy</span>复制</button>
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
        <button @click="newKey = null" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">我已复制保存</button>
      </template>
    </Modal>
  </section>
</template>
