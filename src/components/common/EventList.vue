<template>
  <div class="flex flex-col gap-md">
    <div v-for="(event, idx) in list" :key="idx" data-testid="event-row"
      :class="rowClass(event)"
      @click="onRowClick(event)">
      <template v-if="compact">
        <span class="material-symbols-outlined text-base mt-0.5"
          :class="event.color === 'primary' ? 'text-primary' : 'text-tertiary-container'">{{ event.icon }}</span>
        <div>
          <p class="text-body-sm font-medium">{{ event.reason }}</p>
          <p class="text-body-sm text-on-surface-variant">{{ event.time }}</p>
        </div>
      </template>
      <template v-else>
        <div class="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
          :class="event.color === 'primary' ? 'bg-primary-container text-on-primary-container' : event.color === 'error' ? 'bg-error-container text-on-error-container' : 'bg-surface-container text-on-surface-variant'">
          <span class="material-symbols-outlined text-lg">{{ event.icon }}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex justify-between items-start gap-sm">
            <h4 class="text-body-md font-semibold">{{ event.reason }}</h4>
            <span class="font-mono text-code-sm text-on-surface-variant shrink-0">{{ event.time }}</span>
          </div>
          <p class="text-body-sm text-on-surface-variant mt-xs">{{ event.message }}</p>
          <div v-if="event.relatedKind" class="mt-xs inline-flex items-center gap-xs px-sm py-xs bg-primary-container/10 text-primary text-xs rounded-full">
            <span class="material-symbols-outlined text-sm">link</span>
            <span class="font-mono">{{ event.relatedKind }}/{{ event.relatedName }}</span>
            <span class="material-symbols-outlined text-sm">chevron_right</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  max: { type: Number, default: 0 },
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['navigate'])

const list = computed(() => (props.max > 0 ? props.events.slice(0, props.max) : props.events))

function rowClass(event) {
  if (props.compact) return 'flex gap-sm'
  const clickable = event.relatedKind ? 'cursor-pointer hover:bg-surface-container-low/50 rounded-lg -mx-sm px-sm py-xs transition-colors' : ''
  return ['flex gap-md border-b border-outline-variant pb-md', clickable]
}
function onRowClick(event) {
  if (!props.compact && event.relatedKind) emit('navigate', event)
}
</script>
