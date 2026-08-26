// 子容器 YAML 序列化安全 + 全字段落地 + 原生 sidecar 归位:
// dump 默认启发式对 YAML 1.1 危险值加引号(实测钉住),lineWidth:-1 禁折行。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { load } from 'js-yaml'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { makeSubContainer } from '@/logic/subContainer'

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

test('子容器 env/探针/安全上下文全落地,YAML 1.1 危险值不变形', async () => {
  const sc = { ...makeSubContainer(), name: 'sc1', image: 'busybox',
    envVars: [{ key: 'A', value: 'on' }, { key: 'B', value: '3600' }, { key: 'C', value: '2026-08-15' }, { key: 'D', value: 'l1\nl2' }],
    liveness: { ...makeSubContainer().liveness, enabled: true, type: 'http' },
    securityContext: { ...makeSubContainer().securityContext, enabled: true, runAsUser: '1000' } }
  const pod = await podWith({ extraContainers: [sc] })
  const side = pod.containers[1]
  expect(side.env.map(e => [e.name, typeof e.value, e.value])).toEqual([
    ['A', 'string', 'on'], ['B', 'string', '3600'], ['C', 'string', '2026-08-15'], ['D', 'string', 'l1\nl2'],
  ])
  expect(side.livenessProbe.httpGet).toEqual({ path: '/health', port: 8080 })
  expect(side.securityContext).toEqual({ runAsUser: 1000 })
})

test('原生 sidecar → initContainers 尾部 + restartPolicy: Always;普通 sidecar 仍在 containers', async () => {
  const pod = await podWith({
    initContainers: [{ ...makeSubContainer(), name: 'i0', image: 'busybox' }],
    extraContainers: [
      { ...makeSubContainer(), name: 'plain', image: 'nginx' },
      { ...makeSubContainer(), name: 'native', image: 'envoy', nativeSidecar: true },
    ],
  })
  expect(pod.containers.map(c => c.name)).toEqual(['app', 'plain'])
  expect(pod.initContainers.map(c => c.name)).toEqual(['i0', 'native'])
  expect(pod.initContainers.map(c => c.restartPolicy)).toEqual([undefined, 'Always'])
})

test('子容器挂载按 target 落 volumeMounts(创建面)', async () => {
  const sc = { ...makeSubContainer(), name: 'sc1', image: 'busybox' }
  const pod = await podWith({
    extraContainers: [sc],
    volumeMounts: [
      { name: 'v1', target: 'sidecar:0', type: 'pvc', mountPath: '/data', subPath: 's', readOnly: true, pvcName: 'p1', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
      { name: 'v2', target: 'main', type: 'pvc', mountPath: '/m', subPath: '', readOnly: false, pvcName: 'p2', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
    ],
  })
  expect(pod.containers[1].volumeMounts).toEqual([{ name: 'v1', mountPath: '/data', subPath: 's', readOnly: true }])
})
