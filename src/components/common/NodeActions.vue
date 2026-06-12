<script setup>
import { ref } from 'vue'

const props = defineProps({
  nodeName: { type: String, required: true },
  action: { type: String, required: true }, // 'cordon', 'uncordon', 'drain'
})

const emit = defineEmits(['confirm', 'close'])

const confirmInput = ref('')
const loading = ref(false)

const isConfirmed = ref(false)

function checkConfirm() {
  isConfirmed.value = confirmInput.value === props.nodeName
}

async function execute() {
  loading.value = true
  await new Promise(r => setTimeout(r, 1000))
  loading.value = false
  emit('confirm', { node: props.nodeName, action: props.action })
}

const descriptions = {
  cordon: { title: 'Cordon Node', desc: `标记节点为不可调度，新的 Pod 将不会被调度到此节点。现有 Pod 不受影响。`, warn: '现有 Pod 不会被驱逐。' },
  uncordon: { title: 'Uncordon Node', desc: `恢复节点为可调度状态，新的 Pod 可以被调度到此节点。`, warn: '' },
  drain: { title: 'Drain Node', desc: `安全地驱逐节点上的所有 Pod，用于维护。`, warn: '所有 Pod 将被安全驱逐（优雅终止）。' },
}

const config = descriptions[props.action]
</script>

<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center">
    <div class="absolute inset-0 bg-on-surface/30 backdrop-blur-sm" @click="emit('close')"></div>
    <div class="relative bg-surface-container-lowest rounded-xl border border-outline-variant shadow-dropdown w-full max-w-md z-10 p-lg">
      <div class="flex items-center gap-md mb-lg">
        <div class="w-10 h-10 rounded-full flex items-center justify-center" :class="action === 'uncordon' ? 'bg-primary-container/20 text-primary' : 'bg-tertiary-container/20 text-tertiary-container'">
          <span class="material-symbols-outlined">{{ action === 'drain' ? 'output' : action === 'cordon' ? 'lock' : 'lock_open' }}</span>
        </div>
        <div>
          <h3 class="text-headline-sm font-bold">{{ config.title }}</h3>
          <p class="text-body-sm text-on-surface-variant font-mono">{{ nodeName }}</p>
        </div>
      </div>

      <p class="text-body-md text-on-surface-variant mb-md">{{ config.desc }}</p>
      <p v-if="config.warn" class="text-body-sm text-tertiary-container flex items-center gap-sm mb-lg bg-tertiary-container/5 p-md rounded-lg">
        <span class="material-symbols-outlined text-lg">warning</span>{{ config.warn }}
      </p>

      <div class="mb-lg">
        <label class="text-body-sm text-on-surface-variant block mb-xs">输入节点名称以确认：</label>
        <input v-model="confirmInput" @input="checkConfirm" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="nodeName" />
      </div>

      <div class="flex justify-end gap-sm">
        <button @click="emit('close')" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
        <button @click="execute" :disabled="!isConfirmed || loading" class="px-md py-sm rounded-lg text-body-md font-semibold transition-all flex items-center gap-sm disabled:opacity-40" :class="action === 'uncordon' ? 'bg-primary text-on-primary' : 'bg-tertiary-container text-on-tertiary'">
          <span v-if="loading" class="material-symbols-outlined animate-spin text-lg">progress_activity</span>
          <span v-else class="material-symbols-outlined text-lg">{{ action === 'drain' ? 'output' : action === 'cordon' ? 'lock' : 'lock_open' }}</span>
          {{ loading ? '执行中...' : config.title }}
        </button>
      </div>
    </div>
  </div>
</template>
