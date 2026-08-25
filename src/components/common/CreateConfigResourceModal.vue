<script setup>
// ConfigMap/Secret 富创建弹窗骨架（Task 6）：
// - kind 二态：configmap / secret（secret 又分 Opaque 自由键 + 4 固定字段类型）
// - 四 tab：数据 / 注解 / 标签 / YAML（YAML 为 Task 7 占位,按钮禁用）
// - freeKeys 唯一数据源：自由键与固定字段都经 DataKeysEditor v-model
// - {ok} 契约提交：r.ok === false 时 Modal 不关（store 已 toast）
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from './Modal.vue'
import DataKeysEditor from './DataKeysEditor.vue'
import KeyValueRowsEditor from './KeyValueRowsEditor.vue'
import { SECRET_TYPES, buildSecretData, secretFieldsComplete } from '@/utils/secretTemplates'
import { useClusterStore } from '@/stores/cluster'

const props = defineProps({
  kind: { type: String, default: 'configmap' }, // 'configmap' | 'secret'
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'created'])

const { t } = useI18n()
const store = useClusterStore()

// ---- 表单状态 ----
const name = ref('')
const secretTypeId = ref('Opaque')
// 唯一数据源：自由模式 [{key,value}]，固定模式即 [{key:'tls.crt',value:'C'},…]
const freeKeys = ref([{ key: '', value: '' }])
const labels = ref([])
const annotations = ref([])
const activeTab = ref('data')

const isSecret = computed(() => props.kind === 'secret')
const currentType = computed(
  () => SECRET_TYPES.find((s) => s.id === secretTypeId.value) || SECRET_TYPES[0],
)
const fixedFields = computed(() =>
  isSecret.value && Array.isArray(currentType.value.fields) ? currentType.value.fields : null,
)

// freeKeys 按当前 secretTypeId 初始化：固定类型 → fields 数组；Opaque/configmap → 单空行
function resetTypeData() {
  const tp = SECRET_TYPES.find((s) => s.id === secretTypeId.value)
  freeKeys.value = Array.isArray(tp && tp.fields)
    ? tp.fields.map((f) => ({ key: f.key, value: '' }))
    : [{ key: '', value: '' }]
}

// 类型切换：重置 freeKeys（避免跨类型脏数据）
watch(secretTypeId, resetTypeData)

// 弹窗打开时重置表单
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      name.value = ''
      secretTypeId.value = 'Opaque'
      labels.value = []
      annotations.value = []
      activeTab.value = 'data'
      // secretTypeId 同值赋值不触发 watch(secretTypeId)（如上次已是 Opaque 或 configmap），
      // 必须显式重置，否则上次填的键值残留跨会话
      resetTypeData()
    }
  },
)

// ---- 校验 ----
const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/ // DNS-1123 子域
const nameValid = computed(() => !!name.value && NAME_RE.test(name.value))

// meta 行合法性（与 KeyValueRowsEditor 标红语义一致，Modal 侧用于禁用创建）
const KV_PREFIX_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/
const KV_NAME_RE = /^[-._a-zA-Z0-9]+$/
function kvKeyInvalid(k) {
  if (!k) return false
  const slash = k.indexOf('/')
  if (slash === -1) return !KV_NAME_RE.test(k)
  return !KV_PREFIX_RE.test(k.slice(0, slash)) || !KV_NAME_RE.test(k.slice(slash + 1))
}
function rowsInvalid(rows) {
  const seen = new Set()
  for (const r of rows) {
    if (!r.key) continue
    if (kvKeyInvalid(r.key) || seen.has(r.key)) return true
    seen.add(r.key)
  }
  return false
}
const metaValid = computed(() => !rowsInvalid(labels.value) && !rowsInvalid(annotations.value))

// 有效键（空 key 行过滤在 Modal 侧——Task 3 审查移交契约）
const validKeys = computed(() => freeKeys.value.filter((k) => k.key))
const keyObj = computed(() => Object.fromEntries(validKeys.value.map((k) => [k.key, k.value])))

// secret 必填：固定类型传字段对象，Opaque 传 {data: 键对象}
const dataComplete = computed(() => {
  if (isSecret.value) return secretFieldsComplete(secretTypeId.value,
    secretTypeId.value === 'Opaque' ? { data: keyObj.value } : keyObj.value)
  return validKeys.value.length > 0
})

const canCreate = computed(() => nameValid.value && metaValid.value && dataComplete.value)

// ---- payload 组装 ----
function rowsToObj(rows) {
  const o = {}
  for (const r of rows) if (r.key) o[r.key] = r.value
  return o
}
const payload = computed(() => {
  if (!isSecret.value) {
    return {
      name: name.value,
      namespace: props.namespace,
      keys: validKeys.value.length,
      data: { ...keyObj.value },
      labels: rowsToObj(labels.value),
      annotations: rowsToObj(annotations.value),
    }
  }
  return {
    name: name.value,
    namespace: props.namespace,
    type: secretTypeId.value,
    keys: validKeys.value.length,
    data: buildSecretData(secretTypeId.value,
      secretTypeId.value === 'Opaque' ? { data: keyObj.value } : keyObj.value),
    labels: rowsToObj(labels.value),
    annotations: rowsToObj(annotations.value),
  }
})

// ---- 提交 / 取消 ----
const submitting = ref(false)
async function submit() {
  if (!canCreate.value || submitting.value) return
  submitting.value = true
  let r
  try {
    r = props.kind === 'configmap' ? await store.addConfigMap(payload.value) : await store.addSecret(payload.value)
  } finally {
    submitting.value = false
  }
  if (r && r.ok === false) return // 失败已 toast,Modal 不关
  emit('created')
  emit('update:modelValue', false)
}
function cancel() {
  emit('update:modelValue', false)
}
</script>

<template>
  <Modal :model-value="modelValue" :title="isSecret ? t('component.createConfigModal.titleSecret') : t('component.createConfigModal.titleConfigMap')"
    width="max-w-4xl" @update:model-value="cancel">
    <div class="flex flex-col gap-md">
      <!-- name -->
      <div class="flex flex-col gap-xs">
        <label class="text-body-sm font-medium text-on-surface-variant">{{ t('component.createConfigModal.nameLabel') }}</label>
        <input v-model="name" data-testid="ccm-name"
          class="bg-surface-container-lowest border rounded-lg px-md py-sm text-body-md font-mono"
          :class="name && !nameValid ? 'border-error' : 'border-outline-variant'" />
        <p v-if="name && !nameValid" class="text-body-sm text-error">{{ t('component.createConfigModal.invalidName') }}</p>
      </div>

      <!-- secret 类型 -->
      <div v-if="isSecret" class="flex flex-col gap-xs">
        <label class="text-body-sm font-medium text-on-surface-variant">{{ t('component.createConfigModal.typeLabel') }}</label>
        <select v-model="secretTypeId" data-testid="ccm-type"
          class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option v-for="st in SECRET_TYPES" :key="st.id" :value="st.id">{{ t(st.labelKey) }}</option>
        </select>
      </div>

      <!-- tab 条 -->
      <div class="flex gap-xs border-b border-outline-variant" role="tablist">
        <button v-for="tab in ['data', 'annotations', 'labels', 'yaml']" :key="tab" type="button" role="tab"
          :data-testid="`ccm-tab-${tab}`" :disabled="tab === 'yaml'"
          :title="tab === 'yaml' ? t('component.createConfigModal.tabYaml') : undefined"
          @click="activeTab = tab"
          class="px-md py-sm text-body-sm font-medium rounded-t-lg transition-colors"
          :class="activeTab === tab
            ? 'text-primary border-b-2 border-primary'
            : 'text-on-surface-variant hover:text-on-surface disabled:opacity-40 disabled:cursor-not-allowed'">
          {{ t(`component.createConfigModal.tab${tab[0].toUpperCase()}${tab.slice(1)}`) }}
        </button>
      </div>

      <!-- tab 内容（固定高度内滚） -->
      <div class="max-h-[55vh] overflow-y-auto">
        <div v-if="activeTab === 'data'" data-testid="ccm-panel-data">
          <DataKeysEditor v-model="freeKeys" :secret="isSecret" :fixed-fields="fixedFields" />
        </div>
        <div v-else-if="activeTab === 'annotations'" data-testid="ccm-panel-annotations">
          <KeyValueRowsEditor v-model="annotations" multiline />
        </div>
        <div v-else-if="activeTab === 'labels'" data-testid="ccm-panel-labels">
          <KeyValueRowsEditor v-model="labels" />
        </div>
        <!-- YAML tab:Task 7 实现 -->
      </div>
    </div>

    <template #actions>
      <div class="flex items-center gap-md w-full">
        <p v-if="isSecret" class="flex-1 text-body-sm text-on-surface-variant">{{ t('component.createConfigModal.base64Hint') }}</p>
        <span v-else class="flex-1" />
        <button type="button" data-testid="ccm-cancel" @click="cancel"
          class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">
          {{ t('common.cancel') }}
        </button>
        <button type="button" data-testid="ccm-create" :disabled="!canCreate || submitting" @click="submit"
          class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
          {{ t('common.create') }}
        </button>
      </div>
    </template>
  </Modal>
</template>
