import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
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

// ---- 回声(echo)回归锁 ----
// 背景:emitUp 过滤空 key 行后 emit → v-model 父回写 → watch(deep) 的 syncFromProps
// 把【自己的回声】当外部变化整体重建行数组——键入中被过滤的行当场蒸发:
// 清空 key 的行(含 value)被删无法重输、addLabel 新增的空行在编辑其它行时消失。
// 修复 = 回声守卫(自己刚 emit 的对象回流不算外部变化)。

// 复刻 NetworkPolicyEditor.vue:101 的 v-model 消费形态
function mountTwoWay(initial = { matchLabels: {}, matchExpressions: [] }) {
  const Host = defineComponent({
    components: { NpSelectorEditor },
    setup: () => ({ sel: ref(JSON.parse(JSON.stringify(initial))) }),
    template: '<NpSelectorEditor v-model="sel" />',
  })
  const wrapper = mount(Host, { global: { plugins: [i18n] } })
  return { wrapper, getSel: () => wrapper.vm.sel }
}

test('NpSelectorEditor: v-model 接线清空 key 行不消失(可清空重输,value 草稿保留)', async () => {
  const { wrapper, getSel } = mountTwoWay()
  await wrapper.find('button[data-test="add-label"]').trigger('click')
  await wrapper.find('input[data-test="lbl-key"]').setValue('app')
  await wrapper.find('input[data-test="lbl-val"]').setValue('web')
  // 清空 key:emitUp 过滤该行 → 回声重建 —— 行不得消失
  await wrapper.find('input[data-test="lbl-key"]').setValue('')
  expect(wrapper.findAll('input[data-test="lbl-key"]')).toHaveLength(1) // 修复前:行被回声删除
  expect(wrapper.find('input[data-test="lbl-val"]').element.value).toBe('web')
  // 重新输入 key → 正常上报(经 Host 的 v-model 回写断言)
  await wrapper.find('input[data-test="lbl-key"]').setValue('tier')
  expect(getSel().matchLabels).toEqual({ tier: 'web' })
})

test('NpSelectorEditor: v-model 接线新增空行在编辑其它行时不被回声删除', async () => {
  const { wrapper, getSel } = mountTwoWay()
  await wrapper.find('button[data-test="add-label"]').trigger('click')
  await wrapper.find('button[data-test="add-label"]').trigger('click')
  await wrapper.findAll('input[data-test="lbl-key"]')[0].setValue('a')
  // 修复前:emit {a:''} 回声重建行数组,第二个空行消失
  expect(wrapper.findAll('input[data-test="lbl-key"]')).toHaveLength(2)
  // 空行先填 value(后填 key)不得蒸发
  await wrapper.findAll('input[data-test="lbl-val"]')[1].setValue('x')
  expect(wrapper.findAll('input[data-test="lbl-key"]')).toHaveLength(2)
  // 空 key 行不上报的契约不变(父收到的 matchLabels 只有非空 key 行)
  expect(getSel().matchLabels).toEqual({ a: '' })
})

test('NpSelectorEditor: 外部真实变化(非回声)仍同步重建行', async () => {
  const wrapper = mountWith({ modelValue: { matchLabels: { a: '1' }, matchExpressions: [] } })
  await wrapper.setProps({ modelValue: { matchLabels: { b: '2' }, matchExpressions: [] } })
  expect(wrapper.findAll('input[data-test="lbl-key"]')).toHaveLength(1)
  expect(wrapper.find('input[data-test="lbl-key"]').element.value).toBe('b')
  expect(wrapper.find('input[data-test="lbl-val"]').element.value).toBe('2')
})
