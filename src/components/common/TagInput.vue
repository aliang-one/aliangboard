<script setup>
// 业务标签输入组件：chip 可删 + 回车/逗号提交 + 上限 max 个 + 输入即过滤建议（来自同 ns 历史）。
// modelValue 为逗号分隔字符串（与 aliangboard.io/tags annotation 落点一致）。
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { syncTagHistory, getTagSuggestions } from '@/composables/useTagHistory'

const { t } = useI18n()

const props = defineProps({
  modelValue: { type: String, default: '' },
  namespace: { type: String, default: '' },
  max: { type: Number, default: 3 },
})
const emit = defineEmits(['update:modelValue'])

const store = useClusterStore()
// 标签历史源走 Vue Query（store.nsWorkloads 在 remote 下孤立）
const _cid = computed(() => (store.currentCluster || 'cluster'))
const _wlsQ = useResourceList({ key: ['cluster', _cid, 'workloads'], fetcher: () => store.fetchWorkloads(), options: { refetchInterval: 30000 } })
const nsWorkloads = computed(() => (_wlsQ.data.value || []).filter(w => w.namespace === props.namespace))
const input = ref('')
const focused = ref(false)
const suggestions = ref([])

// 已选标签数组（来自 modelValue）
const tags = computed(() =>
  String(props.modelValue || '').split(',').map(s => s.trim()).filter(Boolean)
)
const atMax = computed(() => tags.value.length >= props.max)

// 刷新建议：同步历史（从同 ns 的 workload 收集）+ 按输入过滤 + 排除已选
function refresh() {
  if (props.namespace) {
    syncTagHistory(props.namespace, nsWorkloads.value)
  }
  const chosen = new Set(tags.value.map(t => t.toLowerCase()))
  suggestions.value = getTagSuggestions(props.namespace, input.value)
    .filter(s => !chosen.has(s.tag.toLowerCase()))
    .slice(0, 8)
}

function commit(rawTag) {
  const tag = String(rawTag || '').trim().replace(/,+$/, '').trim()
  if (!tag) return
  if (tags.value.length >= props.max) return   // 超过上限不再加
  const exists = tags.value.some(t => t.toLowerCase() === tag.toLowerCase())
  if (!exists) emit('update:modelValue', [...tags.value, tag].join(','))
  input.value = ''
  refresh()
}
function remove(tag) {
  emit('update:modelValue', tags.value.filter(t => t !== tag).join(','))
  refresh()
}
function onKeydown(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    commit(input.value)
  } else if (e.key === 'Backspace' && !input.value && tags.value.length) {
    // 空输入时退格删除最后一个标签
    remove(tags.value[tags.value.length - 1])
  }
}
function onFocus() { focused.value = true; refresh() }
function onBlur() {
  // 延迟关闭，确保 mousedown 点击建议先于失焦
  setTimeout(() => { focused.value = false }, 150)
}

onMounted(refresh)
watch(() => props.namespace, refresh)
watch(() => props.modelValue, refresh)
watch(input, refresh)
</script>

<template>
  <div>
    <div class="relative">
      <!-- chip 容器 -->
      <div
        class="flex flex-wrap items-center gap-1 bg-surface-container-low border rounded-lg px-sm py-1.5 min-h-[38px] transition-colors focus-within:ring-2 focus-within:ring-primary focus-within:border-primary"
        :class="atMax ? 'border-tertiary-container/60' : 'border-outline-variant'"
      >
        <span
          v-for="tag in tags"
          :key="tag"
          class="inline-flex items-center gap-0.5 bg-primary-container text-on-primary-container text-xs font-medium pl-2 pr-1 py-0.5 rounded-md"
        >
          {{ tag }}
          <button type="button" @click="remove(tag)" class="hover:text-error rounded p-0.5" :title="t('component.tagInput.removeTag', { tag })">
            <span class="material-symbols-outlined text-sm leading-none">close</span>
          </button>
        </span>
        <input
          v-model="input"
          :disabled="atMax"
          :placeholder="atMax ? t('component.tagInput.atMax', { max }) : (tags.length ? '' : t('component.tagInput.inputPlaceholder'))"
          @keydown="onKeydown"
          @focus="onFocus"
          @blur="onBlur"
          class="flex-1 min-w-[80px] bg-transparent outline-none text-body-sm py-0.5 disabled:cursor-not-allowed"
        />
        <span class="ml-auto shrink-0 text-[10px] tabular-nums" :class="atMax ? 'text-tertiary-container' : 'text-on-surface-variant/50'">
          {{ tags.length }}/{{ max }}
        </span>
      </div>

      <!-- 建议下拉 -->
      <div
        v-if="focused && suggestions.length"
        class="absolute z-30 top-full left-0 right-0 mt-1 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg max-h-48 overflow-auto"
      >
        <button
          v-for="s in suggestions"
          :key="s.tag"
          type="button"
          @mousedown.prevent="commit(s.tag)"
          class="w-full flex items-center justify-between gap-sm px-md py-sm text-body-sm hover:bg-primary-container/20 transition-colors text-left"
        >
          <span class="font-medium">{{ s.tag }}</span>
          <span v-if="s.count > 0" class="text-[10px] text-on-surface-variant shrink-0">{{ t('component.tagInput.usageCount', { count: s.count }) }}</span>
        </button>
      </div>
    </div>
    <p class="mt-1 text-[10px] text-on-surface-variant/70 flex items-center gap-1">
      <span class="material-symbols-outlined text-xs">label</span>
      {{ t('component.tagInput.hint', { max }) }}
    </p>
  </div>
</template>
