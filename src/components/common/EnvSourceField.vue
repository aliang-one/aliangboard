<script setup>
import { computed, useId } from 'vue'
import { useClusterStore } from '@/stores/cluster'

// 环境变量来源选择器（ConfigMap / Secret）：资源名 + key 均为「可选可输」。
// 用原生 <input> + <datalist>：下拉列出当前 namespace 的资源及其 data 的 key，
// 用户可点选，也可继续手输（资源尚未创建 / 跨命名空间 / 列表未加载时仍可用）。
// - kind: 'configmap' | 'secret'
// - namespace: 显式传入（不依赖 store.currentNamespace），按它过滤候选
// - withKey: false 时只渲染资源名（envFrom 整体引用场景）
// - size: 'sm'(编辑弹窗密集表单) | 'md'(创建流)
const props = defineProps({
  kind: { type: String, required: true, validator: v => v === 'configmap' || v === 'secret' },
  namespace: { type: String, default: '' },
  withKey: { type: Boolean, default: true },
  size: { type: String, default: 'sm' },
})
const name = defineModel('name', { default: '' })
const key = defineModel('key', { default: '' })

const store = useClusterStore()
const uid = useId()

const list = computed(() => (props.kind === 'secret' ? store.secretList : store.configMapList) || [])
const resourceOptions = computed(() => list.value.filter(r => r.namespace === props.namespace).map(r => r.name))
const selected = computed(() => list.value.find(r => r.name === name.value && r.namespace === props.namespace))
const keyOptions = computed(() => Object.keys(selected.value?.data || {}))

const inputClass = computed(() => props.size === 'md'
  ? 'flex-1 min-w-0 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono'
  : 'flex-1 min-w-0 bg-surface-container-low border border-outline-variant rounded px-sm py-sm text-xs font-mono')
</script>

<template>
  <div class="flex gap-xs min-w-0">
    <input
      :list="uid + '-res'" v-model="name"
      :class="inputClass"
      :placeholder="kind === 'secret' ? 'Secret' : 'ConfigMap'"
    />
    <datalist :id="uid + '-res'">
      <option v-for="r in resourceOptions" :key="r" :value="r" />
    </datalist>
    <template v-if="withKey">
      <input
        :list="uid + '-key'" v-model="key"
        :class="inputClass"
        placeholder="key"
      />
      <datalist :id="uid + '-key'">
        <option v-for="k in keyOptions" :key="k" :value="k" />
      </datalist>
    </template>
  </div>
</template>
