<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadAll as yamlLoadAll } from 'js-yaml'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import { useResourceApply } from '@/composables/useResourceApply'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'applied'])

const { t } = useI18n()
const { applyYaml } = useResourceApply()

function template() {
  const ns = props.namespace || 'default'
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: ${ns}
  labels:
    app: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: nginx:latest
          ports:
            - containerPort: 80
`
}

const yaml = ref('')
const parseError = ref('')
const applying = ref(false)

// immediate: 即便组件以 modelValue=true 挂载（例如测试或父组件先开再渲染）也能填入模板。
watch(() => props.modelValue, v => {
  if (v) { yaml.value = template(); parseError.value = ''; applying.value = false }
}, { immediate: true })

function close() { emit('update:modelValue', false) }

async function create() {
  parseError.value = ''
  try {
    let count = 0
    yamlLoadAll(yaml.value, () => { count++ })
    if (count === 0) { parseError.value = t('component.createFromYaml.parseError'); return }
  } catch (e) {
    parseError.value = t('component.createFromYaml.parseError') + ': ' + (e?.message || e)
    return
  }
  applying.value = true
  const res = await applyYaml(yaml.value)
  applying.value = false
  if (res.ok) { emit('applied'); close() }
}
</script>

<template>
  <Modal :model-value="modelValue" :title="t('component.createFromYaml.title')" width="max-w-3xl"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="flex flex-col gap-sm">
      <p class="text-body-sm text-on-surface-variant">{{ t('component.createFromYaml.hint') }}</p>
      <YamlEditor v-model="yaml" height="420px" />
      <p v-if="parseError" class="text-body-sm text-error">{{ parseError }}</p>
    </div>
    <template #actions>
      <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="create" :disabled="applying" class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold disabled:opacity-50">
        <span v-if="applying" class="material-symbols-outlined animate-spin text-lg">progress_activity</span>
        {{ t('component.createFromYaml.create') }}
      </button>
    </template>
  </Modal>
</template>
