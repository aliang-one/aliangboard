<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'

// 环境变量来源选择器（ConfigMap / Secret）：资源名 + key 均为「可选可输」的自定义 combobox。
// 用自定义下拉面板（而非原生 <datalist>）：原生 datalist 弹层由浏览器渲染，暗色模式下是纯黑、无法用应用主题染色。
// 自定义面板用应用 token（bg-surface-container-lowest + shadow），与整站一致；
// 仍允许手输（资源尚未创建 / 跨命名空间 / 列表未加载时）。
// - kind: 'configmap' | 'secret'
// - namespace: 显式传入，按它过滤候选
// - withKey: false 时只渲染资源名（envFrom 整体引用场景）
// - size: 'sm'(编辑弹窗) | 'md'(创建流)
const props = defineProps({
  kind: { type: String, required: true, validator: v => v === 'configmap' || v === 'secret' },
  namespace: { type: String, default: '' },
  withKey: { type: Boolean, default: true },
  size: { type: String, default: 'sm' },
})
// 注意：model 名不能用 'key'（Vue 保留属性），否则 v-model:key 不绑定
const name = defineModel('name', { default: '' })
const dataKey = defineModel('dataKey', { default: '' })

const { t } = useI18n()

const store = useClusterStore()
const _cid = computed(() => (store.currentCluster || 'cluster'))
const _cmQ = useResourceList({ key: ['cluster', _cid, 'configmaps'], fetcher: () => store.fetchConfigMaps(), options: { refetchInterval: 30000 } })
const _secQ = useResourceList({ key: ['cluster', _cid, 'secrets'], fetcher: () => store.fetchSecrets(), options: { refetchInterval: 30000 } })

const list = computed(() => (props.kind === 'secret' ? (_secQ.data.value || []) : (_cmQ.data.value || [])))
const resourceOptions = computed(() => list.value.filter(r => r.namespace === props.namespace).map(r => r.name))
const selected = computed(() => list.value.find(r => r.name === name.value && r.namespace === props.namespace))
const keyOptions = computed(() => Object.keys(selected.value?.data || {}))

// ④ ns 漂移警示:name 非空 && 列表已成功加载 && 当前 ns 无精确匹配(不拦提交,尊重跨 ns 手输)
const listLoaded = computed(() => (props.kind === 'secret' ? _secQ.isSuccess.value : _cmQ.isSuccess.value))
const nsMissing = computed(() => Boolean(name.value && name.value.trim()) && listLoaded.value && !selected.value)

const openName = ref(false)
const openKey = ref(false)
const filterName = computed(() => {
  const q = (name.value || '').toLowerCase()
  const opts = resourceOptions.value
  return q ? opts.filter(o => o.toLowerCase().includes(q)) : opts
})
const filterKey = computed(() => {
  const q = (dataKey.value || '').toLowerCase()
  const opts = keyOptions.value
  return q ? opts.filter(o => o.toLowerCase().includes(q)) : opts
})

const activeName = ref(-1)
const activeKey = ref(-1)

const nameWrap = ref(null)
const keyWrap = ref(null)
function onDocMousedown(e) {
  if (nameWrap.value && !nameWrap.value.contains(e.target)) openName.value = false
  if (keyWrap.value && !keyWrap.value.contains(e.target)) openKey.value = false
}
onMounted(() => document.addEventListener('mousedown', onDocMousedown))
onUnmounted(() => document.removeEventListener('mousedown', onDocMousedown))

function pickName(o) { name.value = o; openName.value = false; clearDataKey() }
function pickKey(o) { dataKey.value = o; openKey.value = false }

// ② 用户换资源(键入或下拉重选)→ 清空 key;程序化赋值(复制 workload 回填)不触发 input 事件,不受影响
function clearDataKey() { if (props.withKey) dataKey.value = '' }

// ⑥ 键盘导航:↑/↓ 高亮、Enter 选中、Esc 关闭;失焦关闭(下拉选项 mousedown.prevent 保焦,不触发 blur)
function onNameFocus() { openName.value = true; activeName.value = -1 }
function onNameBlur() { openName.value = false }
function onNameKeydown(e) {
  const opts = filterName.value
  if (e.key === 'Escape') { openName.value = false; return }
  if (!openName.value || !opts.length) return
  if (e.key === 'ArrowDown') { e.preventDefault(); activeName.value = (activeName.value + 1) % opts.length }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeName.value = (activeName.value - 1 + opts.length) % opts.length }
  else if (e.key === 'Enter') { e.preventDefault(); const o = opts[activeName.value]; if (o) pickName(o) }
}
function onKeyFocus() { openKey.value = true; activeKey.value = -1 }
function onKeyBlur() { openKey.value = false }
function onKeyKeydown(e) {
  const opts = filterKey.value
  if (e.key === 'Escape') { openKey.value = false; return }
  if (!openKey.value || !opts.length) return
  if (e.key === 'ArrowDown') { e.preventDefault(); activeKey.value = (activeKey.value + 1) % opts.length }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeKey.value = (activeKey.value - 1 + opts.length) % opts.length }
  else if (e.key === 'Enter') { e.preventDefault(); const o = opts[activeKey.value]; if (o) pickKey(o) }
}

const inputClass = computed(() => props.size === 'md'
  ? 'w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors'
  : 'w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors')
const panelClass = 'absolute z-30 left-0 right-0 mt-1 max-h-52 overflow-y-auto rounded-md border border-outline-variant bg-surface-container-lowest shadow-lg py-xs'
const optClass = 'w-full text-left px-sm py-xs hover:bg-primary-container/15 text-on-surface transition-colors truncate'
</script>

<template>
  <div class="min-w-0 w-full">
    <div class="flex gap-xs min-w-0">
      <!-- 资源名 combobox -->
      <div ref="nameWrap" class="relative flex-1 min-w-0">
        <input
          v-model="name" :class="inputClass"
          @focus="onNameFocus"
          @input="clearDataKey"
          @keydown="onNameKeydown"
          @blur="onNameBlur"
          :placeholder="kind === 'secret' ? 'Secret' : 'ConfigMap'"
        />
        <div v-if="openName && filterName.length" :class="panelClass">
          <button type="button" v-for="(o, i) in filterName" :key="o" @mousedown.prevent="pickName(o)" :class="[optClass, i === activeName ? 'bg-primary-container/40' : '']" :title="o">{{ o }}</button>
        </div>
      </div>
      <!-- key combobox -->
      <div v-if="withKey" ref="keyWrap" class="relative flex-1 min-w-0">
        <input
          v-model="dataKey" :class="inputClass"
          @focus="onKeyFocus"
          @keydown="onKeyKeydown"
          @blur="onKeyBlur"
          placeholder="key"
        />
        <div v-if="openKey && filterKey.length" :class="panelClass">
          <button type="button" v-for="(o, i) in filterKey" :key="o" @mousedown.prevent="pickKey(o)" :class="[optClass, i === activeKey ? 'bg-primary-container/40' : '']" :title="o">{{ o }}</button>
        </div>
      </div>
    </div>
    <!-- ④ ns 漂移警示 -->
    <div v-if="nsMissing" class="mt-xs text-xs text-error/80">{{ t('envSource.nsMissing') }}</div>
  </div>
</template>
