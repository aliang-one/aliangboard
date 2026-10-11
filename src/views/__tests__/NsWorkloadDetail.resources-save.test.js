// NsWorkloadDetail saveEdit 资源接线测试(2026-10-11 审查修复配套;harness 复制自 edit-shell):
// 纯函数测试再绿也证明不了视图把 base/res 传对了(参数交换/base 恒 null/按名错组等接线
// 错误纯逻辑无感——「接线层是桩测试盲区」)。锁定四项接线:
// ① c0.resources = mergeResources(c0.resources || null, ...):第三资源键(ephemeral-storage/
//    nvidia.com/gpu)编辑保存后保真;表单清空 cpu → requests:null 显式删。
// ② 子容器按 origName 溯源 base:未建模字段(terminationMessagePath)保真;新建行重用
//    已删容器名不复活其 GPU 键。
// ③ stripImg 挂 extraContainers(曾死引用 f.containers,sidecar 镜像带空格 422)。
// ④ 主容器 req>lim 本地拦截(compareQuantity),不再漏到 apiserver。
import { test, expect, vi } from 'vitest'

const captured = vi.hoisted(() => [])
const state = vi.hoisted(() => ({ demoWorkload: null }))
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
// 多容器 fixture:主容器带第三资源键,sidecar envoy 带 GPU + 未建模字段
const demoWorkload = {
  name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo' },
  raw: {
    metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo' } },
    spec: {
      replicas: 1, selector: { matchLabels: { app: 'demo' } },
      template: { metadata: { labels: { app: 'demo' } }, spec: {
        containers: [
          { name: 'main', image: 'nginx:1',
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi', 'ephemeral-storage': '1Gi', 'nvidia.com/gpu': '1' } } },
          { name: 'envoy', image: 'envoy:1', terminationMessagePath: '/dev/custom-log',
            resources: { limits: { cpu: '250m', 'nvidia.com/gpu': '1' } } },
        ],
      } },
    },
  },
}
state.demoWorkload = demoWorkload
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
    watchStateOf: () => 'off',
  currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [state.demoWorkload]), fetchPods: vi.fn(async () => []),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  updateWorkload: vi.fn((name, ns, updates) => captured.push(updates)),
  applyWorkloadTemplate: vi.fn(async (name, ns, tpl) => captured.push(tpl)),
  invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

function capturedSpec() { return captured.at(-1)?.spec || captured.at(-1) }
function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: true, Breadcrumbs: true } } })
}

test('saveEdit 接线①:主容器第三资源键保真;清空 cpu 请求 → requests:null 显式删', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.vm.openEdit()
  expect(w.vm.editForm.cpuReq).toBe('100m')
  w.vm.editForm.cpuReq = ''            // 用户清空 cpu 请求
  await w.vm.saveEdit()
  await flushPromises()
  const pod = capturedSpec().template?.spec || capturedSpec()
  const r = pod.containers[0].resources
  // requests: cpu 显式删但 memory 仍在 → requests 键非 null;limits 第三键保真
  expect(r.requests).toEqual({ memory: '128Mi' })
  expect(r.limits).toEqual({ cpu: '500m', memory: '512Mi', 'ephemeral-storage': '1Gi', 'nvidia.com/gpu': '1' })
  w.unmount()
})

test('saveEdit 接线②:子容器 origName 溯源——未建模字段保真;新建同名行不复活 GPU', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.vm.openEdit()
  // 回填的 envoy 行(origName='envoy'):不动它,保存 → 未建模字段 + 第三键仍在
  await w.vm.saveEdit()
  await flushPromises()
  let pod = capturedSpec().template?.spec || capturedSpec()
  const envoy = pod.containers.find(c => c.name === 'envoy')
  expect(envoy.terminationMessagePath).toBe('/dev/custom-log')
  expect(envoy.resources.limits['nvidia.com/gpu']).toBe('1')

  // 删除 envoy 行,新建恰好同名的新行 → 不得复活已删容器的 GPU/未建模字段
  await w.vm.openEdit()
  w.vm.editForm.extraContainers = [{ ...w.vm.editForm.extraContainers[0], image: 'new-sidecar:1', origName: '', extraResources: null, cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' }]
  await w.vm.saveEdit()
  await flushPromises()
  pod = capturedSpec().template?.spec || capturedSpec()
  const rebuilt = pod.containers.find(c => c.name === 'envoy')
  expect(rebuilt.image).toBe('new-sidecar:1')
  expect(rebuilt.terminationMessagePath).toBeUndefined()   // 未建模键:新行不带 base → 不存在(非 null 删除,本来就没有)
  expect(rebuilt.resources).toBe(null)   // 四资源键全空 + 无 base → 显式删
  w.unmount()
})

test('saveEdit 接线③:sidecar 镜像带尾随空格被清洗(曾死引用 f.containers 漏网)', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.vm.openEdit()
  w.vm.editForm.extraContainers[0].image = 'envoy:1 '   // 尾随空格
  await w.vm.saveEdit()
  await flushPromises()
  const pod = capturedSpec().template?.spec || capturedSpec()
  expect(pod.containers.find(c => c.name === 'envoy').image).toBe('envoy:1')
  w.unmount()
})

test('saveEdit 接线④:主容器 req>lim 本地拦截,不发 PATCH', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.vm.openEdit()
  w.vm.editForm.cpuReq = '2000m'        // 请求 2000m > 上限 500m
  const before = captured.length
  await w.vm.saveEdit()
  await flushPromises()
  expect(captured.length).toBe(before)  // 校验拦截,未调用 updateWorkload/applyWorkloadTemplate
  w.unmount()
})

test('saveEdit 接线⑤(改名行):envoy 行改名后未建模字段随行迁移', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.vm.openEdit()
  w.vm.editForm.extraContainers[0].name = 'envoy-v2'
  await w.vm.saveEdit()
  await flushPromises()
  const pod = capturedSpec().template?.spec || capturedSpec()
  const renamed = pod.containers.find(c => c.name === 'envoy-v2')
  expect(renamed.terminationMessagePath).toBe('/dev/custom-log')
  w.unmount()
})
