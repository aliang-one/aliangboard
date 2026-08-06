<script setup>
import { useI18n } from 'vue-i18n'
// 统一异步数据状态容器：loading / error / empty / 内容(default slot)。
// 供各页面统一加载/错误/空态（Phase 2 Vue Query 迁移后尤甚），替代每页手搓 spinner。
// 多根模板：内容态直出 slot（不套 wrapper），避免破坏表格/列表等满宽布局。
const { t } = useI18n()
const props = defineProps({
  loading: { type: Boolean, default: false },
  error: { type: [Boolean, String, Object, Error], default: null }, // truthy → 错误态
  empty: { type: Boolean, default: false },
  emptyText: { type: String, default: '' },
  errorText: { type: String, default: '' }, // 覆盖默认错误文案
  retry: { type: Function, default: null }, // 提供则显示「重试」按钮
})
function errMsg() {
  if (!props.error) return ''
  if (props.errorText) return props.errorText
  if (typeof props.error === 'string') return props.error
  return props.error?.message || t('component.asyncState.loadFailed')
}
</script>

<template>
  <div v-if="loading" class="w-full flex flex-col items-center justify-center py-xl gap-sm text-on-surface-variant">
    <span class="material-symbols-outlined text-4xl animate-spin">progress_activity</span>
    <span class="text-body-sm">{{ t('common.loading') }}</span>
  </div>
  <div v-else-if="error" class="w-full flex flex-col items-center justify-center py-xl gap-sm text-error">
    <span class="material-symbols-outlined text-4xl">error</span>
    <span class="text-body-sm">{{ errMsg() }}</span>
    <button v-if="retry" @click="retry"
      class="mt-xs px-md py-xs rounded-lg bg-primary text-on-primary text-body-sm hover:opacity-90 transition">{{ t('component.asyncState.retry') }}</button>
  </div>
  <div v-else-if="empty" class="w-full flex flex-col items-center justify-center py-xl gap-sm text-on-surface-variant">
    <span class="material-symbols-outlined text-4xl">inbox</span>
    <span class="text-body-sm">{{ emptyText || t('common.noData') }}</span>
  </div>
  <slot v-else />
</template>
