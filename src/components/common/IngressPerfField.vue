<script setup>
// Ingress 性能字段渲染器:按 useIngressPerf.FIELD_VTS[fld.vt] 元信息渲染——
// number=数字框(+fld.unitKey 只读单位后缀,int 的 min/max 透传)、number-unit=数字+单位下拉(仿
// ResourceInput 先例)、text=文本+常显 hint、area/options 分支语义同原视图渲染。
// v-model 承载规范串('4k'/'60'/'50s'),内部拆合;buildIngressAnnotations 契约不变。
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FIELD_VTS } from '@/composables/useIngressPerf'

const props = defineProps({
  fld: { type: Object, required: true },
  modelValue: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const vt = computed(() => FIELD_VTS[props.fld.vt] || FIELD_VTS.free)
const isUnit = computed(() => vt.value.input === 'number-unit')
// text/select 分支无内部状态,直接 computed 代理;number 系用 num/unit 拆合
const raw = computed({ get: () => props.modelValue, set: v => emit('update:modelValue', v) })
const num = ref('')
const unit = ref('')

function sync(v) {
  const s = String(v ?? '').trim()
  const m = isUnit.value ? s.match(/^(\d+)([a-z]+)?$/) : null
  if (m) {
    num.value = m[1]
    unit.value = (m[2] && vt.value.units.includes(m[2])) ? m[2] : vt.value.defUnit
  } else if (vt.value.input === 'number') {
    // 非 number-unit 的 number 输入(如 int),纯数字直接赋值
    num.value = s
  } else {
    num.value = ''
    if (isUnit.value) unit.value = vt.value.defUnit
  }
}
sync(props.modelValue)
// 外部重填(编辑回显)时同步数字框/单位
watch(() => props.modelValue, v => sync(v))

function emitVal() { emit('update:modelValue', num.value ? num.value + (isUnit.value ? (unit.value || vt.value.defUnit) : '') : '') }

const inputCls = 'w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary'
const unitCls = 'bg-surface-container-low border border-l-0 border-outline-variant rounded-r-lg px-sm text-xs text-on-surface-variant'
</script>

<template>
  <div class="flex flex-col gap-xs">
    <textarea v-if="fld.area" v-model="raw" rows="2" :class="inputCls" :placeholder="fld.ph"></textarea>
    <select v-else-if="fld.options" v-model="raw" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm">
      <option v-for="o in fld.options" :key="o" :value="o">{{ o || t('ns.ingress.defaultOpt') }}</option>
    </select>
    <div v-else-if="isUnit" class="flex items-stretch">
      <input type="number" min="0" v-model="num" @input="emitVal" :class="inputCls + ' rounded-r-none'" :placeholder="fld.ph" />
      <select v-model="unit" @change="emitVal" :data-testid="'unit-' + fld.key" :class="unitCls + ' font-mono'">
        <option v-for="u in vt.units" :key="u" :value="u">{{ u }}</option>
      </select>
    </div>
    <div v-else-if="vt.input === 'number'" class="flex items-stretch">
      <input type="number" :min="fld.min" :max="fld.max" v-model="num" @input="emitVal" :class="inputCls + (fld.unitKey && t(fld.unitKey) ? ' rounded-r-none' : '')" :placeholder="fld.ph" />
      <span v-if="fld.unitKey && t(fld.unitKey)" :class="unitCls + ' flex items-center'">{{ t(fld.unitKey) }}</span>
    </div>
    <input v-else v-model="raw" :class="inputCls" :placeholder="fld.ph" />
    <p v-if="fld.area" class="text-xs text-on-surface-variant">{{ t('ingressPerf.hintSnippet') }}</p>
    <p v-else-if="vt.hintKey" class="text-xs text-on-surface-variant">{{ t(vt.hintKey) }}</p>
  </div>
</template>
