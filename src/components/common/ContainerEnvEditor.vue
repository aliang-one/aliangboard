<script setup>
// 容器环境变量统一编辑器(五消费面共享):统一行列表(类型是行属性)+ 整批导入 envFrom 多行数组。
// 设计:docs/superpowers/specs/2026-09-05-container-env-editor-design.md;行模型/校验在 logic/envRefs.js。
// 资源名/key 选择复用 EnvSourceField;type 切换保留 name、重置类型字段(与 Kite 行为一致)。
import { useI18n } from 'vue-i18n'
import EnvSourceField from './EnvSourceField.vue'
import { makeEnvRow, makeEnvFromRow, ENV_ROW_TYPES, ENV_TYPE_LABEL_KEYS } from '@/logic/envRefs'

const props = defineProps({
  namespace: { type: String, default: '' },
  size: { type: String, default: 'md' }, // 'sm'(CED/编辑壳) | 'md'(创建向导)
})
const env = defineModel('env', { type: Array, default: () => [] })
const envFrom = defineModel('envFrom', { type: Array, default: () => [] })
const { t } = useI18n()

const md = props.size === 'md'
const inputCls = md
  ? 'bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono'
  : 'bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-xs font-mono'
const selectCls = inputCls

function addEnvRow() { env.value.push(makeEnvRow('value')) }
function delEnvRow(i) { env.value.splice(i, 1) }
function addFromRow() { envFrom.value.push(makeEnvFromRow('configmap')) }
function delFromRow(i) { envFrom.value.splice(i, 1) }

// 切类型:保留 name,清掉旧类型字段与 passthrough(用户主动改型=放弃旧值)
function onTypeChange(row, ev) {
  const next = makeEnvRow(ev.target.value)
  const name = row.name
  Object.keys(row).forEach(k => delete row[k])
  Object.assign(row, next, { name })
}
</script>

<template>
  <div class="flex flex-col gap-sm min-w-0">
    <!-- 环境变量(统一行列表) -->
    <div class="flex items-center gap-sm min-w-0">
      <span class="text-xs font-semibold text-on-surface-variant truncate">{{ $t('deploy.envRowsGroup') }}</span>
      <button type="button" data-testid="ceed-add-env" @click="addEnvRow"
        class="ml-auto flex items-center gap-xs px-sm py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg shrink-0">
        <span class="material-symbols-outlined text-sm">add</span>{{ $t('deploy.envRowsAdd') }}
      </button>
    </div>
    <div v-for="(row, i) in env" :key="'er' + i"
      class="rounded-lg border border-outline-variant/60 bg-surface-container-low/30 p-sm flex flex-col gap-xs min-w-0">
      <div class="flex gap-sm items-center min-w-0 flex-wrap">
        <input v-model="row.name" :data-testid="'ceed-name-' + i" :class="inputCls"
          class="w-40 flex-shrink-0 min-w-0" :placeholder="$t('deploy.envRowNamePh')" />
        <select :value="ENV_ROW_TYPES.includes(row.type) ? row.type : 'value'" :data-testid="'ceed-type-' + i"
          :class="selectCls" class="flex-shrink-0 min-w-0" @change="onTypeChange(row, $event)">
          <option v-for="(labelKey, tp) in ENV_TYPE_LABEL_KEYS" :key="tp" :value="tp">{{ $t(labelKey) }}</option>
        </select>
        <input v-if="!row.passthrough?.valueFrom && (!ENV_ROW_TYPES.includes(row.type) || row.type === 'value')" v-model="row.value"
          :data-testid="'ceed-value-' + i" :class="inputCls" class="flex-1 min-w-0" placeholder="value" />
        <button type="button" :data-testid="'ceed-del-env-' + i" @click="delEnvRow(i)"
          class="p-sm text-on-surface-variant hover:text-error rounded-lg flex-shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
          <span class="material-symbols-outlined text-base">delete</span>
        </button>
      </div>
      <div v-if="row.type === 'configMapKeyRef'" class="flex gap-sm items-center min-w-0 pl-0 sm:pl-6">
        <EnvSourceField kind="configmap" :namespace="namespace" :size="size" class="flex-1 min-w-0"
          v-model:name="row.cmName" v-model:dataKey="row.key" />
      </div>
      <div v-else-if="row.type === 'secretKeyRef'" class="flex gap-sm items-center min-w-0 pl-0 sm:pl-6">
        <EnvSourceField kind="secret" :namespace="namespace" :size="size" class="flex-1 min-w-0"
          v-model:name="row.secretName" v-model:dataKey="row.key" />
      </div>
      <div v-else-if="row.type === 'fieldRef'" class="flex gap-sm items-center min-w-0 pl-0 sm:pl-6">
        <input v-model="row.fieldPath" :data-testid="'ceed-fieldpath-' + i" :class="inputCls"
          class="flex-1 min-w-0" :placeholder="$t('deploy.envFieldPathPh')" :aria-label="$t('deploy.envField.fieldPath')" />
      </div>
      <div v-else-if="row.type === 'resourceFieldRef'" class="grid grid-cols-1 sm:grid-cols-3 gap-sm min-w-0 pl-0 sm:pl-6">
        <input v-model="row.resource" :data-testid="'ceed-resref-resource-' + i" :class="inputCls"
          class="min-w-0" :placeholder="$t('deploy.envResourcePh')" :aria-label="$t('deploy.envField.resource')" />
        <input v-model="row.containerName" :data-testid="'ceed-resref-container-' + i" :class="inputCls"
          class="min-w-0" :placeholder="$t('deploy.envField.containerName')" />
        <input v-model="row.divisor" :data-testid="'ceed-resref-divisor-' + i" :class="inputCls"
          class="min-w-0" placeholder="1m" />
      </div>
    </div>

    <!-- 整批导入 envFrom -->
    <div class="flex items-center gap-sm min-w-0 mt-xs">
      <span class="text-xs font-semibold text-on-surface-variant truncate">{{ $t('deploy.envFromRowsGroup') }}</span>
      <span class="text-xs text-on-surface-variant/70 truncate hidden sm:inline">{{ $t('deploy.envFromRowsHint') }}</span>
      <button type="button" data-testid="ceed-add-from" @click="addFromRow"
        class="ml-auto flex items-center gap-xs px-sm py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg shrink-0">
        <span class="material-symbols-outlined text-sm">add</span>{{ $t('deploy.envFromRowsAdd') }}
      </button>
    </div>
    <p class="text-xs text-on-surface-variant/70 sm:hidden">{{ $t('deploy.envFromRowsHint') }}</p>
    <div v-for="(row, i) in envFrom" :key="'fr' + i" class="flex gap-sm items-center min-w-0 flex-wrap">
      <select v-model="row.kind" :data-testid="'ceed-from-kind-' + i" :class="selectCls" class="flex-shrink-0 min-w-0">
        <option value="configmap">ConfigMap</option>
        <option value="secret">Secret</option>
      </select>
      <EnvSourceField :kind="row.kind === 'secret' ? 'secret' : 'configmap'" :namespace="namespace" :with-key="false"
        :size="size" class="flex-1 min-w-0" v-model:name="row.name" />
      <button type="button" :data-testid="'ceed-del-from-' + i" @click="delFromRow(i)"
        class="p-sm text-on-surface-variant hover:text-error rounded-lg flex-shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
        <span class="material-symbols-outlined text-base">delete</span>
      </button>
    </div>
  </div>
</template>
