// Deploy 向导 metadata 标量类型化 + 主资源失败呈报回归:
//   2026-08-16 线上事故:复制 workload 把 live 的 deployment.kubernetes.io/revision:"14"
//   带进表单,手写 YAML 裸拼 value → `revision: 14` → 网关按 YAML 1.2 解析成 number →
//   apiserver SSA 拒绝(expected string, got valueUnstructured{Value:14});同时 Service/Ingress
//   已建成功 → applied 非空 → 前端 ok+partial → 仍弹成功面板,用户以为全成功。
// 防线:labels/annotations value 一律走 yamlScalar(与 Ingress 注解事故同款修法);
// 主工作负载在 failed[] 时报失败,不进成功面板。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { load } from 'js-yaml'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const { applyResourceYaml, notify } = vi.hoisted(() => ({ applyResourceYaml: vi.fn(), notify: vi.fn() }))

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
    watchStateOf: () => 'off',
  currentCluster: 'demo', applyResourceYaml,
  fetchIngressClasses: vi.fn(async () => []), fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []),
  fetchPriorityClasses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []),
  fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []), setNamespace: () => {},
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))
vi.mock('@/composables/useToast', () => ({ notify }))

import DeployApp from '../DeployApp.vue'

beforeEach(() => { notify.mockClear(); applyResourceYaml.mockReset() })

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

async function previewWith(form) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, ...form } })
  await flushPromises()
  return { w, doc: load(w.vm.previewYAML) }
}

// --- 标量类型化:数字/bool 型注解与标签值必须以字符串往返 ---

test('annotations:数字型值(revision 14)往返为字符串,YAML 文本带引号', async () => {
  const { w, doc } = await previewWith({
    containerName: 'main', image: 'nginx',
    annotations: [{ key: 'deployment.kubernetes.io/revision', value: '14' }, { key: 'note', value: 'keep' }],
  })
  expect(doc.metadata.annotations['deployment.kubernetes.io/revision']).toBe('14')
  expect(doc.metadata.annotations.note).toBe('keep')
  expect(w.vm.previewYAML).toContain('deployment.kubernetes.io/revision: "14"')
})

test('labels:数字/bool 型值往返为字符串(顶层与 pod template 一致)', async () => {
  const { doc } = await previewWith({
    containerName: 'main', image: 'nginx',
    labels: [{ key: 'app', value: 'web' }, { key: 'weight', value: '3600' }, { key: 'enabled', value: 'true' }],
  })
  expect(doc.metadata.labels.weight).toBe('3600')
  expect(doc.metadata.labels.enabled).toBe('true')
  expect(doc.spec.template.metadata.labels.weight).toBe('3600')
  expect(doc.spec.template.metadata.labels.enabled).toBe('true')
})

test('annotations:含冒号/引号的值经 YAML 往返无损', async () => {
  const { doc } = await previewWith({
    containerName: 'main', image: 'nginx',
    annotations: [{ key: 'note', value: 'a: b #c "quoted"' }],
  })
  expect(doc.metadata.annotations.note).toBe('a: b #c "quoted"')
})

// --- 部署结果呈报:主资源失败 ≠ 部分成功 ---

const VALID_FORM = { name: 'demo', namespace: 'demo', containerName: 'main', image: 'nginx' }

test('主工作负载在 failed[] → 不弹成功面板,deployError 呈报原因', async () => {
  applyResourceYaml.mockResolvedValueOnce({
    ok: true, partial: true,
    applied: [{ kind: 'Service', name: 'demo-svc' }, { kind: 'Ingress', name: 'demo-ingress' }],
    failed: [{ kind: 'Deployment', name: 'demo', namespace: 'demo', error: 'expected string, got valueUnstructured{Value:14}' }],
    warning: 'Deployment/demo: expected string, got valueUnstructured{Value:14}',
  })
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, ...VALID_FORM } })
  await w.vm.handleDeploy()
  expect(w.vm.showDeploySuccess).toBe(false)
  expect(w.vm.deployError).toContain('Deployment/demo')
})

test('主资源成功、附属资源失败 → 成功面板 + warning toast(QA ISSUE-002 语义保持)', async () => {
  applyResourceYaml.mockResolvedValueOnce({
    ok: true, partial: true,
    applied: [{ kind: 'Deployment', name: 'demo' }],
    failed: [{ kind: 'Service', name: 'demo-svc', namespace: 'demo', error: 'boom' }],
    warning: 'Service/demo-svc: boom',
  })
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, ...VALID_FORM } })
  await w.vm.handleDeploy()
  expect(w.vm.showDeploySuccess).toBe(true)
  expect(w.vm.deployError).toBe('')
  expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('Service/demo-svc'))
})

test('全成功 → 成功面板,无 warning', async () => {
  applyResourceYaml.mockResolvedValueOnce({ ok: true, kind: 'Deployment', name: 'demo' })
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, ...VALID_FORM } })
  await w.vm.handleDeploy()
  expect(w.vm.showDeploySuccess).toBe(true)
  expect(w.vm.deployError).toBe('')
  expect(notify).not.toHaveBeenCalledWith('warning', expect.anything())
})
