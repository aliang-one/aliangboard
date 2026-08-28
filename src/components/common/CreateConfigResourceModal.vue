<script setup>
// ConfigMap/Secret 富创建弹窗（Task 6 骨架 + Task 7 YAML tab）：
// - kind 二态：configmap / secret（secret 又分 Opaque 自由键 + 4 固定字段类型）
// - 四 tab：数据 / 注解 / 标签 / YAML（实时派生预览 + 纯 YAML 编辑模式）
// - freeKeys 唯一数据源：自由键与固定字段都经 DataKeysEditor v-model
// - {ok} 契约提交：r.ok === false 时 Modal 不关（store 已 toast）
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { load as yamlLoad } from 'js-yaml'
import Modal from './Modal.vue'
import DataKeysEditor from './DataKeysEditor.vue'
import KeyValueRowsEditor from './KeyValueRowsEditor.vue'
import { SECRET_TYPES, buildSecretData, secretFieldsComplete } from '@/utils/secretTemplates'
import { encodeSecretData } from '@/composables/useResourceMappers'
import { yamlTemplates } from '@/utils/yamlTemplates'
import { useClusterStore } from '@/stores/cluster'

const props = defineProps({
  kind: { type: String, default: 'configmap' }, // 'configmap' | 'secret'
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: '' },
  // 「从 YAML 开始」直达:打开即 YAML tab 编辑模式并预填对应 kind 模板(粘贴创建一等入口)
  startInYaml: { type: Boolean, default: false },
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
// YAML tab 两态：preview（实时派生预览）/ edit（纯 YAML 手编）
const yamlMode = ref('preview')
const rawYaml = ref('')

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
      // secretTypeId 同值赋值不触发 watch(secretTypeId)（如上次已是 Opaque 或 configmap），
      // 必须显式重置，否则上次填的键值残留跨会话
      resetTypeData()
      if (props.startInYaml) {
        activeTab.value = 'yaml'
        yamlMode.value = 'edit'
        rawYaml.value = yamlTemplates[isSecret.value ? 'Secret' : 'ConfigMap'](props.namespace || 'default')
      } else {
        activeTab.value = 'data'
        yamlMode.value = 'preview'
      }
    }
  },
  // immediate:组件可能以 modelValue=true 直接挂载(测试/父组件先开再渲染),此时也须初始化起始态
  { immediate: true },
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

// 数据键合法性（configmap/Secret data 键 K8s 规则）：非空键重复或非法即 true。
// 重复键会被 Object.fromEntries 静默折叠丢值,须提交前拦截。
const DATA_KEY_RE = /^[-._a-zA-Z0-9]+$/
const dataKeyErrors = computed(() => {
  const seen = new Set()
  let dup = false
  let invalid = false
  for (const k of freeKeys.value) {
    if (!k.key) continue
    if (seen.has(k.key)) dup = true
    seen.add(k.key)
    if (!DATA_KEY_RE.test(k.key)) invalid = true
  }
  return { dup, invalid }
})
const dataKeysInvalid = computed(() => dataKeyErrors.value.dup || dataKeyErrors.value.invalid)

// 有效键（空 key 行过滤在 Modal 侧——Task 3 审查移交契约）
const validKeys = computed(() => freeKeys.value.filter((k) => k.key))
const keyObj = computed(() => Object.fromEntries(validKeys.value.map((k) => [k.key, k.value])))

// secret 必填：固定类型传字段对象，Opaque 传 {data: 键对象}
const dataComplete = computed(() => {
  if (isSecret.value) return secretFieldsComplete(secretTypeId.value,
    secretTypeId.value === 'Opaque' ? { data: keyObj.value } : keyObj.value)
  return validKeys.value.length > 0
})

const canCreate = computed(() =>
  yamlMode.value === 'edit' ? yamlValid.value : nameValid.value && metaValid.value && dataComplete.value && !dataKeysInvalid.value,
)

// ---- YAML tab ----
// 预览=提交体：secret data 与 makeCrud beforeSave 同路 encodeSecretData
const derivedYaml = computed(() => {
  const p = payload.value
  return store.generateYAML(isSecret.value ? 'secret' : 'configmap', {
    ...p,
    data: isSecret.value ? encodeSecretData(p.data) : p.data,
  })
})

// edit 模式校验：可解析 + kind 与弹窗 kind 一致
const yamlErrorKey = computed(() => {
  if (yamlMode.value !== 'edit') return ''
  let o
  try {
    o = yamlLoad(rawYaml.value)
  } catch {
    return 'component.createConfigModal.yamlParseError'
  }
  if (!o || typeof o !== 'object' || o.kind !== (isSecret.value ? 'Secret' : 'ConfigMap')) {
    return 'component.createConfigModal.yamlKindError'
  }
  return ''
})
const yamlValid = computed(() => yamlMode.value === 'edit' && !yamlErrorKey.value)

function switchToEdit() {
  rawYaml.value = derivedYaml.value // 当前派生值快照,后续表单改动不再跟随
  yamlMode.value = 'edit'
}
function backToForm() {
  if (!window.confirm(t('component.createConfigModal.discardConfirm'))) return
  yamlMode.value = 'preview'
}

// 复制（照 YamlEditor.vue copy 的 clipboard 逻辑,附成功/失败回显）
const copyState = ref('') // '' | 'ok' | 'fail'
async function copyYaml() {
  try {
    await navigator?.clipboard?.writeText(derivedYaml.value)
    copyState.value = 'ok'
  } catch {
    copyState.value = 'fail'
  }
}

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
    r = yamlMode.value === 'edit'
      ? await store.applyResourceYaml(rawYaml.value)
      : props.kind === 'configmap' ? await store.addConfigMap(payload.value) : await store.addSecret(payload.value)
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
          :data-testid="`ccm-tab-${tab}`"
          :disabled="yamlMode === 'edit' && tab !== 'yaml'"
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
        <!-- 纯 YAML 编辑模式：表单面板整体置灰锁交互 -->
        <div :class="yamlMode === 'edit' ? 'opacity-50 pointer-events-none' : ''">
          <div v-if="activeTab === 'data'" data-testid="ccm-panel-data">
            <!-- 数据键重复/非法行内错误（重复键会被 Object.fromEntries 静默折叠丢值） -->
            <p v-if="dataKeysInvalid" data-testid="ccm-datakeys-error" class="text-body-sm text-error mb-xs">
              <template v-if="dataKeyErrors.dup">{{ t('component.createConfigModal.duplicateKey') }}</template>
              <template v-if="dataKeyErrors.dup && dataKeyErrors.invalid"> · </template>
              <template v-if="dataKeyErrors.invalid">{{ t('component.createConfigModal.invalidDataKey') }}</template>
            </p>
            <DataKeysEditor v-model="freeKeys" :secret="isSecret" :fixed-fields="fixedFields" />
          </div>
          <div v-else-if="activeTab === 'annotations'" data-testid="ccm-panel-annotations">
            <KeyValueRowsEditor v-model="annotations" multiline />
          </div>
          <div v-else-if="activeTab === 'labels'" data-testid="ccm-panel-labels">
            <KeyValueRowsEditor v-model="labels" />
          </div>
        </div>

        <!-- YAML tab -->
        <div v-if="activeTab === 'yaml'" data-testid="ccm-panel-yaml" class="flex flex-col gap-sm">
          <!-- 预览模式：实时派生（表单继续可改,computed 实时反映） -->
          <template v-if="yamlMode === 'preview'">
            <div class="flex items-center justify-between">
              <button type="button" data-testid="ccm-yaml-switch" @click="switchToEdit"
                class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high">
                {{ t('component.createConfigModal.switchToYamlEdit') }}
              </button>
              <button type="button" data-testid="ccm-yaml-copy" @click="copyYaml"
                class="px-sm py-xs border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high">
                {{ t('common.copy') }}
              </button>
            </div>
            <p v-if="copyState" class="text-body-sm" :class="copyState === 'ok' ? 'text-primary' : 'text-error'">
              {{ t(copyState === 'ok' ? 'common.copySuccess' : 'common.copyFailed') }}
            </p>
            <pre data-testid="ccm-yaml-preview"
              class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md text-body-sm font-mono whitespace-pre-wrap">{{ derivedYaml }}</pre>
          </template>

          <!-- 纯 YAML 编辑模式 -->
          <template v-else>
            <div class="flex items-center justify-between">
              <button type="button" data-testid="ccm-yaml-back" @click="backToForm"
                class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high">
                {{ t('component.createConfigModal.backToForm') }}
              </button>
            </div>
            <p v-if="yamlErrorKey" data-testid="ccm-yaml-error" class="text-body-sm text-error">
              {{ t(yamlErrorKey) }}
            </p>
            <textarea v-model="rawYaml" data-testid="ccm-yaml-input" rows="14" spellcheck="false"
              class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md text-body-sm font-mono" />
          </template>
        </div>
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
