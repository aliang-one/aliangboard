<script setup>
// 拓扑 flow 节点:标签消费者(PDB/NetPol)小卡——无连线(selector 选 Pod 非 Service)。
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
defineProps({ data: { type: Object, required: true } })
</script>
<template>
  <div class="rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-sm py-1 w-[236px]">
    <p class="text-[10px] text-on-surface-variant/60 mb-0.5">{{ t('workload.topology.labelConsumers') }}</p>
    <div class="flex flex-wrap gap-0.5">
      <button v-for="c in data.consumers" :key="c.kind + '/' + c.name"
        class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] hover:bg-surface-container"
        :class="c.disruptive ? 'bg-error/10 text-error' : 'bg-surface-container-low text-on-surface-variant'"
        @click.stop="data.gotoConsumer?.(c)">
        <span class="material-symbols-outlined" style="font-size:11px">{{ c.kind === 'PDB' ? 'shield' : 'security' }}</span>{{ c.name }}
      </button>
    </div>
  </div>
</template>
