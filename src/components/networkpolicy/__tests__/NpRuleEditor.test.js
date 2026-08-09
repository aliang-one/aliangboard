import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NpRuleEditor from '@/components/networkpolicy/NpRuleEditor.vue'
import { emptyIngressRule, emptyEgressRule, emptyPeer, emptyPort } from '@/logic/networkPolicy'
import { i18n } from '@/i18n'

// 组件用 useI18n（i18n:check 禁止 src/** 内 CJK），必须挂 i18n 插件。
// NpPeerEditor/NpPortEditor 子组件真实渲染（它们各自的测试已过）。
// 多步交互（增 peer 后改 cidr）需把 emit 回写 prop，否则后续控件不渲染。
const mountWith = (propsArg) => {
  const wrapper = mount(NpRuleEditor, {
    props: { ...propsArg, 'onUpdate:modelValue': (v) => { wrapper.setProps({ modelValue: v }) } },
    global: { plugins: [i18n] },
  })
  return wrapper
}

test('NpRuleEditor ingress: 增一个 peer → emit.from 长度 1（起始 from:[]）', async () => {
  const wrapper = mountWith({ modelValue: emptyIngressRule(), direction: 'ingress' })
  await wrapper.find('button[data-test="add-peer"]').trigger('click')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.from.length).toBe(1)
  expect(emitted.from[0]).toEqual(emptyPeer())
  expect(emitted.ports).toEqual([])
})

test('NpRuleEditor egress: 增一个 peer 写 to 而非 from', async () => {
  const wrapper = mountWith({ modelValue: emptyEgressRule(), direction: 'egress' })
  await wrapper.find('button[data-test="add-peer"]').trigger('click')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.to.length).toBe(1)
  expect(emitted.from).toBeUndefined()
})

test('NpRuleEditor: 增一个 port → emit.ports 长度 1', async () => {
  const wrapper = mountWith({ modelValue: emptyIngressRule(), direction: 'ingress' })
  await wrapper.find('button[data-test="add-port"]').trigger('click')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.ports.length).toBe(1)
  expect(emitted.ports[0]).toEqual(emptyPort())
})

test('NpRuleEditor: 删 peer → from 长度减 1', async () => {
  const rule = emptyIngressRule()
  rule.from = [emptyPeer(), emptyPeer()]
  const wrapper = mountWith({ modelValue: rule, direction: 'ingress' })
  // 有两个 peer，各带一个 delete 按钮（add-peer 按钮不带 delete class）
  const delBtns = wrapper.findAll('button.delete-peer')
  expect(delBtns).toHaveLength(2)
  await delBtns[0].trigger('click')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.from.length).toBe(1)
})

test('NpRuleEditor: 删 port → ports 长度减 1', async () => {
  const rule = emptyIngressRule()
  rule.ports = [emptyPort(), emptyPort()]
  const wrapper = mountWith({ modelValue: rule, direction: 'ingress' })
  const delBtns = wrapper.findAll('button.delete-port')
  expect(delBtns).toHaveLength(2)
  await delBtns[1].trigger('click')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.ports.length).toBe(1)
})

test('NpRuleEditor: 子组件 NpPeerEditor 的 update 上浮为 rule emit', async () => {
  const rule = emptyIngressRule()
  rule.from = [emptyPeer()]
  const wrapper = mountWith({ modelValue: rule, direction: 'ingress' })
  // 在已有 peer 里勾 ipBlock（NpPeerEditor 内 has-ip checkbox）
  await wrapper.find('input[data-test="has-ip"]').setValue(true)
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.from[0].ipBlock).toBeDefined()
})

test('NpRuleEditor: 子组件 NpPortEditor 的 update 上浮为 rule emit', async () => {
  const rule = emptyIngressRule()
  rule.ports = [emptyPort()]
  const wrapper = mountWith({ modelValue: rule, direction: 'ingress' })
  await wrapper.find('input[data-test="port"]').setValue('443')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.ports[0].port).toBe(443)
})

test('NpRuleEditor: clone-before-mutate — emit 是新对象，不修改原 prop', async () => {
  const rule = emptyIngressRule()
  const wrapper = mountWith({ modelValue: rule, direction: 'ingress' })
  await wrapper.find('button[data-test="add-peer"]').trigger('click')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted).not.toBe(rule)
  expect(rule.from).toEqual([])
})
