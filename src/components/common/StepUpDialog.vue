<script setup>
// 身份重验证弹窗(W3 §2/Task 4,可复用):账户安全面操作(disable/setup 重置/enable 重置/改密)
// 距上次强认证 >10min → 服务端 409 {stepUpRequired};消费方拦截该形状挂本弹窗,验过
// (POST /api/auth/step-up)emit done,由消费方重放原动作。失败行内提示可重试
// (恢复码在 step-up 不即焚,裁决 R2)。
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import Modal from '@/components/common/Modal.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
})
const emit = defineEmits(['done', 'close'])

const { t } = useI18n()
const code = ref('')
const error = ref('')
const loading = ref(false)

// 每次打开重置(重放场景上次的失败文案不残留)
watch(() => props.visible, (v) => { if (v) { code.value = ''; error.value = ''; loading.value = false } })

function close() { emit('close') }

async function submit() {
  const c = code.value.trim()
  if (!c || loading.value) { if (!c) error.value = t('userCenter.mfa.codeMissing'); return }
  loading.value = true
  error.value = ''
  try {
    await authApi.stepUp(c)
    close()
    emit('done')
  } catch (e) {
    error.value = e.message || t('common.opFailed')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <Modal :model-value="visible" :title="$t('userCenter.mfa.stepUpTitle')" width="max-w-sm"
    @update:model-value="(v) => { if (!v) close() }">
    <div class="flex flex-col gap-md">
      <p class="text-body-sm text-on-surface-variant">{{ $t('userCenter.mfa.stepUpHint') }}</p>
      <input v-model="code" data-testid="stepup-input" type="text" inputmode="numeric" autocomplete="one-time-code"
        :placeholder="$t('userCenter.mfa.codePlaceholder')" @keydown.enter="submit"
        class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md tracking-widest focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all" />
      <p v-if="error" data-testid="stepup-error" class="text-body-sm text-error bg-error-container/10 rounded-lg px-md py-sm">{{ error }}</p>
      <div class="flex justify-end gap-sm">
        <button data-testid="stepup-cancel"
          class="px-md py-sm rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container-high"
          @click="close">{{ $t('common.cancel') }}</button>
        <button data-testid="stepup-submit" :disabled="loading"
          class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm disabled:opacity-50"
          @click="submit">{{ $t('userCenter.mfa.stepUpConfirm') }}</button>
      </div>
    </div>
  </Modal>
</template>
