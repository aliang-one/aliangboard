<script setup>
import { ref } from 'vue'

const props = defineProps({
  tabs: { type: Array, required: true },
  modelValue: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue'])
const activeTab = ref(props.modelValue || props.tabs[0]?.key)

function selectTab(key) {
  activeTab.value = key
  emit('update:modelValue', key)
}
</script>

<template>
  <div class="flex border-b border-outline-variant bg-surface-container-low">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      @click="selectTab(tab.key)"
      class="px-xl py-4 flex items-center gap-2 border-b-2 font-medium transition-colors"
      :class="activeTab === tab.key
        ? 'border-primary text-primary font-bold'
        : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
    >
      <span v-if="tab.icon" class="material-symbols-outlined">{{ tab.icon }}</span>
      {{ tab.label }}
    </button>
  </div>
  <div class="flex-1 flex flex-col">
    <slot :activeTab="activeTab" />
  </div>
</template>
