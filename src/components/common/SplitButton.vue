<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useEscClose } from '@/composables/useEscClose'
import { useDropdownPanel } from '@/composables/useDropdownPanel'
import { useIsPhone } from '@/composables/useBreakpoint'
import { Z } from '@/styles/zScale'

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: String, default: '' },
  mainAction: { type: Function, required: true },
  items: { type: Array, default: () => [] }, // [{ label, icon?, action, danger?, disabled? }]
  disabled: { type: Boolean, default: false },
})

const open = ref(false)
useEscClose(open, () => { open.value = false })
// 菜单 Teleport body + fixed 锚定触发钮组(2026-09-01):桌面档消灭就地 absolute 被
// overflow 祖先裁切链;手机档固定底板 bottom sheet(与 DropdownMenu 同款配方)
const triggerRef = ref(null)
const { panelRef, panelStyle } = useDropdownPanel(triggerRef, open, { align: 'right' })
const { isPhone } = useIsPhone()
const phonePanelStyle = computed(() => ({ position: 'fixed', left: '0px', right: '0px', bottom: '0px', zIndex: String(Z.popover) }))

function run(item) {
  open.value = false
  if (typeof item.action === 'function') item.action()
}

// 卸载时收起,避免 Teleport 残留
onBeforeUnmount(() => { open.value = false })
</script>

<template>
  <div class="relative inline-flex" ref="triggerRef">
    <button type="button" :disabled="disabled" @click="mainAction()"
      class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-l-lg hover:opacity-90 active:scale-95 transition-all disabled:opacity-50 max-sm:min-h-[40px]">
      <span v-if="icon" class="material-symbols-outlined">{{ icon }}</span>
      {{ label }}
    </button>
    <button type="button" :disabled="disabled" @click="open = !open" :aria-expanded="open"
      class="px-1.5 bg-primary text-on-primary rounded-r-lg border-l border-on-primary/20 hover:opacity-90 active:scale-95 transition-all disabled:opacity-50 max-sm:min-h-[40px]">
      <span class="material-symbols-outlined text-xl">{{ open ? 'arrow_drop_up' : 'arrow_drop_down' }}</span>
    </button>
    <!-- 菜单:Teleport body + fixed(见脚本注释);遮罩仍在宿主子树,菜单在 body 根上下文
         Z.popover 恒高于遮罩(Z.popover-1),点菜单不触遮罩、点遮罩关菜单 -->
    <Teleport to="body">
      <div v-if="open" ref="panelRef" data-split-menu
        :style="isPhone ? phonePanelStyle : panelStyle"
        :class="isPhone
          ? 'w-full rounded-t-2xl rounded-b-none py-sm shadow-dropdown max-h-[70vh] overflow-y-auto'
          : 'min-w-[160px] rounded-lg py-xs'"
        class="bg-surface-container-lowest border border-outline-variant overflow-hidden"
        @click.stop>
        <button v-for="(item, idx) in items" :key="idx" type="button" :disabled="item.disabled" data-menu-item
          @click="run(item)"
          class="w-full flex items-center gap-sm px-md py-sm text-body-sm text-left hover:bg-surface-container-high disabled:opacity-50 max-sm:min-h-[40px]"
          :class="item.danger ? 'text-error' : 'text-on-surface'">
          <span v-if="item.icon" class="material-symbols-outlined text-lg">{{ item.icon }}</span>
          {{ item.label }}
        </button>
      </div>
    </Teleport>
    <div v-if="open" class="fixed inset-0" :style="{ zIndex: Z.popover - 1 }" @click="open = false"></div>
  </div>
</template>
