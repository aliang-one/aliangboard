import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NpPeerEditor from '@/components/networkpolicy/NpPeerEditor.vue'
import { emptyPeer, emptySelector } from '@/logic/networkPolicy'
import { i18n } from '@/i18n'

// 组件用 useI18n（i18n:check 禁止 src/** 内 CJK），必须挂 i18n 插件。
// 多步交互（勾 ipBlock 再填 cidr）需要把 emit 回写 prop，否则后续控件不渲染。
const mountWith = (propsArg) => {
  const wrapper = mount(NpPeerEditor, {
    props: { ...propsArg, 'onUpdate:modelValue': (v) => { wrapper.setProps({ modelValue: v }) } },
    global: { plugins: [i18n] },
  })
  return wrapper
}

test('NpPeerEditor: 默认含 podSelector(来自 emptyPeer) → has-pod 勾选、NpSelectorEditor 渲染', () => {
  const wrapper = mountWith({ modelValue: emptyPeer() })
  expect(wrapper.find('input[data-test="has-pod"]').element.checked).toBe(true)
  expect(wrapper.find('input[data-test="has-ns"]').element.checked).toBe(false)
  expect(wrapper.find('input[data-test="has-ip"]').element.checked).toBe(false)
  // podSelector 段渲染 NpSelectorEditor（其 add-label 按钮在场）
  expect(wrapper.find('button[data-test="add-label"]').exists()).toBe(true)
})

test('NpPeerEditor: 勾 ipBlock 并填 cidr → emit ipBlock.cidr', async () => {
  const wrapper = mountWith({ modelValue: emptyPeer() })
  await wrapper.find('input[data-test="has-ip"]').setValue(true)
  await wrapper.find('input[data-test="cidr"]').setValue('10.0.0.0/8')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.ipBlock.cidr).toBe('10.0.0.0/8')
})

test('NpPeerEditor: ipBlock except 逗号分隔 → 数组', async () => {
  const wrapper = mountWith({ modelValue: emptyPeer() })
  await wrapper.find('input[data-test="has-ip"]').setValue(true)
  await wrapper.find('input[data-test="except"]').setValue('10.0.1.0/24, 10.0.2.0/24')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.ipBlock.except).toEqual(['10.0.1.0/24', '10.0.2.0/24'])
})

test('NpPeerEditor: 取消勾 ipBlock → delete ipBlock 键', async () => {
  const wrapper = mountWith({ modelValue: emptyPeer() })
  await wrapper.find('input[data-test="has-ip"]').setValue(true)
  expect(wrapper.emitted('update:modelValue').at(-1)[0].ipBlock).toBeDefined()
  // 再取消勾
  await wrapper.find('input[data-test="has-ip"]').setValue(false)
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.ipBlock).toBeUndefined()
})

test('NpPeerEditor: 勾 namespaceSelector → 注入 emptySelector 并渲染', async () => {
  const wrapper = mountWith({ modelValue: emptyPeer() })
  await wrapper.find('input[data-test="has-ns"]').setValue(true)
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.namespaceSelector).toEqual(emptySelector())
  // 回写后 NpSelectorEditor 渲染两份(pod + ns)
  expect(wrapper.findAll('button[data-test="add-label"]')).toHaveLength(2)
})

test('NpPeerEditor: 组合 podSelector + namespaceSelector(AND) 都在 emit', async () => {
  const wrapper = mountWith({ modelValue: emptyPeer() })
  await wrapper.find('input[data-test="has-ns"]').setValue(true)
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.podSelector).toBeDefined()
  expect(emitted.namespaceSelector).toBeDefined()
})

test('NpPeerEditor: 取消勾 podSelector(默认段) → delete podSelector', async () => {
  const wrapper = mountWith({ modelValue: emptyPeer() })
  await wrapper.find('input[data-test="has-pod"]').setValue(false)
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.podSelector).toBeUndefined()
})

test('NpPeerEditor: 已有 ipBlock 的 modelValue 回显 cidr/except', () => {
  const wrapper = mountWith({
    modelValue: { ipBlock: { cidr: '172.16.0.0/12', except: ['172.16.1.0/24'] } },
  })
  expect(wrapper.find('input[data-test="has-ip"]').element.checked).toBe(true)
  expect(wrapper.find('input[data-test="cidr"]').element.value).toBe('172.16.0.0/12')
  expect(wrapper.find('input[data-test="except"]').element.value).toBe('172.16.1.0/24')
})
