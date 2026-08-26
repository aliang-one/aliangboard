// Deploy 向导 init/sidecar 容器名 DNS-1123 清洗回归:
//   自动派生名 = image 前缀,可能含大写/下划线/点/斜杠(K8s 容器名须 ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$);
//   两个同镜像容器 → 派生重名 → K8s 拒。用户显式填写的 name 原样透传(不静默改写)。
// 背景:2026-08-17 系统审计 P3。
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

const C = image => ({ name: '', image, command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

async function podWith(extraForm) {
  const w = mountApp()
  await flushPromises()
  await w.setData({ form: { ...w.vm.form, name: 'app', containerName: '', image: 'nginx', ...extraForm } })
  await flushPromises()
  return load(w.vm.previewYAML).spec.template.spec
}

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

test('image 派生名清洗:大写/下划线/registry 前缀 → DNS-1123 合法', async () => {
  const pod = await podWith({ initContainers: [C('ghcr.io/Org/My_App:v1.2')] })
  const n = pod.initContainers[0].name
  expect(n).toMatch(DNS1123)
  expect(n).toBe('my-app')
})

test('同镜像两个 sidecar → 派生名去重(nginx / nginx-2)', async () => {
  const pod = await podWith({ extraContainers: [C('nginx'), C('nginx')] })
  expect(pod.containers.map(c => c.name)).toEqual(['app', 'nginx', 'nginx-2'])
})

test('sidecar 与主容器同镜像 → 与主容器名去重', async () => {
  const pod = await podWith({ extraContainers: [C('nginx')] })
  // 主容器名默认 = 工作负载名 app;sidecar 同镜像 nginx,不冲突原名保留
  expect(pod.containers.map(c => c.name)).toEqual(['app', 'nginx'])
})

test('sidecar 撞主容器名(app 同名镜像)→ 追加序号', async () => {
  const pod = await podWith({ extraContainers: [C('docker.io/library/app:1')] })
  expect(pod.containers.map(c => c.name)).toEqual(['app', 'app-2'])
})

test('派生后无有效字符 → fallback sidecar-N/init-N', async () => {
  const pod = await podWith({ extraContainers: [C('???')] })
  expect(pod.containers[1].name).toBe('sidecar-1')
})

test('用户显式填写的 name 原样透传(不清洗)', async () => {
  const pod = await podWith({ extraContainers: [{ ...C('nginx'), name: 'my-proxy' }] })
  expect(pod.containers[1].name).toBe('my-proxy')
})

test('显式名入播种集:显式 nginx + 另一容器镜像 nginx → 派生 nginx-2(原 bug:撞车)', async () => {
  // 原 bug:usedContainerNames 只播种主容器名 → 派生名与显式名撞车 → K8s 拒绝。
  // extraContainers 的派生在 previewYAML 中先于 initContainers 求值。
  const pod = await podWith({
    initContainers: [{ ...C('nginx'), name: 'nginx' }],
    extraContainers: [C('nginx')],
  })
  expect(pod.containers.map(c => c.name)).toEqual(['app', 'nginx-2'])
  expect(pod.initContainers[0].name).toBe('nginx')
})
