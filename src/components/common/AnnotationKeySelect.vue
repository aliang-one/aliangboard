<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { INGRESS_ANNOTATION_SUGGESTIONS } from '@/composables/useIngressPerf'

const { t } = useI18n()

// 注解 key 选择器：原生 <select>（按前缀分组，可靠、无定位/裁剪问题）。
// 默认从常用注解里选；选「✍️ 自定义」时才出现输入框（默认体验是纯下拉，保留任意 key 能力）。
const CUSTOM = '__custom__'
const props = defineProps({
  modelValue: { type: String, default: '' },
  fieldClass: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const key = computed({ get: () => props.modelValue, set: v => emit('update:modelValue', v) })

const known = new Set(INGRESS_ANNOTATION_SUGGESTIONS.map(s => s.value))
const isCustom = ref(!!key.value && !known.has(key.value))   // 现有 key 非空且不在常用列表 → 自定义模式

const selectVal = computed({
  get: () => (isCustom.value ? CUSTOM : key.value),
  set: v => {
    if (v === CUSTOM) { isCustom.value = true; key.value = '' }
    else { isCustom.value = false; key.value = v }
  },
})

// 按前缀（最后一个 / 之前）分组
const groups = computed(() => {
  const map = new Map()
  for (const s of INGRESS_ANNOTATION_SUGGESTIONS) {
    const i = s.value.lastIndexOf('/')
    const prefix = i > 0 ? s.value.slice(0, i) : t('component.annotationKey.otherGroup')
    const suffix = i > 0 ? s.value.slice(i + 1) : s.value
    if (!map.has(prefix)) map.set(prefix, [])
    map.get(prefix).push({ value: s.value, text: `${suffix} — ${t(s.descKey)}` })
  }
  return [...map.entries()].map(([label, items]) => ({ label, items }))
})

const cls = props.fieldClass || 'w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors'
</script>

<template>
  <div class="flex flex-col gap-xs">
    <select v-model="selectVal" :class="cls">
      <option value="">{{ t('component.annotationKey.selectPlaceholder') }}</option>
      <optgroup v-for="g in groups" :key="g.label" :label="g.label">
        <option v-for="it in g.items" :key="it.value" :value="it.value">{{ it.text }}</option>
      </optgroup>
      <option :value="CUSTOM">{{ t('component.annotationKey.custom') }}</option>
    </select>
    <input v-if="isCustom" v-model="key" :class="cls" :placeholder="t('component.annotationKey.customPlaceholder')" />
  </div>
</template>
