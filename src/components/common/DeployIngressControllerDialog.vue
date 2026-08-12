<script setup>
// src/components/common/DeployIngressControllerDialog.vue
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'applied'])
const { t } = useI18n()

const templates = ref([])
const pickedId = ref('')
const yaml = ref('')
const loading = ref(false)

watch(() => props.modelValue, async (open) => {
  if (!open || templates.value.length) return
  const r = await api.ingressControllers.catalog()
  templates.value = r.templates || []
}, { immediate: true })

async function pick(tpl) {
  pickedId.value = tpl.id
  loading.value = true
  try { const r = await api.ingressControllers.manifest(tpl.id); yaml.value = r.yaml }
  finally { loading.value = false }
}
function close() { emit('update:modelValue', false) }
</script>

<template>
  <Modal :model-value="modelValue" @update:model-value="close" :title="t('ingressController.dialogTitle')" width="max-w-3xl">
    <div v-if="!pickedId" class="grid grid-cols-2 gap-md">
      <button v-for="tpl in templates" :key="tpl.id" data-testid="controller-card"
        class="text-left border border-outline-variant rounded-lg p-md hover:border-primary"
        @click="pick(tpl)">
        <div class="font-semibold">{{ t(tpl.labelKey) }}</div>
        <div class="text-xs text-on-surface-variant">{{ tpl.version }} · {{ tpl.variant }}</div>
      </button>
    </div>
    <div v-else>
      <YamlEditor v-model="yaml" />
    </div>
  </Modal>
</template>
