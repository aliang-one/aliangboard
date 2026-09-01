<script setup>
import { ref, onBeforeUnmount } from 'vue'
import { useDropdownPanel } from '@/composables/useDropdownPanel'

const props = defineProps({
  // 菜单项：[{ label, icon, action: Function, danger?: bool, disabled?: bool }]
  items: { type: Array, default: () => [] },
  // 触发按钮的图标，默认 more_vert
  triggerIcon: { type: String, default: 'more_vert' },
  // 触发按钮的 title/aria-label
  triggerLabel: { type: String, default: 'Actions' },
})

const open = ref(false)
// 菜单 Teleport body + fixed 锚定触发钮(2026-09-01):表格 #actions 场景里就地 absolute
// 菜单被 DataTable 根 overflow-hidden / overflow-x-auto 裁切;配方=useDropdownPanel(issue#4)
const triggerRef = ref(null)
const { panelRef, panelStyle } = useDropdownPanel(triggerRef, open, { align: 'right' })

function toggle(e) {
  e.stopPropagation()
  open.value = !open.value
}

function close() {
  open.value = false
}

function run(item) {
  if (item.disabled) return
  close()
  item.action && item.action()
}

// 卸载时收起，避免残留
onBeforeUnmount(close)
</script>

<template>
  <div class="relative inline-block">
    <button
      ref="triggerRef"
      @click="toggle($event)"
      class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-colors"
      :aria-label="triggerLabel"
      :title="triggerLabel"
    >
      <span class="material-symbols-outlined text-lg">{{ triggerIcon }}</span>
    </button>

    <!-- 菜单:Teleport body + fixed(见脚本注释);遮罩仍在宿主子树,菜单在 body 根上下文
         Z.popover(110) 恒高于遮罩 z-30,点菜单不触遮罩、点遮罩关菜单 -->
    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        data-testid="dropdown-menu-panel"
        :style="panelStyle"
        class="min-w-[160px] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown py-xs overflow-hidden"
        @click.stop
      >
        <button
          v-for="(item, idx) in items"
          :key="idx"
          @click="run(item)"
          :disabled="item.disabled"
          class="w-full flex items-center gap-sm px-md py-sm text-left text-body-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          :class="item.danger
            ? 'text-error hover:bg-error-container/10'
            : 'text-on-surface hover:bg-surface-container'"
        >
          <span class="material-symbols-outlined text-lg">{{ item.icon }}</span>
          <span class="font-medium">{{ item.label }}</span>
        </button>
      </div>
    </Teleport>

    <!-- 点击外部关闭的遮罩 -->
    <!-- .stop:遮罩虽 fixed 但 DOM 上是宿主元素的子孙——不加 stop,「点外部关菜单」
         会冒泡到宿主的 @click(如项目卡点击即导航)变成误导航(终审 I1) -->
    <div v-if="open" class="fixed inset-0 z-30" @click.stop="close"></div>
  </div>
</template>
