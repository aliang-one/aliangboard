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
  const { input, getVal } = mountTwoWay('cpu')
  await input.setValue('0')
  await input.setValue('0.')
  // 修复前:emit '0' 回灌 sync 重写 num='0',小数点当场消失
  expect(input.element.value).toBe('0.')
  await input.setValue('0.5')
  expect(getVal()).toBe('0.5')
  expect(input.element.value).toBe('0.5')
})

test('ResourceInput: 键入 "05" 前导零中间态不被回声规范化重写', async () => {
  const { input, getVal } = mountTwoWay('cpu')
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
