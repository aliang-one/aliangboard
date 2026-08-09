<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { emptySelector } from '@/logic/networkPolicy'

const props = defineProps({
  modelValue: { type: Object, default: () => emptySelector() },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

// Internal row arrays: labels([{key,value}]), expressions([{key,operator,values}]).
// values is a comma-separated string in the UI; split into array on emit.
const labels = ref([])
const expressions = ref([])

function syncFromProps() {
  labels.value = Object.entries(props.modelValue.matchLabels || {}).map(([key, value]) => ({ key, value }))
  expressions.value = (props.modelValue.matchExpressions || []).map(e => ({
    key: e.key,
    operator: e.operator || 'In',
    values: (e.values || []).join(', '),
  }))
}
watch(() => props.modelValue, syncFromProps, { immediate: true, deep: true })

function emitUp() {
  const matchLabels = {}
  for (const l of labels.value) {
    if (l.key.trim()) matchLabels[l.key.trim()] = l.value
  }
  const matchExpressions = expressions.value
    .filter(e => e.key.trim())
    .map(e => ({
      key: e.key.trim(),
      operator: e.operator || 'In',
      values: (e.values || '').split(',').map(s => s.trim()).filter(Boolean),
    }))
  emit('update:modelValue', { matchLabels, matchExpressions })
}

function addLabel() { labels.value.push({ key: '', value: '' }) }
function removeLabel(i) { labels.value.splice(i, 1); emitUp() }
function addExpr() { expressions.value.push({ key: '', operator: 'In', values: '' }) }
function removeExpr(i) { expressions.value.splice(i, 1); emitUp() }
</script>

<template>
  <div class="flex flex-col gap-sm">
    <!-- matchLabels -->
    <div v-for="(l, i) in labels" :key="'l' + i" class="flex items-center gap-sm">
      <input v-model="l.key" data-test="lbl-key" placeholder="key" @input="emitUp"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <span class="text-on-surface-variant">=</span>
      <input v-model="l.value" data-test="lbl-val" placeholder="value" @input="emitUp"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <button :data-test="'remove-label-' + i" @click="removeLabel(i)" class="p-xs text-on-surface-variant hover:text-error">
        <span class="material-symbols-outlined text-sm">remove</span>
      </button>
    </div>
    <button @click="addLabel" data-test="add-label"
      class="self-start text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">
      {{ t('ns.netpolCreate.addLabel') }}
    </button>

    <!-- matchExpressions -->
    <div class="text-label-caps text-on-surface-variant mt-xs">{{ t('ns.netpolCreate.matchExpressions') }}</div>
    <div v-for="(e, i) in expressions" :key="'e' + i" class="flex items-center gap-sm">
      <input v-model="e.key" data-test="expr-key" placeholder="key" @input="emitUp"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <select v-model="e.operator" data-test="expr-op" @change="emitUp"
        class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm">
        <option v-for="op in ['In', 'NotIn', 'Exists', 'DoesNotExist']" :key="op">{{ op }}</option>
      </select>
      <input v-model="e.values" data-test="expr-values"
        :placeholder="t('ns.netpolCreate.exprValuesPlaceholder')" @input="emitUp"
        class="flex-[2] bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <button :data-test="'remove-expr-' + i" @click="removeExpr(i)" class="p-xs text-on-surface-variant hover:text-error">
        <span class="material-symbols-outlined text-sm">remove</span>
      </button>
    </div>
    <button @click="addExpr" data-test="add-expr"
      class="self-start text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">
      {{ t('ns.netpolCreate.addExpression') }}
    </button>
  </div>
</template>
