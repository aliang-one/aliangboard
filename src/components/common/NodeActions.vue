<script setup>
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEscClose } from '@/composables/useEscClose'
import { Z } from '@/styles/zScale'

const { t } = useI18n()

const props = defineProps({
  nodeName: { type: String, required: true },
  action: { type: String, required: true }, // 'cordon', 'uncordon', 'drain'
})

const emit = defineEmits(['confirm', 'close'])

const confirmInput = ref('')
const loading = ref(false)

const isConfirmed = ref(false)

const isOpen = ref(true)
useEscClose(isOpen, () => emit('close'))

function checkConfirm() {
  isConfirmed.value = confirmInput.value === props.nodeName
}

async function execute() {
  loading.value = true
  await new Promise(r => setTimeout(r, 1000))
  loading.value = false
  emit('confirm', { node: props.nodeName, action: props.action })
}

const config = computed(() => ({
  cordon: { title: 'Cordon Node', desc: t('component.nodeActions.cordonDesc'), warn: t('component.nodeActions.cordonWarn') },
  uncordon: { title: 'Uncordon Node', desc: t('component.nodeActions.uncordonDesc'), warn: '' },
  drain: { title: 'Drain Node', desc: t('component.nodeActions.drainDesc'), warn: t('component.nodeActions.drainWarn') },
}[props.action]))
</script>

<template>
  <div class="fixed inset-0 flex items-center justify-center" :style="{ zIndex: Z.modal }">
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
        <label class="text-body-sm text-on-surface-variant block mb-xs">{{ t('component.nodeActions.confirmInputLabel') }}</label>
        <input v-model="confirmInput" @input="checkConfirm" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="nodeName" />
      </div>

      <div class="flex justify-end gap-sm">
        <button @click="emit('close')" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
        <button @click="execute" :disabled="!isConfirmed || loading" class="px-md py-sm rounded-lg text-body-md font-semibold transition-all flex items-center gap-sm disabled:opacity-40" :class="action === 'uncordon' ? 'bg-primary text-on-primary' : 'bg-tertiary-container text-on-tertiary'">
          <span v-if="loading" class="material-symbols-outlined animate-spin text-lg">progress_activity</span>
          <span v-else class="material-symbols-outlined text-lg">{{ action === 'drain' ? 'output' : action === 'cordon' ? 'lock' : 'lock_open' }}</span>
          {{ loading ? t('component.nodeActions.executing') : config.title }}
        </button>
      </div>
    </div>
  </div>
</template>
