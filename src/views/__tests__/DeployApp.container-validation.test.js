// 提交校验接入单源 containerValidation:覆盖原地小卡片编辑路径(弹窗路径同函数)。
// 消息形态:「<init/sidecar 标签> <名|#序号>: <字段错误>」,step=1(现有跳步逻辑不变)。
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

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

const C = () => ({ name: '', image: 'nginx', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

async function validateWith(extraForm) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', image: 'nginx', ...extraForm } })
  await flushPromises()
  return w.vm.validate().filter(e => e.step === 1)
}

const initLabel = () => i18n.global.t('deploy.initContainers')

test('空行容器整体跳过(不报错)', async () => {
  const errs = await validateWith({ initContainers: [{ name: '', image: '', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' }] })
  expect(errs).toEqual([])
})

// 注:isEmptyEnvRow 以 name/image/command/args 四字段判空,name+image 双空即整行跳过,
// 故此处给 name 使行非空,单验 image 缺失(brief 原稿 name/image 双空会被跳过,已最小适配)。
test('缺镜像 → 带标签的 imageRequired', async () => {
  const errs = await validateWith({ initContainers: [{ ...C(), name: 'init-1', image: '' }] })
  expect(errs.some(e => e.msg.includes(initLabel()) && e.msg.includes(i18n.global.t('deploy.containerFv.imageRequired')))).toBe(true)
})

test('name 非 DNS-1123 → namePattern;两个同名显式容器 → 双方各报 nameDuplicate', async () => {
  const errs = await validateWith({
    initContainers: [{ ...C(), name: 'Bad_Name' }],
    extraContainers: [{ ...C(), name: 'dup' }, { ...C(), name: 'dup' }],
  })
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.namePattern')))).toBe(true)
  const dups = errs.filter(e => e.msg.includes(i18n.global.t('deploy.containerFv.nameDuplicate', { name: 'dup' })))
  expect(dups.length).toBe(2)
})

test('显式名撞主容器有效名 → nameDuplicate', async () => {
  const errs = await validateWith({ extraContainers: [{ ...C(), name: 'app' }] })
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.nameDuplicate', { name: 'app' })))).toBe(true)
})

test('req > lim → cpu/memory OverLimit;合法容器不报 step-1 容器错', async () => {
  const errs = await validateWith({
    initContainers: [{ ...C(), cpuRequest: '1', cpuLimit: '500m' }],
    extraContainers: [{ ...C(), memoryRequest: '1Gi', memoryLimit: '512Mi' }],
  })
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.cpuOverLimit', { req: '1', lim: '500m' })))).toBe(true)
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.memoryOverLimit', { req: '1Gi', lim: '512Mi' })))).toBe(true)
  const clean = await validateWith({ initContainers: [{ ...C(), name: 'ok-init' }] })
  expect(clean).toEqual([])
})

// 回归:空名行夹中间时,othersFor 须按原列表下标排除自身——
// 压缩数组索引错位曾致唯一显式名误报 nameDuplicate(撞自己)。
test('空名行夹中间 → 前后两个不同显式名互不误报、也不误报撞自己', async () => {
  const errs = await validateWith({
    initContainers: [
      { ...C(), name: 'x' },
      { ...C(), name: '', image: 'busybox' },
      { ...C(), name: 'y' },
    ],
  })
  expect(errs.filter(e => e.msg.includes(i18n.global.t('deploy.containerFv.nameDuplicate', { name: 'y' })))).toEqual([])
  expect(errs.filter(e => e.msg.includes(i18n.global.t('deploy.containerFv.nameDuplicate', { name: 'x' })))).toEqual([])
})
