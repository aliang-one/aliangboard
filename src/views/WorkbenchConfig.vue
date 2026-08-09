<script setup>
// 工作台配置 tab(P1 只读):集群绑定 / 项目根目录 / distill 状态。
// P1 不做编辑表单。
import { ref, onMounted } from 'vue'
import { authApi } from '@/api/client'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const clusters = ref([])

onMounted(async () => {
  try { const r = await authApi.myClusters(); clusters.value = r.clusters || [] } catch { /* 静默 */ }
})
</script>

<template>
  <div class="max-w-2xl space-y-md">
    <h3 class="text-body-md font-bold text-on-surface">{{ t('workbench.config.title') }}</h3>

    <!-- 集群绑定 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
      <div class="flex items-center gap-sm mb-sm">
        <span class="material-symbols-outlined text-primary text-lg">cloud</span>
        <span class="text-body-sm font-semibold">{{ t('workbench.config.cluster') }}</span>
      </div>
      <div v-for="c in clusters" :key="c.id" class="flex justify-between py-xs">
        <span class="text-body-sm text-on-surface">{{ c.name }}</span>
        <span class="font-mono text-body-xs text-on-surface-variant">{{ c.apiServer }}</span>
      </div>
      <p v-if="!clusters.length" class="text-body-xs text-on-surface-variant">—</p>
    </div>

    <!-- 项目根目录 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
      <div class="flex items-center gap-sm mb-sm">
        <span class="material-symbols-outlined text-primary text-lg">folder</span>
        <span class="text-body-sm font-semibold">{{ t('workbench.config.projectRoot') }}</span>
      </div>
      <code class="text-body-xs font-mono text-on-surface-variant">data/workbench/</code>
    </div>

    <!-- Distill 状态 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
      <div class="flex items-center gap-sm mb-sm">
        <span class="material-symbols-outlined text-primary text-lg">auto_fix_high</span>
        <span class="text-body-sm font-semibold">{{ t('workbench.config.distillStatus') }}</span>
      </div>
      <p class="text-body-xs text-on-surface-variant">DISTILL_INTERVAL_MS env {{ '=' + (typeof process !== 'undefined' ? 'server-side' : 'check gateway') }}</p>
    </div>
  </div>
</template>
