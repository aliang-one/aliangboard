import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NpSelectorEditor from '@/components/networkpolicy/NpSelectorEditor.vue'
import { i18n } from '@/i18n'

// 组件用 useI18n（i18n:check 禁止 src/** 内 CJK），必须挂 i18n 插件。
const mountWith = (props) => mount(NpSelectorEditor, {
  props,
  global: { plugins: [i18n] },
})

test('NpSelectorEditor: initial modelValue empty → no label rows', () => {
  const wrapper = mountWith({ modelValue: { matchLabels: {}, matchExpressions: [] } })
  expect(wrapper.findAll('input[data-test="lbl-key"]')).toHaveLength(0)
  expect(wrapper.findAll('input[data-test="expr-key"]')).toHaveLength(0)
})

test('NpSelectorEditor: add a label → emit contains matchLabels', async () => {
  const wrapper = mountWith({ modelValue: { matchLabels: {}, matchExpressions: [] } })
  await wrapper.find('button[data-test="add-label"]').trigger('click')
  await wrapper.find('input[data-test="lbl-key"]').setValue('app')
  await wrapper.find('input[data-test="lbl-val"]').setValue('web')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.matchLabels).toEqual({ app: 'web' })
  expect(emitted.matchExpressions).toEqual([])
})

test('NpSelectorEditor: add a label with empty key → not emitted', async () => {
  const wrapper = mountWith({ modelValue: { matchLabels: {}, matchExpressions: [] } })
  await wrapper.find('button[data-test="add-label"]').trigger('click')
  await wrapper.find('input[data-test="lbl-val"]').setValue('web')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.matchLabels).toEqual({})
})

test('NpSelectorEditor: add a matchExpression → emit contains matchExpressions', async () => {
  const wrapper = mountWith({ modelValue: { matchLabels: {}, matchExpressions: [] } })
  await wrapper.find('button[data-test="add-expr"]').trigger('click')
  await wrapper.find('input[data-test="expr-key"]').setValue('env')
  await wrapper.find('select[data-test="expr-op"]').setValue('In')
  await wrapper.find('input[data-test="expr-values"]').setValue('prod, staging')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.matchExpressions).toEqual([{ key: 'env', operator: 'In', values: ['prod', 'staging'] }])
  expect(emitted.matchLabels).toEqual({})
})

test('NpSelectorEditor: Exists operator → empty values', async () => {
  const wrapper = mountWith({ modelValue: { matchLabels: {}, matchExpressions: [] } })
  await wrapper.find('button[data-test="add-expr"]').trigger('click')
  await wrapper.find('input[data-test="expr-key"]').setValue('role')
  await wrapper.find('select[data-test="expr-op"]').setValue('Exists')
  const emitted = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(emitted.matchExpressions).toEqual([{ key: 'role', operator: 'Exists', values: [] }])
})

test('NpSelectorEditor: remove label → emits updated', async () => {
  const wrapper = mountWith({ modelValue: { matchLabels: {}, matchExpressions: [] } })
  await wrapper.find('button[data-test="add-label"]').trigger('click')
  await wrapper.find('button[data-test="add-label"]').trigger('click')
  await wrapper.findAll('input[data-test="lbl-key"]')[0].setValue('a')
  await wrapper.findAll('input[data-test="lbl-key"]')[1].setValue('b')
  const before = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(Object.keys(before.matchLabels)).toEqual(['a', 'b'])
  // 第一行的 remove 按钮
  await wrapper.findAll('button')[0].trigger('click')
  const after = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(after.matchLabels).toEqual({ b: '' })
})

test('NpSelectorEditor: syncFromProps hydrates existing modelValue', () => {
  const wrapper = mountWith({
    modelValue: {
      matchLabels: { app: 'web', tier: 'api' },
      matchExpressions: [{ key: 'env', operator: 'In', values: ['prod'] }],
    },
  })
  expect(wrapper.findAll('input[data-test="lbl-key"]')).toHaveLength(2)
  expect(wrapper.findAll('input[data-test="expr-key"]')).toHaveLength(1)
  // 默认 operator In
  expect(wrapper.find('select[data-test="expr-op"]').element.value).toBe('In')
})

test('NpSelectorEditor: emit round-trips through props (re-mount)', async () => {
  // 第一阶段:输入 → emit
  const w1 = mountWith({ modelValue: { matchLabels: {}, matchExpressions: [] } })
  await w1.find('button[data-test="add-label"]').trigger('click')
  await w1.find('input[data-test="lbl-key"]').setValue('app')
  await w1.find('input[data-test="lbl-val"]').setValue('web')
  const emitted = w1.emitted('update:modelValue').at(-1)[0]
  // 第二阶段:用 emit 的值重新挂载(模拟父组件回写),应回显正确
  const w2 = mountWith({ modelValue: emitted })
  expect(w2.find('input[data-test="lbl-key"]').element.value).toBe('app')
  expect(w2.find('input[data-test="lbl-val"]').element.value).toBe('web')
})
