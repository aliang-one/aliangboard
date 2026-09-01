<script setup>
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEscClose } from '@/composables/useEscClose'
import { useIsPhone } from '@/composables/useBreakpoint'
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
  // 可最大化(2026-08-29):标题栏出现「最大化/还原」切换;ESC 先还原再关闭。
  maximizable: { type: Boolean, default: false },
  // 关闭守卫(2026-08-29 QA ISSUE-03):X/遮罩/ESC 关闭前回调,返回 false 拦截本次关闭
  // (如编辑态有未保存改动时弹丢弃确认)。取消按钮等内容自管理路径不经此。
  beforeClose: { type: Function, default: null },
})

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])

function close() {
  if (props.beforeClose && props.beforeClose() === false) return
  emit('update:modelValue', false)
  emit('cancel')
}

// 最大化状态:内部自持(非受控);关闭即重置(重开必为普通态),跨内容切换保持。
const maximized = ref(false)
watch(() => props.modelValue, v => { if (!v) maximized.value = false })

const { isPhone } = useIsPhone()

// 全屏形态共用既有 fullscreen 三段式布局;手机档(<640)一律全屏(2026-09-01 手机适配:
// 46 个消费方零改动自动生效,width prop 手机档忽略——maxLayout 分支不含 width 类)
const isMaxLayout = computed(() => props.fullscreen || maximized.value || isPhone.value)

// ESC 关闭:行为同 Cancel/X/点遮罩;层叠时只关栈顶(见 useEscClose)。
// 最大化时 ESC 先还原,再次 ESC 才关闭(防误触丢表单)。
const isOpen = computed(() => props.modelValue)
useEscClose(isOpen, () => { maximized.value ? (maximized.value = false) : close() })

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
        <div :class="isMaxLayout
            ? 'w-full h-full max-w-none rounded-none flex flex-col'
            : [width, 'max-h-[90vh] overflow-y-auto p-lg rounded-xl']"
          class="relative w-full bg-surface-container-lowest border border-outline-variant shadow-dropdown z-10 animate-slide-up">
          <div v-if="title" class="flex justify-between items-center" :class="isMaxLayout ? 'shrink-0 px-lg py-md border-b border-outline-variant' : 'mb-lg'">
            <h3 class="text-headline-sm font-bold">{{ title }}</h3>
            <div class="flex items-center gap-xs">
              <button v-if="maximizable" @click="maximized = !maximized"
                :data-testid="maximized ? 'modal-restore-btn' : 'modal-maximize-btn'"
                :title="maximized ? t('component.modal.restore') : t('component.modal.maximize')"
                :aria-label="maximized ? t('component.modal.restore') : t('component.modal.maximize')"
                class="p-1 text-on-surface-variant hover:bg-surface-container rounded-lg">
                <span class="material-symbols-outlined">{{ maximized ? 'close_fullscreen' : 'open_in_full' }}</span>
              </button>
              <button @click="close" class="p-1 text-on-surface-variant hover:bg-surface-container rounded-lg">
                <span class="material-symbols-outlined">close</span>
              </button>
            </div>
          </div>
          <div :class="isMaxLayout ? ['flex-1 overflow-y-auto p-lg', 'max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+16px)]'] : ''"><slot :maximized="maximized" /></div>
          <div v-if="$slots.actions" class="flex justify-end gap-md" :class="isMaxLayout ? 'shrink-0 px-lg py-md border-t border-outline-variant' : 'mt-lg pt-md border-t border-outline-variant'"
            :style="isMaxLayout && isPhone ? { paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' } : null"
            :data-safe-area="isMaxLayout && isPhone ? '' : null">
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
