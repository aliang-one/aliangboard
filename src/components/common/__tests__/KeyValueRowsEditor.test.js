import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import KeyValueRowsEditor from '@/components/common/KeyValueRowsEditor.vue'

// 纯受控组件：用 harness 父组件实现 v-model 回灌（否则交互后新行不会渲染，见 ns-allowlist-dropdown 教训）
function mountRows(props = {}) {
  const initial = props.modelValue || []
  delete props.modelValue
  const Harness = {
    components: { KeyValueRowsEditor },
    data: () => ({ rows: initial, props }),
    template: `<KeyValueRowsEditor v-model="rows" v-bind="props" />`,
  }
  const w = mount(Harness, { global: { plugins: [i18n] } })
  w.editor = () => w.findComponent(KeyValueRowsEditor)
  w.emitted = (...a) => w.editor().emitted(...a)
  return w
}

test('添加行并输入 → v-model 同步', async () => {
  const w = mountRows()
  await w.find('[data-testid="kv-add"]').trigger('click')
  await w.findAll('input')[0].setValue('app')
  await w.findAll('input')[1].setValue('web')
  expect(w.vm.rows).toEqual([{ key: 'app', value: 'web' }])
})

test('删除行 → 同步移除；初始行渲染', async () => {
  const w = mountRows({ modelValue: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }] })
  expect(w.findAll('[data-testid="kv-row"]')).toHaveLength(2)
  await w.findAll('[data-testid="kv-del"]')[0].trigger('click')
  expect(w.emitted('update:modelValue')[0][0]).toEqual([{ key: 'b', value: '2' }])
})

test('重复 key 标红(data-dup)；两行都标', async () => {
  const w = mountRows({ modelValue: [{ key: 'x', value: '1' }] })
  await w.find('[data-testid="kv-add"]').trigger('click')
  await w.findAll('input')[2].setValue('x')
  const rows = w.findAll('[data-testid="kv-row"]')
  expect(rows[1].attributes('data-dup')).toBe('true')
  expect(rows[0].attributes('data-dup')).toBe('true')
})

test('空 key 行不标 dup 也不标非法；空行不参与 dup 判定', async () => {
  const w = mountRows({ modelValue: [{ key: 'x', value: '1' }, { key: '', value: '' }, { key: '', value: '' }] })
  const rows = w.findAll('[data-testid="kv-row"]')
  expect(rows[0].attributes('data-dup')).toBeUndefined()
  expect(rows[1].attributes('data-invalid')).toBeUndefined()
  expect(rows[2].attributes('data-dup')).toBeUndefined()
})

test('非法 key 标红(data-invalid)：前缀段非法 / 名字段非法 / 无斜杠含非法字符', async () => {
  const w = mountRows({ modelValue: [
    { key: 'A.b/name', value: '1' },   // 前缀段含大写 → 非法
    { key: 'example.com/bad key', value: '2' }, // 名字段含空格 → 非法
    { key: 'not valid key', value: '3' }, // 无斜杠但含空格 → 非法
  ] })
  const rows = w.findAll('[data-testid="kv-row"]')
  expect(rows[0].attributes('data-invalid')).toBe('true')
  expect(rows[1].attributes('data-invalid')).toBe('true')
  expect(rows[2].attributes('data-invalid')).toBe('true')
})

test('合法 key 不标错：带合格前缀/无前缀', async () => {
  const w = mountRows({ modelValue: [
    { key: 'example.com/app', value: '1' },
    { key: 'kubernetes.io/path', value: '2' },
    { key: 'app', value: '3' },
    { key: 'app.kubernetes.io/name', value: '4' },
  ] })
  const rows = w.findAll('[data-testid="kv-row"]')
  rows.forEach(r => {
    expect(r.attributes('data-invalid')).toBeUndefined()
    expect(r.attributes('data-dup')).toBeUndefined()
  })
})

test('multiline=true 时 value 用 textarea；placeholder 透传', async () => {
  const w = mountRows({ modelValue: [{ key: 'a', value: '1' }], multiline: true, keyPlaceholder: 'K', valuePlaceholder: 'V' })
  expect(w.find('textarea').exists()).toBe(true)
  expect(w.find('[data-testid="kv-key"]').attributes('placeholder')).toBe('K')
  expect(w.find('[data-testid="kv-value"]').attributes('placeholder')).toBe('V')
})

test('props 不被原地修改', async () => {
  const rows = [{ key: 'a', value: '1' }]
  const w = mountRows({ modelValue: rows })
  await w.find('[data-testid="kv-add"]').trigger('click')
  await w.findAll('input')[2].setValue('b')
  expect(rows).toEqual([{ key: 'a', value: '1' }])
  expect(w.emitted('update:modelValue').at(-1)[0]).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '' }])
})
