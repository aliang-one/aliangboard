<script setup>
import { useToast } from '@/composables/useToast'

const { toast, dismissToast } = useToast()
</script>

<template>
  <Transition name="toast">
    <div
      v-if="toast"
      class="fixed top-lg right-lg z-[100] flex items-center gap-md px-lg py-md rounded-xl shadow-lg border max-w-md animate-fade-in"
      :class="toast.type === 'error'
        ? 'bg-error-container/95 border-error/40 text-on-error-container'
        : 'bg-surface-container-high border-outline-variant text-on-surface'"
      role="status"
    >
      <span class="material-symbols-outlined" :class="toast.type === 'error' ? 'text-error' : 'text-primary'">
        {{ toast.type === 'error' ? 'error' : 'check_circle' }}
      </span>
      <span class="text-body-sm font-medium break-words">{{ toast.message }}</span>
      <button class="ml-sm p-xs rounded-lg hover:bg-black/5 transition-colors" @click="dismissToast" aria-label="关闭">
        <span class="material-symbols-outlined text-base">close</span>
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
