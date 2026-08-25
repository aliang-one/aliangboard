<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  keyPlaceholder: { type: String, default: '' },
  valuePlaceholder: { type: String, default: '' },
  multiline: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const { t } = useI18n()

const PREFIX_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/
const NAME_RE = /^[-._a-zA-Z0-9]+$/

function keyInvalid(k) {
  if (!k) return false
  const slash = k.indexOf('/')
  if (slash === -1) return !NAME_RE.test(k)
  const prefix = k.slice(0, slash)
  const name = k.slice(slash + 1)
  return !PREFIX_RE.test(prefix) || !name || !NAME_RE.test(name)
}

const keyCounts = computed(() => {
  const m = new Map()
  for (const row of props.modelValue) {
    if (!row.key) continue
    m.set(row.key, (m.get(row.key) || 0) + 1)
  }
  return m
})

function isDup(k) {
  return !!k && (keyCounts.value.get(k) || 0) >= 2
}

function emitRows(rows) {
  emit('update:modelValue', rows.map(r => ({ key: r.key, value: r.value })))
}

function addRow() {
  emitRows([...props.modelValue, { key: '', value: '' }])
}

function removeRow(idx) {
  emitRows(props.modelValue.filter((_, i) => i !== idx))
}

function updateRow(idx, field, v) {
  emitRows(props.modelValue.map((r, i) => (i === idx ? { ...r, [field]: v } : r)))
}
</script>

<template>
  <div class="flex flex-col gap-sm">
    <div
      v-for="(row, idx) in modelValue"
      :key="idx"
      data-testid="kv-row"
      :data-dup="isDup(row.key) ? 'true' : undefined"
      :data-invalid="keyInvalid(row.key) ? 'true' : undefined"
      class="flex gap-sm items-start bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm"
      :class="isDup(row.key) || keyInvalid(row.key) ? 'border-error' : ''"
    >
      <input
        :value="row.key"
        data-testid="kv-key"
        :placeholder="keyPlaceholder"
        @input="updateRow(idx, 'key', $event.target.value)"
        class="flex-1 bg-transparent border rounded-lg px-sm py-xs text-body-md font-mono min-w-0"
        :class="isDup(row.key) || keyInvalid(row.key) ? 'border-error text-error' : 'border-outline-variant'"
      />
      <textarea
        v-if="multiline"
        :value="row.value"
        data-testid="kv-value"
        :placeholder="valuePlaceholder"
        rows="3"
        @input="updateRow(idx, 'value', $event.target.value)"
        class="flex-1 bg-transparent border border-outline-variant rounded-lg px-sm py-xs text-body-md min-w-0"
      />
      <input
        v-else
        :value="row.value"
        data-testid="kv-value"
        :placeholder="valuePlaceholder"
        @input="updateRow(idx, 'value', $event.target.value)"
        class="flex-1 bg-transparent border border-outline-variant rounded-lg px-sm py-xs text-body-md min-w-0"
      />
      <button
        data-testid="kv-del"
        type="button"
        :title="t('common.delete')"
        @click="removeRow(idx)"
        class="p-xs text-on-surface-variant hover:text-error rounded-lg"
      >
        <span class="material-symbols-outlined text-lg">delete</span>
      </button>
    </div>
    <button
      data-testid="kv-add"
      type="button"
      @click="addRow"
      class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg"
    >
      <span class="material-symbols-outlined">add</span> {{ t('component.kvRows.add') }}
    </button>
  </div>
</template>
