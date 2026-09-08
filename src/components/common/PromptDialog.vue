<script setup>
// 通用单输入弹窗(2026-09-08 文件三件套):标题+说明+单输入+确认/取消,基于 Modal
// (与 ConfirmDialog 同骨架)。两种形态:
// - 普通输入(新建文件夹/重命名):enter 即确认;
// - 危险输名字确认(requireText,SSH 删目录):输入与要求文本完全一致才亮确认钮——
//   type-to-confirm 是真机不可逆操作的最后一道闸。
// confirm 不自动关窗——调用方在成功回调里关,失败时窗留着可重试(与 ConfirmDialog 同约)。
import { ref, watch } from 'vue'
import Modal from './Modal.vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  message: { type: String, default: '' },          // 输入框上方说明(删除类放目标路径)
  label: { type: String, default: '' },
  initialValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  confirmText: { type: String, default: '' },      // 缺省用 component.confirmDialog.confirm
  cancelText: { type: String, default: '' },
  danger: { type: Boolean, default: false },
  requireText: { type: String, default: '' },      // 非空=输名字确认模式
  loading: { type: Boolean, default: false },
  selectAll: { type: Boolean, default: false },    // 打开时全选初始值(重命名场景改后缀更省)
})
const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])
const { t } = useI18n()

const value = ref(props.initialValue)
// 每次打开重置为初始值(同窗复用于多个目标时不清旧草稿)
watch(() => props.modelValue, open => {
  if (open) {
    value.value = props.initialValue
    if (props.selectAll) requestAnimationFrame(() => { try { document.querySelector('[data-testid="prompt-input"]')?.select() } catch { /* noop */ } })
  }
})

const trimmed = () => value.value.trim()
const gated = () => !!props.requireText && value.value !== props.requireText
function onCancel() { emit('update:modelValue', false); emit('cancel') }
function onConfirm() { if (gated() || props.loading || !trimmed()) return; emit('confirm', trimmed()) }
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="title"
    width="max-w-md"
    @update:model-value="v => { if (!v) onCancel() }"
  >
    <p v-if="message" class="text-body-md text-on-surface-variant break-all mb-sm">{{ message }}</p>
    <label v-if="label" class="block text-body-sm text-on-surface-variant mb-xs">{{ label }}</label>
    <input
      v-model="value" data-testid="prompt-input" type="text"
      class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-sm font-mono text-body-sm text-on-surface focus:outline-none focus:ring-2"
      :class="danger ? 'focus:ring-error' : 'focus:ring-primary'"
      :placeholder="placeholder"
      :disabled="loading"
      @keydown.enter.prevent="onConfirm"
      @keydown.esc.prevent="onCancel"
    >
    <p v-if="requireText" class="mt-xs text-body-xs text-error">
      {{ t('component.promptDialog.typeToConfirm', { text: requireText }) }}
    </p>
    <template #actions>
      <button
        data-testid="prompt-cancel"
        class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high"
        @click="onCancel"
      >{{ cancelText || t('component.confirmDialog.cancel') }}</button>
      <button
        data-testid="prompt-ok"
        :disabled="gated() || loading || !trimmed()"
        class="px-md py-sm rounded-lg text-body-md font-semibold disabled:opacity-50"
        :class="danger ? 'bg-error text-on-error' : 'bg-primary text-on-primary'"
        @click="onConfirm"
      >{{ confirmText || t('component.confirmDialog.confirm') }}</button>
    </template>
  </Modal>
</template>
