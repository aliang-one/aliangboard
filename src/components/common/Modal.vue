<script setup>
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEscClose } from '@/composables/useEscClose'
import { Z } from '@/styles/zScale'

const { t } = useI18n()

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: String, default: 'max-w-lg' },
  fullscreen: { type: Boolean, default: false },
  // 优先层(2026-08-27):阻塞式弹窗(如 AI 审批)用它盖过一切普通 modal——Modal 都 Teleport
  // 到 body 且同 Z.modal 时按 DOM 序层叠,后打开的普通 modal(悬浮 ChatModal)会盖住先弹的审批。
  priority: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])

function close() {
  emit('update:modelValue', false)
  emit('cancel')
}

// ESC 关闭:行为同 Cancel/X/点遮罩;层叠时只关栈顶(见 useEscClose)。
const isOpen = computed(() => props.modelValue)
useEscClose(isOpen, close)

function confirm() {
  emit('confirm')
  close()
}
</script>

<template>
  <Teleport to="body">
    <transition name="fade">
      <div v-if="modelValue" class="fixed inset-0 flex items-center justify-center" :style="{ zIndex: props.priority ? Z.modalPriority : Z.modal }">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-on-surface/30 backdrop-blur-sm" @click="close"></div>
        <!-- Dialog -->
        <div :class="fullscreen
            ? 'w-full h-full max-w-none rounded-none flex flex-col'
            : [width, 'max-h-[90vh] overflow-y-auto p-lg rounded-xl']"
          class="relative w-full bg-surface-container-lowest border border-outline-variant shadow-dropdown z-10 animate-slide-up">
          <div v-if="title" class="flex justify-between items-center" :class="fullscreen ? 'shrink-0 px-lg py-md border-b border-outline-variant' : 'mb-lg'">
            <h3 class="text-headline-sm font-bold">{{ title }}</h3>
            <button @click="close" class="p-1 text-on-surface-variant hover:bg-surface-container rounded-lg">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
          <div :class="fullscreen ? 'flex-1 overflow-y-auto p-lg' : ''"><slot /></div>
          <div v-if="$slots.actions" class="flex justify-end gap-md" :class="fullscreen ? 'shrink-0 px-lg py-md border-t border-outline-variant' : 'mt-lg pt-md border-t border-outline-variant'">
            <slot name="actions">
              <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('component.modal.cancel') }}</button>
              <button @click="confirm" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold">{{ t('component.modal.confirm') }}</button>
            </slot>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>
