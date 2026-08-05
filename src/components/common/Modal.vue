<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: String, default: 'max-w-lg' },
})

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])

function close() {
  emit('update:modelValue', false)
  emit('cancel')
}

function confirm() {
  emit('confirm')
  close()
}
</script>

<template>
  <Teleport to="body">
    <transition name="fade">
      <div v-if="modelValue" class="fixed inset-0 z-[100] flex items-center justify-center">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-on-surface/30 backdrop-blur-sm" @click="close"></div>
        <!-- Dialog -->
        <div :class="width" class="relative w-full bg-surface-container-lowest rounded-xl border border-outline-variant shadow-dropdown p-lg z-10 animate-slide-up">
          <div v-if="title" class="flex justify-between items-center mb-lg">
            <h3 class="text-headline-sm font-bold">{{ title }}</h3>
            <button @click="close" class="p-1 text-on-surface-variant hover:bg-surface-container rounded-lg">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
          <slot />
          <div v-if="$slots.actions" class="flex justify-end gap-md mt-lg pt-md border-t border-outline-variant">
            <slot name="actions">
              <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
              <button @click="confirm" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold">Confirm</button>
            </slot>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>
