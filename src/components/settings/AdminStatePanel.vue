<script setup>
// 状态总览面板(spec §9.2):admin 只读——按域分组的登记状态表 + 清扫运行表。
// 手动刷新 + 可选 10s 自动刷新;聚合值 only(值与键永不下发,端点侧保证)。
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'

const { t } = useI18n()
const data = ref(null)
const loading = ref(false)
const error = ref('')
const auto = ref(false)
let timer = null

const byDomain = computed(() => {
  const groups = new Map()
  for (const s of data.value?.stores || []) {
    if (!groups.has(s.domain)) groups.set(s.domain, [])
    groups.get(s.domain).push(s)
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})

async function refresh() {
  loading.value = true; error.value = ''
  try { data.value = await adminApi.state.get() }
  catch (e) { error.value = String(e?.message || e) }
  finally { loading.value = false }
}
function setAuto(v) {
  if (timer) { clearInterval(timer); timer = null }
  if (v) timer = setInterval(refresh, 10_000)
}
onMounted(refresh)
onBeforeUnmount(() => setAuto(false))
</script>

<template>
  <div>
    <div class="flex items-center gap-3 mb-4 flex-wrap">
      <h3 class="text-lg font-semibold">{{ t('adminState.title') }}</h3>
      <button class="px-3 py-1.5 rounded-lg bg-primary-container text-on-primary-container text-sm"
        :disabled="loading" @click="refresh">{{ t('adminState.refresh') }}</button>
      <label class="flex items-center gap-1.5 text-sm text-on-surface-variant">
        <input type="checkbox" :checked="auto" @change="e => { auto = e.target.checked; setAuto(auto) }">
        {{ t('adminState.autoRefresh') }}
      </label>
    </div>
    <p v-if="error" class="text-sm text-error mb-2">{{ error }}</p>
    <div v-for="[domain, stores] in byDomain" :key="domain" class="mb-5">
      <div class="text-xs font-semibold uppercase tracking-wide text-on-surface-variant mb-1">{{ domain }}</div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm min-w-[480px]">
          <thead><tr class="text-left text-on-surface-variant border-b border-outline-variant">
            <th class="py-1.5 pr-4">{{ t('adminState.name') }}</th>
            <th class="py-1.5 pr-4">{{ t('adminState.primitive') }}</th>
            <th class="py-1.5 pr-4">{{ t('adminState.entries') }}</th>
            <th class="py-1.5 pr-4">{{ t('adminState.ttl') }}</th>
            <th class="py-1.5">{{ t('adminState.expired') }}</th>
          </tr></thead>
          <tbody>
            <tr v-for="s in stores" :key="s.name" class="border-b border-outline-variant/50">
              <td class="py-1.5 pr-4 font-mono text-xs">{{ s.name }}</td>
              <td class="py-1.5 pr-4">{{ s.primitive }}</td>
              <td class="py-1.5 pr-4">{{ s.entries ?? s.meta_entries ?? '—' }}</td>
              <td class="py-1.5 pr-4">{{ s.ttlMs != null ? Math.round(s.ttlMs / 1000) + 's' : (s.windowMs ? Math.round(s.windowMs / 1000) + 's' : '—') }}</td>
              <td class="py-1.5">{{ s.expired ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-if="data?.sweeps?.length" class="mb-4">
      <div class="text-xs font-semibold uppercase tracking-wide text-on-surface-variant mb-1">{{ t('adminState.sweeps') }}</div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm min-w-[560px]">
          <thead><tr class="text-left text-on-surface-variant border-b border-outline-variant">
            <th class="py-1.5 pr-4">{{ t('adminState.name') }}</th>
            <th class="py-1.5 pr-4">{{ t('adminState.cadence') }}</th>
            <th class="py-1.5 pr-4">{{ t('adminState.runs') }}</th>
            <th class="py-1.5">{{ t('adminState.lastError') }}</th>
          </tr></thead>
          <tbody>
            <tr v-for="sw in data.sweeps" :key="sw.name" class="border-b border-outline-variant/50">
              <td class="py-1.5 pr-4 font-mono text-xs">{{ sw.name }}</td>
              <td class="py-1.5 pr-4">{{ Math.round(sw.cadenceMs / 1000) }}s</td>
              <td class="py-1.5 pr-4">{{ sw.runs }}</td>
              <td class="py-1.5" :class="sw.lastError ? 'text-error font-mono text-xs' : 'text-on-surface-variant'">{{ sw.lastError || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <p v-if="data && !data.stores.length" class="text-sm text-on-surface-variant">{{ t('adminState.empty') }}</p>
  </div>
</template>
