<script setup>
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'

const { t } = useI18n()

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 上下文：从详情页打开时预填的资源
  kind: { type: String, default: 'Service' },
  name: { type: String, default: '' },
  namespace: { type: String, default: '' },
  // 可选：候选目标端口（如 Service 的端口列表）
  suggestedPorts: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue'])

const store = useClusterStore()
const open = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
})

const selPort = ref('')
const localPort = ref('')
const forwarding = ref(false)

function suggestedPortOptions() {
  return props.suggestedPorts.length ? props.suggestedPorts : [80, 8080, 443, 9090]
}

// 打开时同步后端真实活动转发
watch(open, v => { if (v) store.refreshPortForwards() })

async function doForward() {
  const port = parseInt(selPort.value || suggestedPortOptions()[0])
  forwarding.value = true
  try {
    await store.addPortForward({
      kind: props.kind,
      name: props.name,
      namespace: props.namespace,
      port,
      localPort: localPort.value ? parseInt(localPort.value) : undefined,
    })
    selPort.value = ''
    localPort.value = ''
    notify(t('component.portForward.forwardSuccess', { resource: `${props.kind}/${props.name}`, port }), 'success')
  } catch (e) {
    notify(e?.message || t('component.portForward.forwardFailed'), 'error')
  } finally {
    forwarding.value = false
  }
}

function openInBrowser(pf) {
  // 默认绑 127.0.0.1：仅当网关运行在本机时，浏览器 localhost 才可达（同 kubectl port-forward）。
  window.open(`http://localhost:${pf.localPort}`, '_blank', 'noopener')
}
async function stopForward(id) {
  try { await store.removePortForward(id) } catch { /* 忽略 */ }
}
</script>

<template>
  <Modal v-model="open" :title="t('component.portForward.title')" width="max-w-2xl">
    <p class="text-body-sm text-on-surface-variant mb-md">
      {{ t('component.portForward.description', { resource: `${kind}/${name}${namespace ? ' (' + namespace + ')' : ''}` }) }}
      <span class="text-tertiary-container">{{ t('component.portForward.remoteHint') }}</span>
    </p>

    <!-- 新建转发 -->
    <div class="flex flex-wrap items-end gap-md p-md bg-surface-container-low rounded-lg mb-lg">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('component.portForward.targetPort') }}</label>
        <input v-model="selPort" list="pf-port-suggest" type="number" class="w-28 bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="8080" />
        <datalist id="pf-port-suggest">
          <option v-for="p in suggestedPortOptions()" :key="p" :value="p" />
        </datalist>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('component.portForward.localPort') }}</label>
        <input v-model="localPort" type="number" class="w-32 bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="t('component.portForward.localPortPlaceholder')" />
      </div>
      <button @click="doForward" :disabled="!name || forwarding" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 disabled:opacity-40">
        <span class="material-symbols-outlined text-sm">{{ forwarding ? 'progress_activity' : 'bolt' }}</span> {{ t('component.portForward.forward') }}
      </button>
    </div>

    <!-- 已转发列表 -->
    <div class="rounded-lg border border-outline-variant overflow-hidden">
      <div class="px-md py-sm bg-surface-container-low border-b border-outline-variant text-label-caps text-on-surface-variant">{{ t('component.portForward.activeForwards', { n: store.portForwards.length }) }}</div>
      <div v-if="store.portForwards.length" class="divide-y divide-outline-variant/30">
        <div v-for="pf in store.portForwards" :key="pf.id" class="flex items-center gap-md px-md py-sm">
          <span class="material-symbols-outlined text-primary text-lg">forward_media</span>
          <div class="flex-1 min-w-0">
            <p class="font-mono text-code-sm text-on-surface">
              <span class="text-on-surface-variant">{{ pf.kind }}/</span>{{ pf.name }}<span v-if="pf.namespace" class="text-on-surface-variant"> · {{ pf.namespace }}</span>
            </p>
            <p class="font-mono text-code-sm">
              <span class="text-primary">:{{ pf.port }}</span>
              <span class="material-symbols-outlined text-sm align-middle mx-xs">arrow_forward</span>
              <span class="text-primary font-semibold">localhost:{{ pf.localPort }}</span>
            </p>
          </div>
          <span class="px-2 py-0.5 bg-primary-container/10 text-primary text-label-caps rounded-full">{{ pf.status }}</span>
          <button @click="openInBrowser(pf)" :title="t('component.portForward.openInBrowser')" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-lg">open_in_new</span>
          </button>
          <button @click="stopForward(pf.id)" :title="t('component.portForward.stopForward')" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg">
            <span class="material-symbols-outlined text-lg">stop_circle</span>
          </button>
        </div>
      </div>
      <div v-else class="px-md py-xl text-center text-on-surface-variant">
        <span class="material-symbols-outlined text-3xl">cable</span>
        <p class="mt-sm text-body-sm">{{ t('component.portForward.noForwards') }}</p>
      </div>
    </div>

    <template #actions>
      <button @click="open = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('component.portForward.close') }}</button>
    </template>
  </Modal>
</template>
