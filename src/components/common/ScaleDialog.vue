<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEscClose } from '@/composables/useEscClose'

const { t } = useI18n()

const props = defineProps({
  workloadName: { type: String, required: true },
  currentReplicas: { type: Number, default: 1 },
})

const emit = defineEmits(['confirm', 'close'])

const replicas = ref(props.currentReplicas)
const loading = ref(false)

// 挂载即打开(父组件 v-if 控制);ESC 同 Cancel。
const isOpen = ref(true)
useEscClose(isOpen, () => emit('close'))

async function handleScale() {
  loading.value = true
  await new Promise(r => setTimeout(r, 800))
  loading.value = false
  emit('confirm', { name: props.workloadName, replicas: replicas.value })
}

function increment() { replicas.value++ }
function decrement() { if (replicas.value > 0) replicas.value-- }
</script>

<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center">
    <div class="absolute inset-0 bg-on-surface/30 backdrop-blur-sm" @click="emit('close')"></div>
    <div class="relative bg-surface-container-lowest rounded-xl border border-outline-variant shadow-dropdown w-full max-w-sm z-10 p-lg">
      <div class="flex items-center gap-md mb-lg">
        <div class="w-10 h-10 rounded-full bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary">timeline</span>
        </div>
        <div>
          <h3 class="text-headline-sm font-bold">Scale Replicas</h3>
          <p class="text-body-sm text-on-surface-variant font-mono">{{ workloadName }}</p>
        </div>
      </div>

      <div class="flex items-center justify-center gap-lg mb-lg bg-surface-container-low rounded-xl p-lg">
        <button @click="decrement" class="w-10 h-10 rounded-full bg-surface-container border border-outline-variant flex items-center justify-center text-on-surface hover:bg-surface-container-high transition-colors">
          <span class="material-symbols-outlined">remove</span>
        </button>
        <div class="text-center">
          <input v-model.number="replicas" type="number" min="0" class="w-20 text-center text-headline-md font-bold bg-transparent outline-none text-primary" />
          <p class="text-body-sm text-on-surface-variant">replicas</p>
        </div>
        <button @click="increment" class="w-10 h-10 rounded-full bg-surface-container border border-outline-variant flex items-center justify-center text-on-surface hover:bg-surface-container-high transition-colors">
          <span class="material-symbols-outlined">add</span>
        </button>
      </div>

      <div v-if="replicas !== currentReplicas" class="text-center mb-lg">
        <p class="text-body-md">
          {{ t('component.scaleDialog.adjustFrom', { current: currentReplicas }) }}
          <span class="font-bold text-primary">{{ replicas }}</span>
        </p>
      </div>

      <div class="flex justify-end gap-sm">
        <button @click="emit('close')" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
        <button @click="handleScale" :disabled="loading || replicas === currentReplicas" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 active:scale-95 transition-all flex items-center gap-sm disabled:opacity-40">
          <span v-if="loading" class="material-symbols-outlined animate-spin text-lg">progress_activity</span>
          <span v-else class="material-symbols-outlined text-lg">check_circle</span>
          {{ loading ? 'Scaling...' : 'Apply' }}
        </button>
      </div>
    </div>
  </div>
</template>
