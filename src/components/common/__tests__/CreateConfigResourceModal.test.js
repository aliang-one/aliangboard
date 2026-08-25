import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const addConfigMap = vi.fn(async () => ({ ok: true }))
const addSecret = vi.fn(async () => ({ ok: true }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    addConfigMap,
    addSecret,
    generateYAML: vi.fn(() => ''),
    applyResourceYaml: vi.fn(async () => ({ ok: true })),
  }),
}))

import CreateConfigResourceModal from '@/components/common/CreateConfigResourceModal.vue'

const ModalStub = {
  props: ['modelValue', 'title', 'width'],
  emits: ['update:modelValue'],
  template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>',
}

// DataKeysEditor/KeyValueRowsEditor 受控组件：stub 后 emit 须触发父级状态更新并回灌
// modelValue（ns-allowlist-dropdown 教训）——stub 直接回显 props 触发模板渲染。
const DataKeysStub = {
  name: 'DataKeysEditor',
  props: ['modelValue', 'secret', 'fixedFields'],
  emits: ['update:modelValue'],
  template: '<div data-testid="ccm-datakeys-stub">{{ JSON.stringify(modelValue) }}</div>',
}
const KvRowsStub = {
  name: 'KeyValueRowsEditor',
  props: ['modelValue', 'keyPlaceholder', 'valuePlaceholder', 'multiline'],
  emits: ['update:modelValue'],
  template: '<div data-testid="ccm-kv-stub" />',
}

function mountModal(kind, props = {}) {
  return mount(CreateConfigResourceModal, {
    props: { modelValue: true, kind, namespace: 'default', ...props },
    global: {
      plugins: [i18n],
      stubs: { Modal: ModalStub, DataKeysEditor: DataKeysStub, KeyValueRowsEditor: KvRowsStub },
    },
  })
}

beforeEach(() => {
  addConfigMap.mockClear()
  addSecret.mockClear()
  addConfigMap.mockResolvedValue({ ok: true })
  addSecret.mockResolvedValue({ ok: true })
})

test('configmap: name+数据键+labels → addConfigMap 收到完整 payload,emit created + 关弹窗', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('cm1')
  // 默认 secret Opaque/configmap 自由键模式：经 DataKeysEditor stub emit 有效键
  await w.findComponent({ name: 'DataKeysEditor' }).vm.$emit('update:modelValue', [
    { key: 'app.conf', value: 'A=1' },
  ])
  // 切到 labels tab,注入 labels 行
  await w.find('[data-testid="ccm-tab-labels"]').trigger('click')
  const kv = w.findAllComponents({ name: 'KeyValueRowsEditor' })[0]
  await kv.vm.$emit('update:modelValue', [{ key: 'tier', value: 'web' }])
  await w.find('[data-testid="ccm-create"]').trigger('click')
  await Promise.resolve()
  expect(addConfigMap).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'cm1',
      namespace: 'default',
      keys: 1,
      data: { 'app.conf': 'A=1' },
      labels: { tier: 'web' },
    }),
  )
  expect(w.emitted('created')).toBeTruthy()
  expect(w.emitted('update:modelValue')).toEqual([[false]])
})

test('secret tls: 固定字段完整 → addSecret 收到 type+data 组装', async () => {
  const w = mountModal('secret')
  await w.find('[data-testid="ccm-name"]').setValue('s1')
  await w.find('[data-testid="ccm-type"]').setValue('kubernetes.io/tls')
  // 切固定类型 → freeKeys 重置为该类型 fields 初始化；stub emit 固定字段值
  await w.findComponent({ name: 'DataKeysEditor' }).vm.$emit('update:modelValue', [
    { key: 'tls.crt', value: 'C' },
    { key: 'tls.key', value: 'K' },
  ])
  await w.find('[data-testid="ccm-create"]').trigger('click')
  await Promise.resolve()
  expect(addSecret).toHaveBeenCalledWith(
    expect.objectContaining({ name: 's1', type: 'kubernetes.io/tls', data: { 'tls.crt': 'C', 'tls.key': 'K' } }),
  )
  expect(w.emitted('created')).toBeTruthy()
})

test('name 非法/必填缺失 → 创建按钮禁用', async () => {
  const w = mountModal('configmap')
  // 无 name 无键
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
  await w.find('[data-testid="ccm-name"]').setValue('Bad_Name')
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
  // 合法 name 但无有效键也禁用
  await w.find('[data-testid="ccm-name"]').setValue('good-name')
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
  await w.findComponent({ name: 'DataKeysEditor' }).vm.$emit('update:modelValue', [{ key: 'k', value: 'v' }])
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeUndefined()
})

test('addConfigMap 返回 {ok:false} → 不 emit created、Modal 不关', async () => {
  addConfigMap.mockResolvedValueOnce({ ok: false })
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('cm2')
  await w.findComponent({ name: 'DataKeysEditor' }).vm.$emit('update:modelValue', [{ key: 'k', value: 'v' }])
  await w.find('[data-testid="ccm-create"]').trigger('click')
  await Promise.resolve()
  await Promise.resolve()
  expect(w.emitted('created')).toBeFalsy()
  expect(w.emitted('update:modelValue')).toBeFalsy()
})

test('空 key 行不进 payload；重复 meta key 禁用创建', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('cm3')
  await w
    .findComponent({ name: 'DataKeysEditor' })
    .vm.$emit('update:modelValue', [{ key: 'a', value: '1' }, { key: '', value: 'junk' }])
  await w.find('[data-testid="ccm-create"]').trigger('click')
  await Promise.resolve()
  expect(addConfigMap).toHaveBeenCalledWith(expect.objectContaining({ keys: 1, data: { a: '1' } }))
  // 重复 labels key → 禁用
  const w2 = mountModal('configmap')
  await w2.find('[data-testid="ccm-name"]').setValue('cm4')
  await w2.findComponent({ name: 'DataKeysEditor' }).vm.$emit('update:modelValue', [{ key: 'a', value: '1' }])
  await w2.find('[data-testid="ccm-tab-labels"]').trigger('click')
  await w2
    .findAllComponents({ name: 'KeyValueRowsEditor' })[0]
    .vm.$emit('update:modelValue', [{ key: 'x', value: '1' }, { key: 'x', value: '2' }])
  expect(w2.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
})

test('关闭后重开 → freeKeys 重置为单空行（无跨会话键值残留）', async () => {
  // configmap 场景：无 secretTypeId 切换路径,重开是唯一重置入口
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('cm5')
  await w.findComponent({ name: 'DataKeysEditor' }).vm.$emit('update:modelValue', [{ key: 'old', value: 'X' }])
  expect(w.findComponent({ name: 'DataKeysEditor' }).props('modelValue')).toEqual([{ key: 'old', value: 'X' }])
  // 关闭 → 重开
  await w.find('[data-testid="ccm-cancel"]').trigger('click')
  // 父级应用 emit 后 prop 真正关闭再重开
  await w.setProps({ modelValue: false })
  await w.setProps({ modelValue: true })
  expect(w.findComponent({ name: 'DataKeysEditor' }).props('modelValue')).toEqual([{ key: '', value: '' }])
  // 重开后旧键不残留 → 无有效键,创建禁用
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
})

test('secret Opaque 重开 → freeKeys 重置为单空行', async () => {
  const w = mountModal('secret')
  await w.findComponent({ name: 'DataKeysEditor' }).vm.$emit('update:modelValue', [{ key: 'old', value: 'X' }])
  await w.find('[data-testid="ccm-cancel"]').trigger('click')
  await w.setProps({ modelValue: false })
  await w.setProps({ modelValue: true })
  // secretTypeId 同为 'Opaque'，同值赋值不触发 watch(secretTypeId)，须靠 resetTypeData
  expect(w.findComponent({ name: 'DataKeysEditor' }).props('modelValue')).toEqual([{ key: '', value: '' }])
})

test('secret 类型切换重置 freeKeys；yaml tab 按钮禁用', async () => {
  const w = mountModal('secret')
  // yaml 占位 tab 禁用
  const yamlBtn = w.find('[data-testid="ccm-tab-yaml"]')
  expect(yamlBtn.attributes('disabled')).toBeDefined()
  // Opaque 自由键 → 切 tls → stub 收到 fixedFields 且 modelValue 重置为 fields 初始化
  await w.find('[data-testid="ccm-type"]').setValue('kubernetes.io/tls')
  const dk = w.findComponent({ name: 'DataKeysEditor' })
  expect(dk.props('fixedFields')).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: 'tls.crt' })]),
  )
  expect(dk.props('modelValue')).toEqual([{ key: 'tls.crt', value: '' }, { key: 'tls.key', value: '' }])
  // 切回 Opaque → 重置为单空行
  await w.find('[data-testid="ccm-type"]').setValue('Opaque')
  expect(w.findComponent({ name: 'DataKeysEditor' }).props('modelValue')).toEqual([{ key: '', value: '' }])
})
