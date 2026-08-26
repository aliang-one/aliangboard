// Deploy 向导 command/args 切分约定回归:
//   command = 空白切分(shell token,`sh -c` → ["sh","-c"])
//   args   = 按行切分(每行一条,`cp /a /b` 单行 → 单条,空格不拆散)
// 覆盖 main / init / sidecar 三类容器 + sidecar 表单输入框存在性。
// 背景:2026-08-16 用户报告 `sh -c` + 单条含空格 args 被空格拆成多条,sidecar 无 args 输入。
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

const CONTAINER_ROW = { name: 'init-config', image: 'ghcr.io/wei-shaw/sub2api:0.1.172', command: 'sh -c', args: 'cp /data/config.yaml /initconfig/config.yaml', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' }

async function previewWith(form) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, ...form } })
  await flushPromises()
  return { w, pod: load(w.vm.previewYAML).spec.template.spec }
}

test('主容器:command 空格切分;args 单行整条保留(含空格不拆散)', async () => {
  const { pod } = await previewWith({ containerName: 'main', image: 'nginx', command: 'sh -c', args: 'cp /data/config.yaml /initconfig/config.yaml' })
  expect(pod.containers[0].command).toEqual(['sh', '-c'])
  expect(pod.containers[0].args).toEqual(['cp /data/config.yaml /initconfig/config.yaml'])
})

test('主容器:args 多行 → 多条(每行一条)', async () => {
  const { pod } = await previewWith({ containerName: 'main', image: 'nginx', args: '--port=8080\n--debug' })
  expect(pod.containers[0].args).toEqual(['--port=8080', '--debug'])
})

test('init 容器:command 空格切分;args 单行整条保留;image 不丢', async () => {
  const { pod } = await previewWith({ containerName: 'main', image: 'nginx', initContainers: [CONTAINER_ROW] })
  const init = pod.initContainers[0]
  expect(init.image).toBe('ghcr.io/wei-shaw/sub2api:0.1.172')
  expect(init.command).toEqual(['sh', '-c'])
  expect(init.args).toEqual(['cp /data/config.yaml /initconfig/config.yaml'])
})

test('sidecar 容器:command 与 args 都进 YAML,args 单行整条保留', async () => {
  const { pod } = await previewWith({ containerName: 'main', image: 'nginx', extraContainers: [{ ...CONTAINER_ROW, name: 'side', command: 'envoy', args: '-c /etc/envoy.yaml' }] })
  const side = pod.containers.find(c => c.name === 'side')
  expect(side).toBeTruthy()
  expect(side.command).toEqual(['envoy'])
  expect(side.args).toEqual(['-c /etc/envoy.yaml'])
})

test('表单 UI:init 与 sidecar 行都有 command/args 输入框(args 为多行 textarea)', async () => {
  const w = mountApp()
  await flushPromises()
  await w.setData({ currentStep: 1, form: { ...w.vm.form, initContainers: [CONTAINER_ROW], extraContainers: [{ ...CONTAINER_ROW, name: 'side' }] } })
  await flushPromises()
  expect(w.find('[data-testid="init-command-input"]').exists()).toBe(true)
  expect(w.find('[data-testid="init-args-input"]').exists()).toBe(true)
  expect(w.find('[data-testid="sidecar-command-input"]').exists()).toBe(true)
  expect(w.find('[data-testid="sidecar-args-input"]').exists()).toBe(true)
  expect(w.find('[data-testid="init-args-input"]').element.tagName).toBe('TEXTAREA')
  expect(w.find('[data-testid="sidecar-args-input"]').element.tagName).toBe('TEXTAREA')
})

test('硬化:command 引号分组;args/env 值含引号、反斜杠、换行经 YAML 往返无损', async () => {
  const { pod } = await previewWith({
    containerName: 'main', image: 'nginx',
    command: 'sh -c "echo hi"',
    args: 'say "hello" \\ world',
    envVars: [{ key: 'GREETING', value: 'he said "hi"\nand left' }],
  })
  expect(pod.containers[0].command).toEqual(['sh', '-c', 'echo hi'])
  expect(pod.containers[0].args).toEqual(['say "hello" \\ world'])
  expect(pod.containers[0].env).toEqual([{ name: 'GREETING', value: 'he said "hi"\nand left' }])
})

test('硬化:exec 探针与 lifecycle 钩子的 command 含引号/空格同样往返无损', async () => {
  const { pod } = await previewWith({
    containerName: 'main', image: 'nginx',
    liveness: { enabled: true, type: 'exec', execCommand: 'sh -c "curl -f localhost:8080/ready"', initialDelaySeconds: 5, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 },
    lifecycle: { postStart: 'sh -c "echo started"', preStop: '' },
  })
  expect(pod.containers[0].livenessProbe.exec.command).toEqual(['sh', '-c', 'curl -f localhost:8080/ready'])
  expect(pod.containers[0].lifecycle.postStart.exec.command).toEqual(['sh', '-c', 'echo started'])
})
