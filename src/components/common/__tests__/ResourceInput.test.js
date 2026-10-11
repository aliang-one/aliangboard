import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import ResourceInput from '@/components/common/ResourceInput.vue'

// ---- 回声(echo)回归锁 ----
// 背景:emitVal 每键击 emit 规范串(formatQuantity 产物)→ v-model 父回写 →
// watch(props.modelValue) 的 sync 把【自己的回声】当外部重填重写 num/unit——
// cpu cores 键入 '0.' 被规范化回灌吃掉小数点、'05' 被 Number() 规范化中途重写。
// Vue 对 type=number 的 v-model 刻意保留 '05' 前导零(runtime-dom castValue),
// 回声 sync 不得覆盖该中间态。修复 = 回声守卫(自己刚 emit 的串回流不算外部变化)。

function mountTwoWay(kind = 'cpu', initial = '') {
  const Host = defineComponent({
    components: { ResourceInput },
    setup: () => ({ v: ref(initial), kind }),
    template: '<ResourceInput v-model="v" :kind="kind" />',
  })
  const wrapper = mount(Host)
  return { wrapper, input: wrapper.find('input[type="number"]'), getVal: () => wrapper.vm.v }
}

test('ResourceInput: v-model 双向接线键入 "0." 中间态不被回声吃掉(cpu 小数)', async () => {
  const { input, getVal, wrapper } = mountTwoWay('cpu')
  // cpu 空值默认单位已是 m(2026-10-11 表首改 m),小数核用例显式切 cores
  await wrapper.find('select').setValue('')
  await input.setValue('0')
  await input.setValue('0.')
  // 修复前:emit '0' 回灌 sync 重写 num='0',小数点当场消失
  expect(input.element.value).toBe('0.')
  await input.setValue('0.5')
  expect(getVal()).toBe('0.5')
  expect(input.element.value).toBe('0.5')
})

test('ResourceInput: 键入 "05" 前导零中间态不被回声规范化重写', async () => {
  const { input, getVal, wrapper } = mountTwoWay('cpu')
  await wrapper.find('select').setValue('')
  await input.setValue('05')
  // Vue v-model 对 '05' 保留字符串(不做 Number 规范化),回声不得把输入框改成 '5'
  expect(input.element.value).toBe('05')
  expect(getVal()).toBe('5') // emit 侧规范串不变(契约保持)
})

test('ResourceInput: 外部重填(非回声)仍同步', async () => {
  const wrapper = mount(ResourceInput, { props: { modelValue: '100m', kind: 'cpu' } })
  await wrapper.setProps({ modelValue: '2' })
  expect(wrapper.find('input[type="number"]').element.value).toBe('2')
  // 单位同步
  wrapper.findAll('select option')
  expect(wrapper.find('select').element.value).toBe('')
})

// ---- 2026-10-11 换算层根修:单位切换换算 / 非法输入清框 / 单位感知占位符 / 外来串显示 ----

test('ResourceInput: 单位切换按物理量换算(4000m 切 cores → 4,不再 4000 核千倍膨胀)', async () => {
  const { input, getVal, wrapper } = mountTwoWay('cpu', '4000m')
  await wrapper.find('select').setValue('')
  expect(getVal()).toBe('4')
  expect(input.element.value).toBe('4')
})

test('ResourceInput: 单位切换 512Mi 切 Gi → 0.5Gi(不再 512Gi 千倍膨胀)', async () => {
  const Host = defineComponent({ components: { ResourceInput }, setup: () => ({ v: ref('512Mi') }), template: '<ResourceInput v-model="v" kind="memory" />' })
  const wrapper = mount(Host)
  await wrapper.find('select').setValue('Gi')
  expect(wrapper.vm.v).toBe('0.5Gi')
  expect(wrapper.find('input[type=number]').element.value).toBe('0.5')
})

test('ResourceInput: 反向切换 2 cores 切 m → 2000m', async () => {
  const { getVal, wrapper } = mountTwoWay('cpu', '2')
  await wrapper.find('select').setValue('m')
  expect(getVal()).toBe('2000m')
})

test('ResourceInput: 数值空时切单位 → 仅换单位不产值', async () => {
  const { getVal, wrapper } = mountTwoWay('cpu', '4000m')
  await wrapper.find('input[type=number]').setValue('')
  await wrapper.find('select').setValue('')
  expect(getVal()).toBe('')
})

test('ResourceInput: 负数输入即清框(框显=模型,不再框显 -5 模型空)', async () => {
  const { input, getVal } = mountTwoWay('cpu')
  await input.setValue('-5')
  expect(getVal()).toBe('')
  expect(input.element.value).toBe('')
})

test('ResourceInput: 小数不再被取整分叉(1.5 Gi 框显与载荷一致)', async () => {
  const Host = defineComponent({ components: { ResourceInput }, setup: () => ({ v: ref('') }), template: '<ResourceInput v-model="v" kind="memory" />' })
  const wrapper = mount(Host)
  await wrapper.find('select').setValue('Gi')
  await wrapper.find('input[type=number]').setValue('1.5')
  expect(wrapper.vm.v).toBe('1.5Gi')
  expect(wrapper.find('input[type=number]').element.value).toBe('1.5')
})

test('ResourceInput: 外来规范串正确显示(1G → 1 + G;100u → 0.1 + m)', async () => {
  const Host = defineComponent({ components: { ResourceInput }, setup: () => ({ v: ref('1G') }), template: '<ResourceInput v-model="v" kind="memory" />' })
  const wrapper = mount(Host)
  expect(wrapper.find('input[type=number]').element.value).toBe('1')
  expect(wrapper.find('select').element.value).toBe('G')
  const Host2 = defineComponent({ components: { ResourceInput }, setup: () => ({ v: ref('100u') }), template: '<ResourceInput v-model="v" kind="cpu" />' })
  const w2 = mount(Host2)
  expect(w2.find('input[type=number]').element.value).toBe('0.1')
  expect(w2.find('select').element.value).toBe('m')
})

test('ResourceInput: 占位符单位感知(规范串 "250m" 在 m 单位显 250、cores 单位显 0.25)', async () => {
  const Host = defineComponent({ components: { ResourceInput }, setup: () => ({ v: ref('') }), template: '<ResourceInput v-model="v" kind="cpu" placeholder="250m" />' })
  const wrapper = mount(Host)
  const input = wrapper.find('input[type=number]')
  // 空值默认单位为 m(表首)→ 占位符按 m 显示
  expect(input.element.placeholder).toBe('250')
  await wrapper.find('select').setValue('')
  expect(input.element.placeholder).toBe('0.25')
})

test('ResourceInput: 非规范占位符(文案类)原样透传', async () => {
  const wrapper = mount(ResourceInput, { props: { modelValue: '', kind: 'cpu', placeholder: 'CPU 请求' } })
  expect(wrapper.find('input[type=number]').element.placeholder).toBe('CPU 请求')
})
