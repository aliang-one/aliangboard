<script setup>
// ns allowlist 编辑器:boundSA_namespace 永远在(不可删)+ 额外 ns 自由文本 chip。v-model 一个「额外 ns」数组。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
const props = defineProps({
  boundNs: { type: String, default: '' },
  modelValue: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const input = ref('')
const errMsg = ref('')
const NS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const extra = computed(() => props.modelValue || [])
function commit(next) { emit('update:modelValue', next) }
function add() {
  const v = input.value.trim()
  if (!v) { input.value = ''; errMsg.value = ''; return }
  if (v === props.boundNs) { errMsg.value = t('nsAllowlist.dup'); input.value = ''; return }
  if (!NS_NAME.test(v) || v.length > 63) { errMsg.value = t('nsAllowlist.invalid'); input.value = ''; return }
  if (extra.value.includes(v)) { errMsg.value = t('nsAllowlist.dup'); input.value = ''; return }
  commit([...extra.value, v]); input.value = ''; errMsg.value = ''
}
function remove(ns) { commit(extra.value.filter(x => x !== ns)) }
</script>
<template>
  <div class="bg-surface-container-low border border-outline-variant rounded-lg p-sm flex flex-col gap-xs">
    <div class="flex flex-wrap gap-1 items-center">
      <span v-if="boundNs" class="px-1.5 py-0.5 rounded text-body-xs font-mono bg-primary/15 text-primary">{{ boundNs }}</span>
      <span v-if="boundNs" class="text-body-xs text-on-surface-variant">{{ t('nsAllowlist.boundAlways') }}</span>
      <span v-for="ns in extra" :key="ns" class="px-1.5 py-0.5 rounded text-body-xs font-mono bg-status-running/15 text-status-running flex items-center gap-0.5">
        {{ ns }}<button type="button" @click="remove(ns)" class="hover:text-error">×</button>
      </span>
      <input v-model="input" @keydown.enter.prevent="add" :placeholder="t('nsAllowlist.addPlaceholder')"
        class="bg-transparent border-b border-outline-variant text-body-xs font-mono px-1 py-0.5 outline-none focus:border-primary min-w-[12rem]" />
    </div>
    <p v-if="errMsg" class="text-body-xs text-error">{{ errMsg }}</p>
  </div>
</template>
