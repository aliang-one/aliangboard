import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const { applyYamlMock } = vi.hoisted(() => ({ applyYamlMock: vi.fn() }))
// 组件挂载即触发 useResourceApply()→useClusterStore()→activeApiServer()→localStorage,
// mock 掉 composable 以隔离副作用;applyYamlMock 供透传断言。
vi.mock('@/composables/useResourceApply', () => ({
  useResourceApply: () => ({ applyYaml: applyYamlMock }),
}))

import CreateFromYamlDialog from '@/components/common/CreateFromYamlDialog.vue'

test('CreateFromYamlDialog: 挂载并渲染标题 + YamlEditor', () => {
  const wrapper = mount(CreateFromYamlDialog, {
    props: { modelValue: true, namespace: 'default' },
    global: { plugins: [createPinia(), i18n] },
  })
  // Modal teleport 到 body,wrapper.text() 可能不含标题;统一查 document.body。
  expect(document.body.textContent).toContain(i18n.global.t('component.createFromYaml.title'))
  // YamlEditor 存在(modelValue 已被 immediate watch 填充为模板,非空,含 my-app)
  expect(document.body.textContent).toContain('my-app')
  wrapper.unmount()
})

test('kind prop 注入对应模板', () => {
  const w = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'Service' }, global: { plugins: [createPinia(), i18n] } })
  expect(document.body.textContent).toContain('my-service')
  w.unmount()
})

test('nsHint:namespaced kind + 有 ns → 显示(与改写后 hint 同窗并存);集群级 kind / 无 ns → 隐藏', () => {
  const shown = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'Service' }, global: { plugins: [createPinia(), i18n] } })
  expect(document.body.textContent).toContain(i18n.global.t('component.createFromYaml.nsHint', { ns: 'demo' }))
  expect(document.body.textContent).toContain(i18n.global.t('component.createFromYaml.hint'))
  shown.unmount()
  const clusterKind = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'ClusterRole' }, global: { plugins: [createPinia(), i18n] } })
  expect(document.body.textContent).not.toContain(i18n.global.t('component.createFromYaml.nsHint', { ns: 'demo' }))
  clusterKind.unmount()
  const noNs = mount(CreateFromYamlDialog, { props: { modelValue: true, kind: 'Deployment' }, global: { plugins: [createPinia(), i18n] } })
  expect(document.body.textContent).not.toContain(i18n.global.t('component.createFromYaml.nsHint', { ns: 'demo' }))
  noNs.unmount()
})

test('create():defaultNs 透传第二参;namespace 为空则不传', async () => {
  applyYamlMock.mockResolvedValue({ ok: true, kind: 'Service', name: 'my-service' })
  const w = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'Service' }, global: { plugins: [createPinia(), i18n] } })
  await w.vm.create()
  expect(applyYamlMock).toHaveBeenCalledTimes(1)
  expect(applyYamlMock.mock.calls[0][1]).toEqual({ defaultNs: 'demo' })
  w.unmount()
  applyYamlMock.mockClear()
  const w2 = mount(CreateFromYamlDialog, { props: { modelValue: true, kind: 'Deployment' }, global: { plugins: [createPinia(), i18n] } })
  await w2.vm.create()
  expect(applyYamlMock.mock.calls[0][1]).toBeUndefined()
  w2.unmount()
})

test('parse 失败分支:无效 YAML → 内联报错,不调 applyYaml', async () => {
  applyYamlMock.mockClear()
  const w = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'Service' }, global: { plugins: [createPinia(), i18n] } })
  await w.setData({ yaml: 'key: [unclosed-flow' })
  await w.vm.create()
  expect(document.body.textContent).toContain(i18n.global.t('component.createFromYaml.parseError'))
  expect(applyYamlMock).not.toHaveBeenCalled()
  w.unmount()
})
