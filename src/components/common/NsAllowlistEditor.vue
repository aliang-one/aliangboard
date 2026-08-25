<script setup>
// ns allowlist 编辑器:boundSA_namespace 永远在(不可删)+ 额外 ns「下拉为主、手输兜底」双态。
// 候选 = clusterId 对应集群的真实 ns(经 useClusterNamespaces,key 绑定集群,非浏览器会话集群);
// 未选集群/拉取失败/候选全被已选排除 → 自动落手输态(可手动切回)。v-model 一个「额外 ns」数组。
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { useClusterNamespaces } from '@/composables/useClusterNamespaces'

const props = defineProps({
  boundNs: { type: String, default: '' },
  modelValue: { type: Array, default: () => [] },
  clusterId: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const mode = ref('select')   // 'select'(默认) | 'manual'
const input = ref('')
const errMsg = ref('')
const NS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const extra = computed(() => props.modelValue || [])
const { list, loading, error, load } = useClusterNamespaces(adminApi.clusters.namespaces)
watch(() => props.clusterId, id => load(id), { immediate: true })  // mint 切集群时候选跟随

const candidates = computed(() => list.value.filter(ns => ns !== props.boundNs && !extra.value.includes(ns)))
// 自动落手输的原因(空串 = 下拉可用)。候选全被排除时不静默——告诉用户为什么只剩手输。
const fallbackReason = computed(() => {
  if (!props.clusterId) return t('nsAllowlist.noCluster')
  if (error.value) return `${t('nsAllowlist.loadFailed')}: ${error.value.message || ''}`
  if (!loading.value && list.value.length && !candidates.value.length) return t('nsAllowlist.allAdded')
  return ''
})
watch(fallbackReason, r => { if (r) mode.value = 'manual' }, { immediate: true })  // 原因出现 → 自动落手输(切回下拉自由)

function commit(next) { emit('update:modelValue', next) }
function pick(e) {                 // 选中即加 chip,select 复位待连续添加
  const v = e.target.value
  e.target.value = ''
  if (v && !extra.value.includes(v)) commit([...extra.value, v])
}
function add() {                   // 手输路径(校验逻辑与旧版一致)
  const v = input.value.trim()
  if (!v) { input.value = ''; errMsg.value = ''; return }
  if (v === props.boundNs) { errMsg.value = t('nsAllowlist.dup'); input.value = ''; return }
  if (!NS_NAME.test(v) || v.length > 63) { errMsg.value = t('nsAllowlist.invalid'); input.value = ''; return }
  if (extra.value.includes(v)) { errMsg.value = t('nsAllowlist.dup'); input.value = ''; return }
  commit([...extra.value, v]); input.value = ''; errMsg.value = ''
}
function remove(ns) { commit(extra.value.filter(x => x !== ns)) }
</script>
<template>
  <div class="bg-surface-container-low border border-outline-variant rounded-lg p-sm flex flex-col gap-xs">
    <div class="flex flex-wrap gap-1 items-center">
      <span v-if="boundNs" class="px-1.5 py-0.5 rounded text-body-xs font-mono bg-primary/15 text-primary">{{ boundNs }}</span>
      <span v-if="boundNs" class="text-body-xs text-on-surface-variant">{{ t('nsAllowlist.boundAlways') }}</span>
      <span v-for="ns in extra" :key="ns" class="px-1.5 py-0.5 rounded text-body-xs font-mono bg-status-running/15 text-status-running flex items-center gap-0.5">
        {{ ns }}<button type="button" @click="remove(ns)" class="hover:text-error">×</button>
      </span>
    </div>
    <div class="flex items-center gap-xs">
      <select v-if="mode === 'select'" data-testid="ns-select" :disabled="loading"
        class="flex-1 bg-surface border-b border-outline-variant text-body-xs font-mono px-1 py-0.5 outline-none focus:border-primary"
        @change="pick">
        <option value="" disabled selected>{{ loading ? t('nsAllowlist.loading') : t('nsAllowlist.selectPlaceholder') }}</option>
        <option v-for="ns in candidates" :key="ns" :value="ns">{{ ns }}</option>
      </select>
      <input v-else v-model="input" data-testid="ns-manual-input" @keydown.enter.prevent="add" :placeholder="t('nsAllowlist.addPlaceholder')"
        class="flex-1 bg-transparent border-b border-outline-variant text-body-xs font-mono px-1 py-0.5 outline-none focus:border-primary min-w-[12rem]" />
      <button type="button" data-testid="ns-mode-toggle" class="text-body-xs text-primary underline underline-offset-2 shrink-0"
        @click="mode = mode === 'select' ? 'manual' : 'select'">
        {{ mode === 'select' ? t('nsAllowlist.switchToManual') : t('nsAllowlist.switchToSelect') }}
      </button>
    </div>
    <p v-if="errMsg" class="text-body-xs text-error">{{ errMsg }}</p>
    <p v-if="fallbackReason" class="text-body-xs text-on-surface-variant">{{ fallbackReason }}</p>
  </div>
</template>
