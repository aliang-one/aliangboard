<script setup>
import { ref } from 'vue'
import { useEscClose } from '@/composables/useEscClose'

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: String, default: '' },
  mainAction: { type: Function, required: true },
  items: { type: Array, default: () => [] }, // [{ label, icon?, action, danger?, disabled? }]
  disabled: { type: Boolean, default: false },
})

const open = ref(false)
useEscClose(open, () => { open.value = false })

function run(item) {
  open.value = false
  if (typeof item.action === 'function') item.action()
}
</script>

<template>
  <div class="relative inline-flex">
    <button type="button" :disabled="disabled" @click="mainAction()"
      class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-l-lg hover:opacity-90 active:scale-95 transition-all disabled:opacity-50 max-sm:min-h-[40px]">
      <span v-if="icon" class="material-symbols-outlined">{{ icon }}</span>
      {{ label }}
    </button>
    <button type="button" :disabled="disabled" @click="open = !open" :aria-expanded="open"
      class="px-1.5 bg-primary text-on-primary rounded-r-lg border-l border-on-primary/20 hover:opacity-90 active:scale-95 transition-all disabled:opacity-50 max-sm:min-h-[40px]">
      <span class="material-symbols-outlined text-xl">{{ open ? 'arrow_drop_up' : 'arrow_drop_down' }}</span>
    </button>
    <!-- 点击外部关闭(同 DropdownMenu 模式)-->
    <div v-if="open" class="fixed inset-0 z-30" @click="open = false"></div>
    <div v-if="open" class="absolute right-0 top-full mt-1 min-w-[180px] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-40 py-1" data-split-menu>
      <button v-for="(item, idx) in items" :key="idx" type="button" :disabled="item.disabled" data-menu-item
        @click="run(item)"
        class="w-full flex items-center gap-sm px-md py-sm text-body-sm text-left hover:bg-surface-container-high disabled:opacity-50 max-sm:min-h-[40px]"
        :class="item.danger ? 'text-error' : 'text-on-surface'">
        <span v-if="item.icon" class="material-symbols-outlined text-lg">{{ item.icon }}</span>
        {{ item.label }}
      </button>
    </div>
  </div>
</template>
