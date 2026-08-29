<script setup>
// 通用确认弹窗(2026-08-29 用户中心设计 §2.2):基于 Modal 收敛「标题+文案+确认/取消」;
// danger 态确认钮 error 色(登出/吊销会话)。confirm 不自动关窗——调用方在成功回调里关,
// 失败时窗留着可重试。存量原生 confirm() 的替换为 follow-up(F3),不在本期。
import Modal from './Modal.vue'
import { useI18n } from 'vue-i18n'

defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '' },  // 缺省用 component.confirmDialog.confirm
  cancelText: { type: String, default: '' },
  danger: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])
const { t } = useI18n()
function onCancel() { emit('update:modelValue', false); emit('cancel') }
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="title"
    width="max-w-md"
    @update:model-value="v => { if (!v) onCancel() }"
  >
    <p class="text-body-md text-on-surface-variant">{{ message }}</p>
    <template #actions>
      <button
        data-testid="confirm-cancel"
        class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high"
        @click="onCancel"
      >{{ cancelText || t('component.confirmDialog.cancel') }}</button>
      <button
        data-testid="confirm-ok"
        :disabled="loading"
        class="px-md py-sm rounded-lg text-body-md font-semibold disabled:opacity-50"
        :class="danger ? 'bg-error text-on-error' : 'bg-primary text-on-primary'"
        @click="emit('confirm')"
      >{{ confirmText || t('component.confirmDialog.confirm') }}</button>
    </template>
  </Modal>
</template>
