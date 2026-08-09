<script setup>
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import Modal from '@/components/common/Modal.vue'
import { useClusterStore } from '@/stores/cluster'
import { api } from '@/api/client'
import { useCopySeed } from '@/composables/useCopySeed'
import { workloadToForm } from '@/composables/useWorkloadToForm'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  defaultTargetNamespace: { type: String, default: '' },
  targetRouteName: { type: String, default: 'Deploy' }, // 'Deploy' | 'NsDeploy'
  targetNamespace: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const { t } = useI18n()
const store = useClusterStore()
const router = useRouter()
const { setSeed } = useCopySeed()

// kind → [group, version, plural]
const WL_PATHS = {
  Deployment: ['apps', 'v1', 'deployments'],
  StatefulSet: ['apps', 'v1', 'statefulsets'],
  DaemonSet: ['apps', 'v1', 'daemonsets'],
  Job: ['batch', 'v1', 'jobs'],
  CronJob: ['batch', 'v1', 'cronjobs'],
}

const sourceNs = ref('')
const workloads = ref([])
const selected = ref(null) // { type, name, raw }
const loading = ref(false)
const error = ref('')

const namespaces = computed(() => (store.namespaceList || []).map(n => n.name).filter(Boolean))

watch(() => props.modelValue, async v => {
  if (!v) return
  selected.value = null
  error.value = ''
  sourceNs.value = props.defaultTargetNamespace || namespaces.value[0] || 'default'
  await loadWorkloads()
})
watch(sourceNs, () => { if (props.modelValue) loadWorkloads() })

function mapItem(item, type) {
  const desired = item.spec?.replicas ?? (type === 'DaemonSet' ? item.status?.desiredNumberScheduled : null)
  const ready = item.status?.readyReplicas ?? item.status?.availableReplicas ?? 0
  return { type, name: item.metadata?.name, replicas: desired != null ? `${ready}/${desired}` : '-', image: item.spec?.template?.spec?.containers?.[0]?.image || '', raw: item }
}

async function loadWorkloads() {
  loading.value = true; error.value = ''; workloads.value = []; selected.value = null
  try {
    const ns = encodeURIComponent(sourceNs.value)
    const groups = await Promise.all(
      Object.entries(WL_PATHS).map(async ([type, [group, ver, plural]]) => {
        try { const res = await api.k8s(`/apis/${group}/${ver}/namespaces/${ns}/${plural}?limit=1000`); return (res?.items || []).map(i => mapItem(i, type)) }
        catch { return [] }
      })
    )
    workloads.value = groups.flat().sort((a, b) => String(a.name).localeCompare(String(b.name)))
  } catch (e) {
    error.value = t('component.copyWorkload.fetchError')
  } finally {
    loading.value = false
  }
}

function close() { emit('update:modelValue', false) }

function confirmCopy() {
  if (!selected.value) return
  const partial = workloadToForm(selected.value.raw, selected.value.type)
  if (!partial) return
  if (props.targetNamespace) partial.namespace = props.targetNamespace
  setSeed({ form: partial, type: selected.value.type, source: `${sourceNs.value}/${selected.value.name}` })
  close()
  if (props.targetRouteName === 'NsDeploy') {
    router.push({ name: 'NsDeploy', params: { namespace: props.targetNamespace || props.defaultTargetNamespace } })
  } else {
    router.push({ name: 'Deploy' })
  }
}
</script>

<template>
  <Modal :model-value="modelValue" :title="t('component.copyWorkload.title')" width="max-w-3xl"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="flex flex-col gap-md">
      <div class="flex items-center gap-sm">
        <label class="text-body-sm text-on-surface-variant whitespace-nowrap">{{ t('component.copyWorkload.sourceNamespace') }}</label>
        <select v-model="sourceNs" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
          <option v-for="n in namespaces" :key="n" :value="n">{{ n }}</option>
          <option v-if="!namespaces.length" :value="sourceNs">{{ sourceNs }}</option>
        </select>
      </div>
      <p v-if="loading" class="text-body-sm text-on-surface-variant">{{ t('component.copyWorkload.loading') }}</p>
      <p v-else-if="error" class="text-body-sm text-error">{{ error }}</p>
      <p v-else-if="!workloads.length" class="text-body-sm text-on-surface-variant">{{ t('component.copyWorkload.empty') }}</p>
      <div v-else class="max-h-[360px] overflow-auto border border-outline-variant rounded-lg">
        <table class="w-full text-body-sm">
          <thead class="sticky top-0 bg-surface-container-high">
            <tr class="text-left text-on-surface-variant">
              <th class="px-md py-sm font-medium">{{ t('component.copyWorkload.thName') }}</th>
              <th class="px-md py-sm font-medium">{{ t('component.copyWorkload.thType') }}</th>
              <th class="px-md py-sm font-medium">{{ t('component.copyWorkload.thReplicas') }}</th>
              <th class="px-md py-sm font-medium">{{ t('component.copyWorkload.thImage') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in workloads" :key="w.type + '/' + w.name"
              @click="selected = w"
              :class="selected && selected.type === w.type && selected.name === w.name ? 'bg-primary-container/40' : 'hover:bg-surface-container-high'"
              class="cursor-pointer">
              <td class="px-md py-sm font-mono">{{ w.name }}</td>
              <td class="px-md py-sm">{{ w.type }}</td>
              <td class="px-md py-sm">{{ w.replicas }}</td>
              <td class="px-md py-sm font-mono text-on-surface-variant truncate max-w-[260px]">{{ w.image }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <template #actions>
      <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="confirmCopy" :disabled="!selected" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold disabled:opacity-50">{{ t('component.copyWorkload.confirm') }}</button>
    </template>
  </Modal>
</template>
