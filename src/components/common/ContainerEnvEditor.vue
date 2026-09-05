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
// 行网格:固定四列 [变量名|类型|取值区|删除],列宽跨行恒定 → 五种类型/envFrom 全部单行且纵向对齐;
// 手机档(max-sm)退化为确定性三行堆叠(名+删 / 类型 / 取值),不依赖内容触发的自由换行。
const gridCls = md
  ? 'grid grid-cols-[10rem_9.5rem_minmax(0,1fr)_auto] max-sm:grid-cols-2 gap-x-sm gap-y-xs items-center'
  : 'grid grid-cols-[8rem_8rem_minmax(0,1fr)_auto] max-sm:grid-cols-2 gap-x-sm gap-y-xs items-center'

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
      :class="['rounded-lg border border-outline-variant/60 bg-surface-container-low/30 p-sm min-w-0', gridCls]">
      <input v-model="row.name" :data-testid="'ceed-name-' + i" :class="inputCls"
        class="col-start-1 row-start-1 max-sm:col-start-1 max-sm:row-start-1 w-full min-w-0"
        :placeholder="$t('deploy.envRowNamePh')" />
      <select :value="ENV_ROW_TYPES.includes(row.type) ? row.type : 'value'" :data-testid="'ceed-type-' + i"
        :class="selectCls" class="col-start-2 row-start-1 max-sm:col-start-1 max-sm:col-span-2 max-sm:row-start-2 w-full min-w-0"
        @change="onTypeChange(row, $event)">
        <option v-for="(labelKey, tp) in ENV_TYPE_LABEL_KEYS" :key="tp" :value="tp">{{ $t(labelKey) }}</option>
      </select>
      <button type="button" :data-testid="'ceed-del-env-' + i" @click="delEnvRow(i)"
        class="col-start-4 row-start-1 justify-self-end max-sm:col-start-2 p-sm text-on-surface-variant hover:text-error rounded-lg relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
        <span class="material-symbols-outlined text-base">delete</span>
      </button>
      <!-- 取值区:恒在第 3 列(手机档第 3 行),类型只决定里面放什么 -->
      <input v-if="!row.passthrough?.valueFrom && (!ENV_ROW_TYPES.includes(row.type) || row.type === 'value')" v-model="row.value"
        :data-testid="'ceed-value-' + i" :class="inputCls"
        class="col-start-3 row-start-1 max-sm:col-start-1 max-sm:col-span-2 max-sm:row-start-3 w-full min-w-0" placeholder="value" />
      <div v-else-if="row.type === 'configMapKeyRef'"
        class="col-start-3 row-start-1 max-sm:col-start-1 max-sm:col-span-2 max-sm:row-start-3 min-w-0">
        <EnvSourceField kind="configmap" :namespace="namespace" :size="size" class="min-w-0"
          v-model:name="row.cmName" v-model:dataKey="row.key" />
      </div>
      <div v-else-if="row.type === 'secretKeyRef'"
        class="col-start-3 row-start-1 max-sm:col-start-1 max-sm:col-span-2 max-sm:row-start-3 min-w-0">
        <EnvSourceField kind="secret" :namespace="namespace" :size="size" class="min-w-0"
          v-model:name="row.secretName" v-model:dataKey="row.key" />
      </div>
      <input v-else-if="row.type === 'fieldRef'" v-model="row.fieldPath" :data-testid="'ceed-fieldpath-' + i" :class="inputCls"
        class="col-start-3 row-start-1 max-sm:col-start-1 max-sm:col-span-2 max-sm:row-start-3 w-full min-w-0"
        :placeholder="$t('deploy.envFieldPathPh')" :aria-label="$t('deploy.envField.fieldPath')" />
      <div v-else-if="row.type === 'resourceFieldRef'"
        class="col-start-3 row-start-1 max-sm:col-start-1 max-sm:col-span-2 max-sm:row-start-3 min-w-0 grid grid-cols-3 gap-sm max-sm:grid-cols-1">
        <input v-model="row.resource" :data-testid="'ceed-resref-resource-' + i" :class="inputCls"
          class="min-w-0 w-full" :placeholder="$t('deploy.envResourcePh')" :aria-label="$t('deploy.envField.resource')" />
        <input v-model="row.containerName" :data-testid="'ceed-resref-container-' + i" :class="inputCls"
          class="min-w-0 w-full" :placeholder="$t('deploy.envField.containerName')" />
        <input v-model="row.divisor" :data-testid="'ceed-resref-divisor-' + i" :class="inputCls"
          class="min-w-0 w-full" placeholder="1m" />
      </div>
    </div>

    <!-- 整批导入 envFrom(同一四列网格;提示独立成行完整展示,不截断) -->
    <div class="flex items-center gap-sm min-w-0 mt-xs">
      <span class="text-xs font-semibold text-on-surface-variant">{{ $t('deploy.envFromRowsGroup') }}</span>
      <button type="button" data-testid="ceed-add-from" @click="addFromRow"
        class="ml-auto flex items-center gap-xs px-sm py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg shrink-0">
        <span class="material-symbols-outlined text-sm">add</span>{{ $t('deploy.envFromRowsAdd') }}
      </button>
    </div>
    <p class="text-xs text-on-surface-variant/70">{{ $t('deploy.envFromRowsHint') }}</p>
    <div v-for="(row, i) in envFrom" :key="'fr' + i" :class="gridCls">
      <select v-model="row.kind" :data-testid="'ceed-from-kind-' + i" :class="selectCls"
        class="col-start-1 row-start-1 max-sm:row-start-1 w-full min-w-0">
        <option value="configmap">ConfigMap</option>
        <option value="secret">Secret</option>
      </select>
      <EnvSourceField :kind="row.kind === 'secret' ? 'secret' : 'configmap'" :namespace="namespace" :with-key="false"
        :size="size" class="col-start-2 col-span-2 row-start-1 max-sm:col-start-1 max-sm:col-span-2 max-sm:row-start-2 min-w-0"
        v-model:name="row.name" />
      <button type="button" :data-testid="'ceed-del-from-' + i" @click="delFromRow(i)"
        class="col-start-4 row-start-1 justify-self-end max-sm:col-start-2 p-sm text-on-surface-variant hover:text-error rounded-lg relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
        <span class="material-symbols-outlined text-base">delete</span>
      </button>
    </div>
  </div>
</template>
