<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import NpSelectorEditor from './NpSelectorEditor.vue'
import { emptySelector } from '@/logic/networkPolicy'

const props = defineProps({ modelValue: { type: Object, required: true } })
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const hasPod = computed(() => !!props.modelValue.podSelector)
const hasNs = computed(() => !!props.modelValue.namespaceSelector)
const hasIp = computed(() => !!props.modelValue.ipBlock)

function clone() { return JSON.parse(JSON.stringify(props.modelValue)) }

function togglePod(v) { const p = clone(); v.target.checked ? (p.podSelector = emptySelector()) : (delete p.podSelector); emit('update:modelValue', p) }
function toggleNs(v) { const p = clone(); v.target.checked ? (p.namespaceSelector = emptySelector()) : (delete p.namespaceSelector); emit('update:modelValue', p) }
function toggleIp(v) { const p = clone(); v.target.checked ? (p.ipBlock = { cidr: '', except: [] }) : (delete p.ipBlock); emit('update:modelValue', p) }

function setPod(sel) { const p = clone(); p.podSelector = sel; emit('update:modelValue', p) }
function setNs(sel) { const p = clone(); p.namespaceSelector = sel; emit('update:modelValue', p) }
function setCidr(v) { const p = clone(); p.ipBlock = { ...p.ipBlock, cidr: v.target.value }; emit('update:modelValue', p) }
function setExcept(v) { const p = clone(); p.ipBlock = { ...p.ipBlock, except: v.target.value.split(',').map(s => s.trim()).filter(Boolean) }; emit('update:modelValue', p) }
</script>

<template>
  <div class="border border-outline-variant rounded-lg p-md flex flex-col gap-sm bg-surface-container-low/40">
    <div class="flex flex-wrap gap-md text-body-sm">
      <label class="flex items-center gap-xs"><input type="checkbox" data-test="has-pod" :checked="hasPod" @change="togglePod"> {{ t('ns.netpolCreate.peerPod') }}</label>
      <label class="flex items-center gap-xs"><input type="checkbox" data-test="has-ns" :checked="hasNs" @change="toggleNs"> {{ t('ns.netpolCreate.peerNamespace') }}</label>
      <label class="flex items-center gap-xs"><input type="checkbox" data-test="has-ip" :checked="hasIp" @change="toggleIp"> ipBlock</label>
    </div>
    <NpSelectorEditor v-if="hasPod" :model-value="modelValue.podSelector" @update:model-value="setPod" />
    <NpSelectorEditor v-if="hasNs" :model-value="modelValue.namespaceSelector" @update:model-value="setNs" />
    <div v-if="hasIp" class="flex items-center gap-sm">
      <input :value="modelValue.ipBlock.cidr" data-test="cidr" @input="setCidr" :placeholder="t('ns.netpolCreate.cidrPlaceholder')"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
      <input :value="(modelValue.ipBlock.except || []).join(', ')" data-test="except" @input="setExcept" :placeholder="t('ns.netpolCreate.exceptPlaceholder')"
        class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
    </div>
  </div>
</template>
