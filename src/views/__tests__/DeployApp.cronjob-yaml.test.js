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
import { workloadToForm } from '@/composables/useWorkloadToForm'

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

// ---- restartPolicy 必填批(2026-10-01 生产报障:apiserver 拒缺省) ----
// Job/CronJob 的 pod 模板必须显式 restartPolicy ∈ {OnFailure, Never}(默认 Always 非法);
// 旧向导不产该字段 → 提交时报 CronJob.batch invalid: restartPolicy: Required value,
// 填写期零提示(生成器缺字段,校验无从锚定)。
test('CronJob 默认 OnFailure:jobTemplate.spec.template.spec.restartPolicy 在场(旧态缺失被 apiserver 拒)', async () => {
  const text = await yamlOf({
    workloadType: 'CronJob',
    cronConfig: { schedule: '*/5 * * * *', concurrencyPolicy: 'Allow', suspend: false, successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1 },
    jobConfig: { completions: 1, parallelism: 1, backoffLimit: 6 },
  })
  const doc = load(text)
  expect(doc.spec.jobTemplate.spec.template.spec.restartPolicy).toBe('OnFailure')
})

test('Job 默认 Never:spec.template.spec.restartPolicy 在场', async () => {
  const text = await yamlOf({ workloadType: 'Job', jobConfig: { completions: 1, parallelism: 1, backoffLimit: 6 } })
  const doc = load(text)
  expect(doc.spec.template.spec.restartPolicy).toBe('Never')
})

test('用户显式选择生效(CronJob 选 Never)且非法值兜底回类型默认(白名单守卫)', async () => {
  // 真实交互序:先切类型(watch 归位默认)再改策略——一次性 spread 会被 watch 重置掩蔽
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'rp-test', image: 'nginx', workloadType: 'CronJob' } })
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, jobConfig: { ...w.vm.form.jobConfig, restartPolicy: 'Never' } } })
  await flushPromises()
  expect(load(w.vm.previewYAML).spec.jobTemplate.spec.template.spec.restartPolicy).toBe('Never')
  await w.setData({ form: { ...w.vm.form, jobConfig: { ...w.vm.form.jobConfig, restartPolicy: 'Always' } } })
  await flushPromises()
  // 脏值 'Always'(对 batch 非法)被构建器白名单兜底回 CronJob 默认,不直写清单
  expect(load(w.vm.previewYAML).spec.jobTemplate.spec.template.spec.restartPolicy).toBe('OnFailure')
  w.unmount(); document.body.innerHTML = ''
})

test('apps 三类不产 restartPolicy(默认 Always 无需显式;零回归)', async () => {
  const doc = load(await yamlOf({ workloadType: 'Deployment', replicas: 1 }))
  expect(doc.spec.template.spec.restartPolicy).toBeUndefined()
})

test('复制回填:CronJob/Job 既有 restartPolicy 进表单,缺省回落类型默认(复制工作负载往返)', () => {
  const cronObj = { metadata: { name: 'cj', namespace: 'default' }, spec: { schedule: '* * * * *', jobTemplate: { spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'c', image: 'nginx' }] } } } } } }
  expect(workloadToForm(cronObj, 'CronJob').jobConfig.restartPolicy).toBe('Never')
  const jobObj = { metadata: { name: 'j', namespace: 'default' }, spec: { template: { spec: { containers: [{ name: 'c', image: 'nginx' }] } } } }
  expect(workloadToForm(jobObj, 'Job').jobConfig.restartPolicy).toBe('Never')
  const cronNoRp = { metadata: { name: 'cj2', namespace: 'default' }, spec: { schedule: '* * * * *', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'c', image: 'nginx' }] } } } } } }
  expect(workloadToForm(cronNoRp, 'CronJob').jobConfig.restartPolicy).toBe('OnFailure')
})
