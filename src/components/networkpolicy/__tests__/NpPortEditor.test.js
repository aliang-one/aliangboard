import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NpPortEditor from '@/components/networkpolicy/NpPortEditor.vue'
import { i18n } from '@/i18n'

// 组件用 useI18n（i18n:check 禁止 src/** 内 CJK），必须挂 i18n 插件。
// NpPortEditor 的 isNumeric/endPort 显示读 props.modelValue，需把 emit 回写 prop 才能往返。
const mountWith = (propsArg) => {
  const wrapper = mount(NpPortEditor, {
    props: { ...propsArg, 'onUpdate:modelValue': (v) => { wrapper.setProps({ modelValue: v }) } },
    global: { plugins: [i18n] },
  })
  return wrapper
}

test('NpPortEditor: 数字端口 + 协议 + endPort', async () => {
  const wrapper = mountWith({ modelValue: { protocol: 'TCP', port: '' } })
  await wrapper.find('input[data-test="port"]').setValue('80')
  await wrapper.find('input[data-test="endport"]').setValue('90')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted).toEqual({ protocol: 'TCP', port: 80, endPort: 90 })
})

test('NpPortEditor: 命名端口(字符串)不显示 endPort 控件语义 — port 为字符串时 endPort 不 emit', async () => {
  const wrapper = mountWith({ modelValue: { protocol: 'TCP', port: '' } })
  await wrapper.find('input[data-test="port"]').setValue('https')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.port).toBe('https')
  expect(emitted.endPort).toBeUndefined()
})
