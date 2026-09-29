// 生产事故复现(2026-09-29 用户报障):向导创建 CronJob 恒报
// 「duplicated mapping key (25:5)」——previewYAML 公共尾部(metadata/labels/spec 固定
// 4 空格)对 CronJob 的 jobTemplate.spec.template 双层嵌套缩进不足,spec: 挂回
// jobTemplate: 形成重复键;且报错只有裸 YAML 解析错,无字段级归因。
// 本文件钉住:CronJob/Job 向导 YAML 必须可被 js-yaml 干净解析且嵌套形状正确。
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

async function yamlOf(extraForm) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'dasffdafasdf', image: 'nginx', ...extraForm } })
  await flushPromises()
  const text = w.vm.previewYAML
  w.unmount()
  return text
}

test('CronJob 向导 YAML:可干净解析(旧态 duplicated mapping key),嵌套形状 jobTemplate.spec.template 正确', async () => {
  const text = await yamlOf({
    workloadType: 'CronJob',
    cronConfig: { schedule: '*/5 * * * *', concurrencyPolicy: 'Allow', suspend: false, successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1 },
    jobConfig: { backoffLimit: 6, completions: 1, parallelism: 1 },
    tier: 'presentation',
  })
  let doc
  expect(() => { doc = load(text) }, `js-yaml 须可解析,实际产物:\n${text}`).not.toThrow()
  expect(doc.apiVersion).toBe('batch/v1')
  expect(doc.kind).toBe('CronJob')
  expect(doc.spec.schedule).toBe('*/5 * * * *')
  // pod 模板必须嵌在 jobTemplate.spec.template 下(旧态 metadata/spec 脱嵌挂回 jobTemplate)
  expect(doc.spec.jobTemplate.spec.template.metadata.labels.app).toBe('dasffdafasdf')
  expect(doc.spec.jobTemplate.spec.template.metadata.labels['aliangboard.io/layer']).toBe('presentation')
  expect(doc.spec.jobTemplate.spec.template.spec.containers[0].image).toBe('nginx')
  // jobTemplate.spec 不得混入 pod 级键(metadata/labels 等)
  expect(doc.spec.jobTemplate.spec.metadata).toBeUndefined()
})

test('Job 向导 YAML 零回归:template 直挂 spec 下,形状不变', async () => {
  const text = await yamlOf({
    workloadType: 'Job',
    jobConfig: { backoffLimit: 6, completions: 1, parallelism: 1 },
    tier: 'presentation',
  })
  const doc = load(text)
  expect(doc.kind).toBe('Job')
  expect(doc.spec.template.metadata.labels.app).toBe('dasffdafasdf')
  expect(doc.spec.template.spec.containers[0].image).toBe('nginx')
})

test('Deployment 向导 YAML 零回归', async () => {
  const text = await yamlOf({ workloadType: 'Deployment', replicas: 1 })
  const doc = load(text)
  expect(doc.kind).toBe('Deployment')
  expect(doc.spec.template.spec.containers[0].image).toBe('nginx')
  expect(doc.spec.selector.matchLabels.app).toBe('dasffdafasdf')
})
