<script setup>
import { ref, onBeforeUnmount } from 'vue'

const props = defineProps({
  // 菜单项：[{ label, icon, action: Function, danger?: bool, disabled?: bool }]
  items: { type: Array, default: () => [] },
  // 触发按钮的图标，默认 more_vert
  triggerIcon: { type: String, default: 'more_vert' },
  // 触发按钮的 title/aria-label
  triggerLabel: { type: String, default: 'Actions' },
})

const open = ref(false)

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
      @click="toggle($event)"
      class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-colors"
      :aria-label="triggerLabel"
      :title="triggerLabel"
    >
      <span class="material-symbols-outlined text-lg">{{ triggerIcon }}</span>
    </button>

    <!-- 菜单 -->
    <div
      v-if="open"
      class="absolute right-0 top-full mt-1 min-w-[160px] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-40 py-xs overflow-hidden"
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

    <!-- 点击外部关闭的遮罩 -->
    <!-- .stop:遮罩虽 fixed 但 DOM 上是宿主元素的子孙——不加 stop,「点外部关菜单」
         会冒泡到宿主的 @click(如项目卡点击即导航)变成误导航(终审 I1) -->
    <div v-if="open" class="fixed inset-0 z-30" @click.stop="close"></div>
  </div>
</template>
