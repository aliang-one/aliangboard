<script setup>
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import NpSelectorEditor from './NpSelectorEditor.vue'
import NpRuleEditor from './NpRuleEditor.vue'
import { useResourceApply } from '@/composables/useResourceApply'
import {
  defaultModel, consequence, isDenyAll, modelToYaml, parseAndValidate,
  emptyIngressRule, emptyEgressRule,
} from '@/logic/networkPolicy'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: 'default' },
})
const emit = defineEmits(['update:modelValue', 'applied'])
const { t } = useI18n()
const { applyYaml } = useResourceApply()

const model = ref(defaultModel(props.namespace))
watch(() => props.namespace, ns => { model.value = defaultModel(ns) })
watch(() => props.modelValue, v => { if (v) { model.value = defaultModel(props.namespace); yamlError.value = ''; ackDenyAll.value = false } })

const spec = computed(() => model.value.spec)
const yamlText = computed(() => modelToYaml(model.value))

const nameRegex = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const nameValid = computed(() => nameRegex.test(model.value.metadata.name || ''))
const yamlEditing = ref(false)
const yamlError = ref('')
const ackDenyAll = ref(false)
const creating = ref(false)
const denyAll = computed(() => isDenyAll(spec.value))
const canCreate = computed(() => nameValid.value && (!denyAll.value || ackDenyAll.value))

const ingressCsq = computed(() => consequence(spec.value, 'ingress'))
const egressCsq = computed(() => consequence(spec.value, 'egress'))

function toggleType(type) {
  const arr = spec.value.policyTypes
  const i = arr.indexOf(type)
  if (i >= 0) arr.splice(i, 1); else arr.push(type)
}
function addIngressRule() { spec.value.ingress.push(emptyIngressRule()) }
function addEgressRule() { spec.value.egress.push(emptyEgressRule()) }
function setIngressRule(i, r) { spec.value.ingress[i] = r }
function setEgressRule(i, r) { spec.value.egress[i] = r }

// parseAndValidate code → i18n key 映射(前缀用变量避免静态扫描器误把
// 'ns.netpolCreate.err.' 当成完整键)
const ERR_KEYS = {
  parseError: t('ns.netpolCreate.err.parseError'),
  notNetworkPolicy: t('ns.netpolCreate.err.notNetworkPolicy'),
  nameRequired: t('ns.netpolCreate.err.nameRequired'),
}

function onYamlSave(text) {
  yamlEditing.value = false
  const res = parseAndValidate(text)
  if (res.ok) { model.value = res.model; yamlError.value = '' }
  else { yamlError.value = ERR_KEYS[res.code] || res.code }
}
function onYamlDiscard() { yamlEditing.value = false; yamlError.value = '' }

async function submit() {
  if (!canCreate.value || creating.value) return
  creating.value = true
  const res = await applyYaml(modelToYaml(model.value))
  creating.value = false
  if (res.ok) { emit('applied', res); emit('update:modelValue', false) }
  else { yamlError.value = res.error }
}

function csqStateMeta(state) {
  return {
    none: { icon: 'remove', cls: 'text-on-surface-variant', label: t('ns.netpolCreate.consequenceNone') },
    denyAll: { icon: 'block', cls: 'text-error', label: t('ns.netpolCreate.consequenceDenyAll') },
    allowAll: { icon: 'warning', cls: 'text-tertiary', label: t('ns.netpolCreate.consequenceAllowAll') },
    scoped: { icon: 'check_circle', cls: 'text-primary', label: t('ns.netpolCreate.consequenceScoped') },
  }[state]
}
</script>

<template>
  <Modal :model-value="modelValue" :title="t('ns.netpolCreate.title')" width="max-w-6xl"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-lg">
      <!-- 左:表单 -->
      <div :class="yamlEditing ? 'opacity-50 pointer-events-none' : ''" class="flex flex-col gap-md">
        <div v-if="yamlEditing" class="text-body-sm text-tertiary">{{ t('ns.netpolCreate.yamlEditingHint') }}</div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.netpolCreate.name') }} *</label>
          <input v-model="model.metadata.name" data-test="name-input" placeholder="my-policy"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm font-mono" />
          <p v-if="!nameValid && model.metadata.name" class="text-body-sm text-error mt-xs">{{ t('ns.netpolCreate.nameInvalid') }}</p>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.netpolCreate.podSelector') }}</label>
          <NpSelectorEditor :model-value="spec.podSelector" @update:model-value="spec.podSelector = $event" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.netpolCreate.policyTypes') }}</label>
          <div class="flex gap-md">
            <label class="flex items-center gap-xs"><input type="checkbox" :checked="spec.policyTypes.includes('Ingress')" @change="toggleType('Ingress')"> Ingress</label>
            <label class="flex items-center gap-xs"><input type="checkbox" :checked="spec.policyTypes.includes('Egress')" @change="toggleType('Egress')"> Egress</label>
          </div>
        </div>

        <!-- Ingress -->
        <div>
          <div class="flex items-center justify-between mb-xs">
            <span :class="csqStateMeta(ingressCsq.state).cls" class="flex items-center gap-xs text-body-sm font-medium">
              <span class="material-symbols-outlined text-sm">{{ csqStateMeta(ingressCsq.state).icon }}</span>
              {{ csqStateMeta(ingressCsq.state).label }}
            </span>
            <button @click="addIngressRule" class="text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">{{ t('ns.netpolCreate.addIngressRule') }}</button>
          </div>
          <div v-for="(r, i) in spec.ingress" :key="'in'+i" class="flex items-start gap-sm">
            <div class="flex-1"><NpRuleEditor :model-value="r" direction="ingress" @update:model-value="setIngressRule(i, $event)" /></div>
            <button :data-test="`rm-ingress-rule-${i}`" @click="spec.ingress.splice(i, 1)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">delete</span></button>
          </div>
        </div>

        <!-- Egress -->
        <div>
          <div class="flex items-center justify-between mb-xs">
            <span :class="csqStateMeta(egressCsq.state).cls" class="flex items-center gap-xs text-body-sm font-medium">
              <span class="material-symbols-outlined text-sm">{{ csqStateMeta(egressCsq.state).icon }}</span>
              {{ csqStateMeta(egressCsq.state).label }}
            </span>
            <button @click="addEgressRule" class="text-body-sm text-primary hover:bg-primary-container/10 rounded-lg px-md py-xs">{{ t('ns.netpolCreate.addEgressRule') }}</button>
          </div>
          <div v-for="(r, i) in spec.egress" :key="'eg'+i" class="flex items-center gap-sm">
            <div class="flex-1"><NpRuleEditor :model-value="r" direction="egress" @update:model-value="setEgressRule(i, $event)" /></div>
            <button @click="spec.egress.splice(i, 1)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">delete</span></button>
          </div>
        </div>
      </div>

      <!-- 右:YAML -->
      <div class="flex flex-col gap-sm">
        <YamlEditor :model-value="yamlText" :readonly="false" height="560px"
          @edit-start="yamlEditing = true" @save="onYamlSave" @discard="onYamlDiscard" />
        <p v-if="yamlError" class="text-body-sm text-error">{{ yamlError }}</p>
        <p v-if="denyAll" class="text-body-sm text-error">{{ t('ns.netpolCreate.denyAllWarn') }}</p>
      </div>
    </div>

    <template #actions>
      <label v-if="denyAll" class="flex items-center gap-xs text-body-sm text-error mr-auto">
        <input type="checkbox" data-test="ack-denyall" v-model="ackDenyAll" /> {{ t('ns.netpolCreate.denyAllConfirm') }}
      </label>
      <button @click="emit('update:modelValue', false)" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
      <button data-test="create" :disabled="!canCreate || creating" @click="submit"
        class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ t('ns.netpolCreate.create') }}</button>
    </template>
  </Modal>
</template>
