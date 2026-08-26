<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
const props = defineProps({ state: { type: String, default: 'off' } })
const { t } = useI18n()
const META = {
  live: { icon: 'podcasts', key: 'common.watchLive', cls: 'text-primary' },
  reconnecting: { icon: 'sync', key: 'common.watchReconnecting', cls: 'text-on-surface-variant animate-pulse' },
  degraded: { icon: 'cloud_off', key: 'common.watchDegraded', cls: 'text-tertiary' },
}
const meta = computed(() => META[props.state])
</script>
<template>
  <span v-if="meta" :class="['inline-flex items-center gap-1 text-xs', meta.cls]">
    <span class="material-symbols-outlined text-sm">{{ meta.icon }}</span>{{ t(meta.key) }}
  </span>
</template>
