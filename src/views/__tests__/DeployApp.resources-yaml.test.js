// 创建向导主容器 resources YAML 块(2026-10-11 换算层根修配套):
// - 曾无条件插值 `cpu: ${f.cpuRequest}`:全清空时产出 `cpu:` 空值;cores 裸数('2')产出 YAML number
//   (经 js-yaml → JSON number 下发);现改为 mergeResources 条件生成 + dump 引号启发式。
// - 复制链 extraResources 第三键(ephemeral-storage/nvidia.com/gpu)须落进 YAML。
// - 主容器 req>lim 在提交校验被本地拦截(不再漏到 apiserver 422)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { load } from 'js-yaml'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', watchStateOf: () => 'off', fetchIngressClasses: vi.fn(async () => []), fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []), fetchPriorityClasses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []), setNamespace: () => {} }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployApp from '../DeployApp.vue'

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

async function podWith(extraForm) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', image: 'nginx', ...extraForm } })
  await flushPromises()
  return load(w.vm.previewYAML).spec.template.spec
}

test('常规四值 → resources 落地且 quantity 全为字符串类型', async () => {
  const pod = await podWith({ cpuRequest: '250m', cpuLimit: '0.5', memoryRequest: '256Mi', memoryLimit: '512Mi' })
  const r = pod.containers[0].resources
  expect(r).toEqual({ requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '0.5', memory: '512Mi' } })
  expect(typeof r.requests.cpu).toBe('string')
  expect(typeof r.limits.cpu).toBe('string')   // cores 裸数 '0.5' 曾成 YAML number
})

test('四键全空 → 不产出 resources 键(曾是 cpu: 空值)', async () => {
  const pod = await podWith({ cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' })
  expect(pod.containers[0].resources).toBeUndefined()
})

test('部分填写 → 只产出已填子块(仅 limits)', async () => {
  const pod = await podWith({ cpuRequest: '', cpuLimit: '500m', memoryRequest: '', memoryLimit: '1Gi' })
  expect(pod.containers[0].resources).toEqual({ limits: { cpu: '500m', memory: '1Gi' } })
})

test('复制链第三资源键落进 YAML(ephemeral-storage/nvidia.com/gpu)', async () => {
  const pod = await podWith({
    cpuRequest: '100m', cpuLimit: '1', memoryRequest: '128Mi', memoryLimit: '1Gi',
    extraResources: { limits: { 'ephemeral-storage': '1Gi', 'nvidia.com/gpu': '1' } },
  })
  expect(pod.containers[0].resources.limits).toEqual({ cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi', 'nvidia.com/gpu': '1' })
})

test('快速模板整套替换容器画像:复制链第三资源键一并清(审查修复)', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', image: 'nginx',
    extraResources: { limits: { 'nvidia.com/gpu': '1' } } } })
  await flushPromises()
  w.vm.applyTemplate(w.vm.quickTemplates ? w.vm.quickTemplates[0] : { image: 'nginx:latest', cpuReq: '100m', cpuLim: '250m', memReq: '128Mi', memLim: '256Mi', port: 80, portName: 'http', id: 'nginx', tier: 'presentation' })
  await flushPromises()
  // 模板带 Service → YAML 多文档,只取首个文档(workload 本体)
  const firstDoc = w.vm.previewYAML.split('\n---\n')[0]
  const pod = load(firstDoc).spec.template.spec
  expect(pod.containers[0].resources?.limits?.['nvidia.com/gpu']).toBeUndefined()
})

test('主容器 req>lim → 提交校验本地拦截(cpu/memory 各一)', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', image: 'nginx', cpuRequest: '2', cpuLimit: '500m', memoryRequest: '2Gi', memoryLimit: '512Mi' } })
  await flushPromises()
  const errs = w.vm.validate().filter(e => e.step === 1)
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.cpuOverLimit', { req: '2', lim: '500m' })))).toBe(true)
  expect(errs.some(e => e.msg.includes(i18n.global.t('deploy.containerFv.memoryOverLimit', { req: '2Gi', lim: '512Mi' })))).toBe(true)
})
