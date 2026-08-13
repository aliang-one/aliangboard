<script setup>
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'created'])

const { t } = useI18n()
const store = useClusterStore()

// StorageClass 列表(集群级):弹窗自取,组件自包含、可复用,不依赖父组件喂入。
const cid = computed(() => store.currentCluster || 'cluster')
const scQ = useResourceList({ key: ['cluster', cid, 'storageclasses'], fetcher: () => store.fetchStorageClasses(), options: { refetchInterval: 30000 } })
const allSCs = computed(() => scQ.data.value || [])

const form = ref({ name: '', capacity: '10Gi', accessModes: 'RWO', storageClass: '' })
const error = ref('')
const applying = ref(false)

// 打开时重置表单 + 清错(默认值与 NsStorage 创建表单一致)
watch(() => props.modelValue, v => {
  if (v) {
    form.value = { name: '', capacity: '10Gi', accessModes: 'RWO', storageClass: '' }
    error.value = ''
    applying.value = false
  }
})

function close() { emit('update:modelValue', false) }

async function create() {
  const name = form.value.name.trim()
  if (!name) { error.value = t('component.createPvc.nameRequired'); return }
  error.value = ''
  applying.value = true
  try {
    // store.addPVC 内部:remoteCreate(server-side apply,自带 toast)+ invalidateResource('pvcs')。
    // 故此处不再单独 invalidateQueries;据返回 {ok} 决定关窗/选中还是留窗。
    const r = await store.addPVC({
      name,
      namespace: props.namespace,
      status: 'Pending',
      capacity: form.value.capacity || '10Gi',
      accessModes: form.value.accessModes,
      storageClass: form.value.storageClass || allSCs.value.find(s => s.default)?.name || 'standard',
      volume: '',
      age: 'Just now',
    })
    if (r && r.ok) {
      emit('created', name)
      close()
    } else {
      // 失败:remoteCreate 已 toast 详细原因;此处仅留通用提示并保留弹窗 + 用户输入。
      error.value = t('component.createPvc.createFailed')
    }
  } catch (e) {
    // 防御:addPVC 内部已 catch,理论不抛。
    error.value = t('component.createPvc.createFailed')
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <Modal :model-value="modelValue" :title="t('component.createPvc.title')" width="max-w-lg"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="flex flex-col gap-md">
      <p class="text-body-sm text-on-surface-variant">{{ t('component.createPvc.hint', { ns: namespace || '—' }) }}</p>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.pvcName') }} *</label>
        <input v-model="form.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary"
          :placeholder="t('ns.storage.pvcName')" />
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.capacity') }} *</label>
          <input v-model="form.capacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="10Gi" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.accessMode') }}</label>
          <select v-model="form.accessModes" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option value="RWO">ReadWriteOnce</option>
            <option value="RWM">ReadWriteMany</option>
            <option value="ROM">ReadOnlyMany</option>
          </select>
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.storage.storageClass') }}</label>
        <select v-model="form.storageClass" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option value="">{{ t('ns.storage.defaultOption') }}</option>
          <option v-for="sc in allSCs" :key="sc.name" :value="sc.name">{{ sc.name }}{{ sc.default ? ' (default)' : '' }}</option>
        </select>
      </div>
      <p v-if="error" class="text-body-sm text-error">{{ error }}</p>
    </div>
    <template #actions>
      <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button data-testid="pvc-create" @click="create" :disabled="!form.name.trim() || applying"
        class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">
        <span v-if="applying" class="material-symbols-outlined animate-spin text-lg">progress_activity</span>
        {{ applying ? t('component.createPvc.creating') : t('common.create') }}
      </button>
    </template>
  </Modal>
</template>
