import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'

// vi.mock 工厂被提升,具名引用须用 vi.hoisted 提到顶部
const fns = vi.hoisted(() => {
  const generateYAML = vi.fn((type, r) => {
    const kind = type === 'configmap' ? 'ConfigMap' : 'Secret'
    return `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${r.name}\n  namespace: ${r.namespace}\ndata: ${JSON.stringify(r.data)}`
  })
  return {
    addConfigMap: vi.fn(async () => ({ ok: true })),
    addSecret: vi.fn(async () => ({ ok: true })),
    applyResourceYaml: vi.fn(async () => ({ ok: true })),
    generateYAML,
  }
})
const { addConfigMap, addSecret, applyResourceYaml, generateYAML } = fns
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => fns,
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
  applyResourceYaml.mockClear()
  generateYAML.mockClear()
  addConfigMap.mockResolvedValue({ ok: true })
  addSecret.mockResolvedValue({ ok: true })
  applyResourceYaml.mockResolvedValue({ ok: true })
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

test('数据键重复 → 创建禁用 + ccm-datakeys-error 出现;修正后恢复可提交', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('dup-key')
  await w
    .findComponent({ name: 'DataKeysEditor' })
    .vm.$emit('update:modelValue', [{ key: 'a', value: '1' }, { key: 'a', value: '2' }])
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="ccm-datakeys-error"]').exists()).toBe(true)
  expect(w.find('[data-testid="ccm-datakeys-error"]').text()).toContain('键重复')
  // 修正重复后恢复可提交
  await w
    .findComponent({ name: 'DataKeysEditor' })
    .vm.$emit('update:modelValue', [{ key: 'a', value: '1' }, { key: 'b', value: '2' }])
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeUndefined()
  expect(w.find('[data-testid="ccm-datakeys-error"]').exists()).toBe(false)
})

test('数据键非法(含空格) → 创建禁用 + 错误行出现;修正后恢复可提交', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('bad-key')
  await w
    .findComponent({ name: 'DataKeysEditor' })
    .vm.$emit('update:modelValue', [{ key: 'a b', value: '1' }])
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="ccm-datakeys-error"]').exists()).toBe(true)
  expect(w.find('[data-testid="ccm-datakeys-error"]').text()).toContain('数据键名只能包含字母数字与 - . _')
  // 修正非法键后恢复可提交
  await w.findComponent({ name: 'DataKeysEditor' }).vm.$emit('update:modelValue', [{ key: 'a-b', value: '1' }])
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeUndefined()
  expect(w.find('[data-testid="ccm-datakeys-error"]').exists()).toBe(false)
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

test('secret 类型切换重置 freeKeys', async () => {
  const w = mountModal('secret')
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

test('YAML tab 预览:派生自 payload(含 labels)', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-name"]').setValue('cm3')
  await w.find('[data-testid="ccm-tab-yaml"]').trigger('click')
  const pre = w.find('[data-testid="ccm-yaml-preview"]')
  expect(pre.text()).toContain('kind: ConfigMap')
  expect(pre.text()).toContain('name: cm3')
})

test('切换纯 YAML 编辑:填合法 ConfigMap YAML → applyResourceYaml 提交', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-tab-yaml"]').trigger('click')
  await w.find('[data-testid="ccm-yaml-switch"]').trigger('click')
  await w.find('[data-testid="ccm-yaml-input"]').setValue('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: y1\n  namespace: default\ndata:\n  k: v')
  await w.find('[data-testid="ccm-create"]').trigger('click')
  expect(applyResourceYaml).toHaveBeenCalled()
  expect(addConfigMap).not.toHaveBeenCalled()
})

test('纯 YAML kind 不对 → 创建禁用 + 错误提示', async () => {
  const w = mountModal('configmap')
  await w.find('[data-testid="ccm-tab-yaml"]').trigger('click')
  await w.find('[data-testid="ccm-yaml-switch"]').trigger('click')
  await w.find('[data-testid="ccm-yaml-input"]').setValue('apiVersion: v1\nkind: Service\nmetadata:\n  name: s\n  namespace: default')
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="ccm-yaml-error"]').exists()).toBe(true)
})

// ---- 「从 YAML 开始」直达入口(2026-08-28:粘贴创建升一等入口,同一 Modal 同一路径)----

test('startInYaml: 打开即 YAML 编辑模式,预填 ConfigMap 模板且可直接提交', () => {
  const w = mountModal('configmap', { startInYaml: true })
  const input = w.find('[data-testid="ccm-yaml-input"]')
  expect(input.exists()).toBe(true)
  expect(input.element.value).toContain('kind: ConfigMap')
  expect(input.element.value).toContain('name: my-configmap')
  expect(input.element.value).toContain('namespace: default')
  // 编辑模式:预览节点不在;模板 kind 匹配 → 创建可直接点(一等入口)
  expect(w.find('[data-testid="ccm-yaml-preview"]').exists()).toBe(false)
  expect(w.find('[data-testid="ccm-create"]').attributes('disabled')).toBeUndefined()
})

test('startInYaml: secret 模板用 stringData(粘贴免 base64)', () => {
  const w = mountModal('secret', { startInYaml: true })
  const input = w.find('[data-testid="ccm-yaml-input"]')
  expect(input.exists()).toBe(true)
  expect(input.element.value).toContain('kind: Secret')
  expect(input.element.value).toContain('stringData')
})

test('无 startInYaml: 默认数据 tab(现状);startInYaml 开→关重开后回数据 tab(重置契约)', async () => {
  const w = mountModal('configmap')
  expect(w.find('[data-testid="ccm-yaml-input"]').exists()).toBe(false)
  expect(w.find('[data-testid="ccm-yaml-preview"]').exists()).toBe(false)
  const w2 = mountModal('configmap', { startInYaml: true })
  expect(w2.find('[data-testid="ccm-yaml-input"]').exists()).toBe(true)
  await w2.find('[data-testid="ccm-cancel"]').trigger('click')
  await w2.setProps({ modelValue: false })
  await w2.setProps({ modelValue: true, startInYaml: false })
  expect(w2.find('[data-testid="ccm-yaml-input"]').exists()).toBe(false)
})

// ===== 最大化:YAML 编辑区撑满(2026-08-29 设计)——真实挂 Modal(不 stub)走 Teleport DOM =====
test('最大化后 tab 容器与 YAML textarea 切撑满形态;还原回普通态', async () => {
  const w = mount(CreateConfigResourceModal, {
    props: { modelValue: true, kind: 'configmap', namespace: 'default' },
    global: { plugins: [i18n], stubs: { DataKeysEditor: DataKeysStub, KeyValueRowsEditor: KvRowsStub } },
  })
  // 等待 Teleport 完成
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  // 进 YAML 编辑态(「从 YAML 开始」之外的常规路径:tab → 切编辑)
  // Modal 内容被 Teleport 到 body,需用 DOM API 直查
  const tabBtn = document.querySelector('[data-testid="ccm-tab-yaml"]')
  expect(tabBtn).toBeTruthy()
  tabBtn.click()
  await nextTick()
  const switchBtn = document.querySelector('[data-testid="ccm-yaml-switch"]')
  expect(switchBtn).toBeTruthy()
  switchBtn.click()
  await nextTick()
  const tabWrap = () => document.querySelector('[data-testid="ccm-panel-yaml"]').parentElement
  const ta = () => document.querySelector('[data-testid="ccm-yaml-input"]')
  // 普通态基线
  expect(tabWrap().className).toContain('max-h-[55vh]')
  expect(ta().getAttribute('rows')).toBe('14')
  expect(ta().classList.contains('flex-1')).toBe(false)
  // 最大化
  const maxBtn = document.querySelector('[data-testid="modal-maximize-btn"]')
  expect(maxBtn).toBeTruthy()
  maxBtn.click()
  await nextTick()
  expect(tabWrap().className).toContain('min-h-0')
  expect(ta().classList.contains('flex-1')).toBe(true)
  // YAML 面板根在最大化时用 h-full（父级 block 滚动容器下 flex-1 无效）
  const yamlPanel = document.querySelector('[data-testid="ccm-panel-yaml"]')
  expect(yamlPanel.classList.contains('h-full')).toBe(true)
  // 还原
  const restoreBtn = document.querySelector('[data-testid="modal-restore-btn"]')
  expect(restoreBtn).toBeTruthy()
  restoreBtn.click()
  await nextTick()
  expect(tabWrap().className).toContain('max-h-[55vh]')
  expect(ta().classList.contains('flex-1')).toBe(false)
  w.unmount()
  document.body.innerHTML = ''
})
