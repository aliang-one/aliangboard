<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import NpPeerEditor from './NpPeerEditor.vue'
import NpPortEditor from './NpPortEditor.vue'
import { emptyPeer, emptyPort } from '@/logic/networkPolicy'

const props = defineProps({
  modelValue: { type: Object, required: true },
  direction: { type: String, required: true }, // 'ingress' | 'egress'
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const peersKey = computed(() => props.direction === 'ingress' ? 'from' : 'to')
const peers = computed(() => props.modelValue[peersKey.value] || [])
const ports = computed(() => props.modelValue.ports || [])

function clone() { return JSON.parse(JSON.stringify(props.modelValue)) }

function addPeer() {
  const r = clone()
  r[peersKey.value] = [...peers.value, emptyPeer()]
  emit('update:modelValue', r)
}
function setPeer(i, p) {
  const r = clone()
  r[peersKey.value] = peers.value.map((x, idx) => idx === i ? p : x)
  emit('update:modelValue', r)
}
function removePeer(i) {
  const r = clone()
  r[peersKey.value] = peers.value.filter((_, idx) => idx !== i)
  emit('update:modelValue', r)
}

function addPort() {
  const r = clone()
  r.ports = [...ports.value, emptyPort()]
  emit('update:modelValue', r)
}
function setPort(i, p) {
  const r = clone()
  r.ports = ports.value.map((x, idx) => idx === i ? p : x)
  emit('update:modelValue', r)
}
function removePort(i) {
  const r = clone()
  r.ports = ports.value.filter((_, idx) => idx !== i)
  emit('update:modelValue', r)
}
</script>

<template>
  <div class="flex flex-col gap-sm border-l-2 border-primary/30 pl-md">
    <div class="text-label-caps text-on-surface-variant">
      {{ direction === 'ingress' ? t('ns.netpolCreate.sourceFrom') : t('ns.netpolCreate.targetTo') }}
    </div>
    <div v-for="(p, i) in peers" :key="'p'+i" class="flex items-start gap-sm">
      <div class="flex-1 min-w-0">
        <NpPeerEditor :model-value="p" @update:model-value="setPeer(i, $event)" />
      </div>
      <button class="delete-peer p-xs text-on-surface-variant hover:text-error shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('common.delete')" @click="removePeer(i)">
        <span class="material-symbols-outlined text-sm">delete</span>
      </button>
    </div>
    <button data-test="add-peer" class="self-start text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs" @click="addPeer">
      {{ t('ns.netpolCreate.addPeer') }}
    </button>

    <div class="text-label-caps text-on-surface-variant mt-xs">{{ t('ns.netpolCreate.ports') }}</div>
    <!-- 手机纵排(审计 NpRuleEditor:72):端口三元组+endPort 行 min-content ≈376px > 可用 ≈292px,
         端口组占满整行、删除钮对齐行尾 -->
    <div v-for="(p, i) in ports" :key="'port'+i" class="flex items-center gap-sm max-sm:flex-col max-sm:items-stretch">
      <NpPortEditor class="min-w-0" :model-value="p" @update:model-value="setPort(i, $event)" />
      <button class="delete-port p-xs text-on-surface-variant hover:text-error shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-[''] max-sm:self-end" :title="t('common.delete')" @click="removePort(i)">
        <span class="material-symbols-outlined text-sm">delete</span>
      </button>
    </div>
    <button data-test="add-port" class="self-start text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs" @click="addPort">
      {{ t('ns.netpolCreate.addPort') }}
    </button>
  </div>
</template>
