<script setup>
// 工作台配置 tab:集群绑定 / 项目根目录 / distill 状态 / 悬浮对话入口配置。
import { ref, onMounted } from 'vue'
import { authApi, adminApi } from '@/api/client'
import { useI18n } from 'vue-i18n'
import { notify } from '@/composables/useToast'

const { t } = useI18n()
const clusters = ref([])

// 悬浮对话入口(2026-08-17 近期动态模型):展示条数/隐去时间,admin 可配,保存约 10s 内全端生效。
const presence = ref({ maxItems: 5, windowMin: 30 })
const presenceSaving = ref(false)

onMounted(async () => {
  // 并行拉,各自 try/catch 兜底(非 admin/未配置 → 默认)。注意:调用须在 try 内——
  // _allViewsMount 的 Proxy 桩对缺属性会同步抛,Promise.allSettled 罩不住同步 throw。
  await Promise.all([
    (async () => { try { const r = await authApi.myClusters(); clusters.value = r.clusters || [] } catch { /* 静默 */ } })(),
    (async () => { try { const r = await adminApi.presenceConfig.get(); presence.value = { maxItems: r.maxItems, windowMin: r.windowMin } } catch { /* 非 admin/未配置 → 默认 */ } })(),
  ])
})

async function savePresence() {
  presenceSaving.value = true
  try {
    await adminApi.presenceConfig.save({ maxItems: Number(presence.value.maxItems), windowMin: Number(presence.value.windowMin) })
    notify('success', t('workbench.config.presenceSaved'))
  } catch { notify('error', t('workbench.config.presenceSaveFailed')) }
  finally { presenceSaving.value = false }
}
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

    <!-- 悬浮对话入口(2026-08-17 近期动态模型):展示条数/隐去时间,admin 可配,保存约 10s 内全端生效 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
      <div class="flex items-center gap-sm mb-sm">
        <span class="material-symbols-outlined text-primary text-lg">smart_toy</span>
        <span class="text-body-sm font-semibold">{{ t('workbench.config.presenceTitle') }}</span>
      </div>
      <div class="flex items-end gap-md flex-wrap">
        <label class="flex flex-col gap-xs">
          <span class="text-body-xs text-on-surface-variant">{{ t('workbench.config.presenceMaxItems') }}</span>
          <input v-model.number="presence.maxItems" type="number" min="1" max="20" data-testid="presence-max"
            class="w-24 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-sm" />
        </label>
        <label class="flex flex-col gap-xs">
          <span class="text-body-xs text-on-surface-variant">{{ t('workbench.config.presenceWindowMin') }}</span>
          <input v-model.number="presence.windowMin" type="number" min="1" max="1440" data-testid="presence-window"
            class="w-24 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-sm" />
        </label>
        <button data-testid="presence-save" @click="savePresence" :disabled="presenceSaving"
          class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 disabled:opacity-40">
          {{ t('workbench.config.presenceSave') }}
        </button>
      </div>
      <p class="text-body-xs text-on-surface-variant mt-sm">{{ t('workbench.config.presenceHint') }}</p>
    </div>
  </div>
</template>
