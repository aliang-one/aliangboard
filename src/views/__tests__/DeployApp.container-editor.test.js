// 「完整编辑」入口接线:图标打开弹窗拿到正确容器/查重集合;确认写回同索引槽位
// (数组身份不变 → 卷挂载 target 稳定);关闭丢弃。emit 级驱动(Modal 已 stub,UI 细节
// 由 ContainerEditorDialog.test.js 覆盖)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', fetchIngressClasses: vi.fn(async () => []), fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []), fetchPriorityClasses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []), setNamespace: () => {} }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployApp from '../DeployApp.vue'
import ContainerEditorDialog from '@/components/common/ContainerEditorDialog.vue'
import { makeSubContainer } from '@/logic/subContainer'

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

const C = image => ({ name: '', image, command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

test('init 卡片有最大化图标;点击 → 弹窗拿到该容器与查重集合(主名+其他显式名,不含自身)', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 1, form: { ...w.vm.form, name: 'app', initContainers: [{ ...C('busybox'), name: 'i0' }, C('initx')], extraContainers: [{ ...C('nginx'), name: 's0' }] } })
  await flushPromises()
  const btns = w.findAll('[data-testid="init-expand-btn"]')
  expect(btns.length).toBe(2)
  await btns[1].trigger('click')                       // 编辑第二个 init(initx,无显式名)
  const dlg = w.findComponent(ContainerEditorDialog)
  expect(dlg.props('kind')).toBe('init')
  expect(dlg.props('index')).toBe(1)
  expect(dlg.props('container')).toMatchObject({ image: 'initx' })
  expect(dlg.props('otherNames')).toEqual(['app', 'i0', 's0'])   // 主容器有效名 + 其余显式名
})

test('确认 → Object.assign 写回同索引槽位;数组槽位身份不变(卷挂载 target 稳定)', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 1, form: { ...w.vm.form, name: 'app', initContainers: [C('busybox')] } })
  await flushPromises()
  const slot0 = w.vm.form.initContainers[0]
  await w.findAll('[data-testid="init-expand-btn"]')[0].trigger('click')
  const dlg = w.findComponent(ContainerEditorDialog)
  dlg.vm.$emit('confirm', { ...C('busybox'), name: 'my-init', command: 'sh -c "ls"' })
  await flushPromises()
  expect(w.vm.form.initContainers[0].name).toBe('my-init')
  expect(w.vm.form.initContainers[0].command).toBe('sh -c "ls"')
  expect(w.vm.form.initContainers[0]).toBe(slot0)      // 身份未变
  expect(w.findComponent(ContainerEditorDialog).exists()).toBe(false)   // 确认后关闭
})

test('sidecar 图标同样接线;ESC/取消(editing 置空)后不再写回', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 1, form: { ...w.vm.form, name: 'app', extraContainers: [C('nginx')] } })
  await flushPromises()
  await w.findAll('[data-testid="sidecar-expand-btn"]')[0].trigger('click')
  const dlg = w.findComponent(ContainerEditorDialog)
  expect(dlg.props('kind')).toBe('sidecar')
  dlg.vm.$emit('update:modelValue', false)             // 取消/ESC/遮罩路径
  await flushPromises()
  expect(w.vm.form.extraContainers[0].name).toBe('')   // 未写回
  expect(w.findComponent(ContainerEditorDialog).exists()).toBe(false)
})

test('卡片高级 badge:高级字段有值才显示且计数正确;点 badge 开弹窗', async () => {
  const w = mountApp()
  await flushPromises()
  // currentStep 是根级状态(容器 grid 在步骤 2 v-if 渲染),与 form 平级传
  await w.setData({ currentStep: 1, form: { ...w.vm.form, name: 'app',
    initContainers: [{ ...makeSubContainer(), name: 'i0', image: 'busybox', envVars: [{ key: 'K', value: 'V' }], tty: true }] } })
  await flushPromises()
  const badge = w.find('[data-testid="ced-advanced-badge"]')
  expect(badge.exists()).toBe(true)
  expect(badge.text()).toContain('2')
  await badge.trigger('click')
  expect(w.findComponent(ContainerEditorDialog).props('container')).toMatchObject({ name: 'i0' })
  expect(w.findComponent(ContainerEditorDialog).props('namespace')).toBe(w.vm.form.namespace)
})

test('validate:4 基础字段空但 env 有值的行不再被当空行跳过', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 1, form: { ...w.vm.form, name: 'app', image: 'nginx',
    initContainers: [{ ...makeSubContainer(), envVars: [{ key: '', value: 'v' }] }] } })
  await flushPromises()
  const errs = w.vm.validate()
  expect(errs.some(e => e.step === 1 && e.msg.includes(i18n.global.t('deploy.containerFv.envMissingKey')))).toBe(true)
  // 全默认行仍是空行,不报子容器错误
  await w.setData({ form: { ...w.vm.form, initContainers: [makeSubContainer()] } })
  await flushPromises()
  expect(w.vm.validate().filter(e => e.step === 1 && e.msg.includes(i18n.global.t('deploy.initContainers')))).toEqual([])
})
