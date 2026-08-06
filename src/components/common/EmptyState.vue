<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps({
  icon: { type: String, default: 'inbox' },
  title: { type: String, default: '' },
  description: { type: String, default: '' },
})

const titleText = computed(() => props.title || t('common.noData'))
</script>

<template>
  <div class="flex flex-col items-center justify-center py-2xl text-center">
    <div class="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-lg">
      <span class="material-symbols-outlined text-on-surface-variant text-3xl">{{ icon }}</span>
    </div>
    <h3 class="text-headline-sm font-semibold text-on-surface mb-sm">{{ titleText }}</h3>
    <p v-if="description" class="text-body-md text-on-surface-variant max-w-md">{{ description }}</p>
    <slot />
  </div>
</template>
