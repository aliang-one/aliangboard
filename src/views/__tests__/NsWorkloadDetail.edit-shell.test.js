// NsWorkloadDetail 编辑面壳测试(该视图此前零测试):锁定「编辑 Modal 可开 + 子容器行内表单渲染」
// 现状,供 Task 9/10 模型迁移与模板手术的回归网。mock 策略与 DeployApp 系测试一致
// (mock @/api/client 与 @/stores/cluster,真实 i18n + Vue Query)。
// Fix round 1(渲染锁定补强)新增适配:去 Modal stub 后暴露两处原被掩盖的依赖——
// ① cluster store 需 fetchWorkloads 回真实 Deployment(isRolloutType v-if 才放行容器模板区)
//   + checkAccessServer(loadPerms immediate watch)+ fetchPods;② setData editForm 需补齐
//   Modal 模板触达的最小键骨架(探针三键 enabled 等,否则渲染崩)。
import { test, expect, vi } from 'vitest'

// 文件级捕获桩:saveEdit 会先 store.updateWorkload(Deployment 级)再 store.applyWorkloadTemplate(pod 模板)。
// 两者均捕获,captured.at(-1) 即 applyWorkloadTemplate 的 tpl(其 .spec 为 pod spec)。
const captured = vi.hoisted(() => [])
// 可变 fixture 容器:Fix round 2 起个别用例需注入多容器 pod spec,经 state.demoWorkload 可整体替换/复原
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
// fetchWorkloads 回一个 Deployment:编辑 Modal 的容器模板区 v-if=isRolloutType 需 workload.type
const demoWorkload = {
  name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo' },
  raw: {
    metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo' } },
    spec: {
      replicas: 1, selector: { matchLabels: { app: 'demo' } },
      template: { metadata: { labels: { app: 'demo' } }, spec: { containers: [{ name: 'main', image: 'nginx' }] } },
    },
  },
}
state.demoWorkload = demoWorkload
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [state.demoWorkload]), fetchPods: vi.fn(async () => []),
  updateWorkload: vi.fn((name, ns, updates) => captured.push(updates)),
  applyWorkloadTemplate: vi.fn(async (name, ns, tpl) => captured.push(tpl)),
  invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'
import { makeSubContainer } from '@/logic/subContainer'

// captured.at(-1) = applyWorkloadTemplate 的 pod 模板 tpl;其 .spec 即 pod spec
function capturedSpec() { return captured.at(-1)?.spec || captured.at(-1) }

function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: true, Breadcrumbs: true } } })
}

// 不 stub Modal:让编辑 Modal 的 slot 内容(子容器行内表单)真实渲染,供断言锁定
function mountDetailB() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true } } })
}

test('视图可挂载(壳)', async () => {
  const w = mountDetail()
  await flushPromises()
  expect(w.exists()).toBe(true)
  w.unmount()
})

test('编辑 Modal 打开后 init/sidecar 行内表单渲染已有行(锁定现状)', async () => {
  const w = mountDetailB()
  await flushPromises()
  await w.setData({
    editForm: {
      // Modal 模板渲染所需的最小骨架(openEdit 会填全量;此处补齐 v-for/探针等被模板触达的键)
      ...w.vm.editForm,
      imageRepo: 'nginx', imageTag: 'latest', replicas: '1', tier: 'default',
      imagePullPolicy: 'IfNotPresent', command: '', args: '', workingDir: '',
      cpuReq: '', cpuLim: '', memReq: '', memLim: '',
      ports: [], env: [], envCMKeys: [], envSecretKeys: [], envFromConfigMap: '', envFromSecret: '',
      liveness: { enabled: false }, readiness: { enabled: false }, startup: { enabled: false },
      volumeMounts: [], nodeSelectors: [], tolerations: [],
      securityContext: {}, lifecycle: { postStart: '', preStop: '' },
      serviceAccountName: '', priorityClassName: '', imagePullSecrets: '',
      strategy: 'RollingUpdate', maxSurge: '25%', maxUnavailable: '25%', revisionHistoryLimit: 10,
      initContainers: [{ ...makeSubContainer(), name: 'i0', image: 'busybox', envVars: [{ key: 'K', value: 'V' }] }],
      extraContainers: [{ ...makeSubContainer(), name: 's0', image: 'nginx' }],
    },
    showEditModal: true,
  })
  await flushPromises()
  // Modal teleport 到 body:断言卡片表单真实渲染(input value 含注入行数据)+ 卡片结构(badge/expand 按钮)
  const values = [...document.body.querySelectorAll('input, textarea')].map(el => el.value)
  expect(values).toContain('i0')
  expect(values).toContain('busybox')
  expect(values).toContain('s0')
  expect(document.body.querySelector('[data-testid="ced-advanced-badge"]')).toBeTruthy()      // init 卡片带高级字段 badge
  expect(document.body.querySelector('[data-testid="init-expand-btn"]')).toBeTruthy()
  expect(document.body.querySelector('[data-testid="sidecar-expand-btn"]')).toBeTruthy()
  w.unmount()
  document.body.innerHTML = ''
})

const $$ = sel => document.body.querySelector(sel)

test('编辑面子容器卡片:badge + 点开共享弹窗(嵌套于编辑 Modal 之上)', async () => {
  const w = mountDetailB()
  await flushPromises()
  await w.vm.openEdit()   // 填全量表单骨架(探针/安全上下文等模板触达键),再注入子容器
  await w.setData({
    editForm: { ...w.vm.editForm,
      initContainers: [{ ...makeSubContainer(), name: 'i0', image: 'busybox', envVars: [{ key: 'K', value: 'V' }] }] },
    showEditModal: true,
  })
  await flushPromises()
  const badge = document.body.querySelector('[data-testid="ced-advanced-badge"]')
  expect(badge).toBeTruthy()
  expect(badge.textContent).toContain('1')
  badge.click()
  await flushPromises()
  expect($$('[data-testid="ced-name-input"]').value).toBe('i0')       // 共享弹窗回显(在编辑 Modal 之上)
  // 确认写回同槽:
  const nameInput = $$('[data-testid="ced-name-input"]')
  nameInput.value = 'renamed'; nameInput.dispatchEvent(new Event('input'))
  $$('[data-testid="ced-confirm-btn"]').click()
  await flushPromises()
  expect(w.vm.editForm.initContainers[0].name).toBe('renamed')
  expect(w.vm.editForm.initContainers[0].envVars[0].key).toBe('K')    // 未写回字段不丢
  w.unmount(); document.body.innerHTML = ''
})

test('saveEdit 重建:普通 sidecar 进 containers,原生进 initContainers 尾部(带 Always),挂载按原索引', async () => {
  const w = mountDetail()
  await flushPromises()
  await w.setData({
    editForm: {
      ...w.vm.editForm,
      initContainers: [{ ...makeSubContainer(), name: 'i0', image: 'busybox' }],
      extraContainers: [
        { ...makeSubContainer(), name: 'plain', image: 'nginx' },
        { ...makeSubContainer(), name: 'native', image: 'envoy', nativeSidecar: true },
      ],
      volumeMounts: [
        { name: 'v1', target: 'sidecar:0', type: 'pvc', mountPath: '/a', subPath: '', readOnly: false, pvcName: 'p1', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
        { name: 'v2', target: 'sidecar:1', type: 'pvc', mountPath: '/b', subPath: '', readOnly: false, pvcName: 'p2', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
        { name: 'v3', target: 'init:0', type: 'pvc', mountPath: '/c', subPath: '', readOnly: false, pvcName: 'p3', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] },
      ],
    },
  })
  await flushPromises()
  await w.vm.saveEdit()
  await flushPromises()
  const spec = capturedSpec()
  const pod = spec.template?.spec || spec
  expect(pod.containers.map(c => c.name)).toEqual([pod.containers[0].name, 'plain'])
  expect(pod.initContainers.map(c => c.name)).toEqual(['i0', 'native'])
  expect(pod.initContainers.map(c => c.restartPolicy)).toEqual([null, 'Always'])
  expect(pod.containers.find(c => c.name === 'plain').volumeMounts).toEqual([{ name: 'v1', mountPath: '/a' }])
  expect(pod.initContainers.find(c => c.name === 'native').volumeMounts).toEqual([{ name: 'v2', mountPath: '/b' }])
  expect(pod.initContainers.find(c => c.name === 'i0').volumeMounts).toEqual([{ name: 'v3', mountPath: '/c' }])
})

// Fix round 2:openEdit 分流原生 sidecar(Always)后,mergeVolumes 的挂载 tag 须按分流后索引回填
test('原生 sidecar 挂载往返:回填 tag 分流正确,重建不丢挂载', async () => {
  const orig = state.demoWorkload
  state.demoWorkload = {
    ...orig,
    name: 'demo-deploy', namespace: 'default', type: 'Deployment', image: 'nginx:1', replicas: '1/1', labels: { app: 'demo' },
    raw: {
      metadata: { name: 'demo-deploy', namespace: 'default', labels: { app: 'demo' } },
      spec: {
        replicas: 1, selector: { matchLabels: { app: 'demo' } },
        template: {
          metadata: { labels: { app: 'demo' } },
          spec: {
            volumes: [
              { name: 'vol-init', emptyDir: {} }, { name: 'vol-native', emptyDir: {} }, { name: 'vol-plain', emptyDir: {} },
            ],
            initContainers: [
              { name: 'init-plain', image: 'busybox:1', volumeMounts: [{ name: 'vol-init', mountPath: '/i' }] },
              { name: 'nat-side', image: 'envoy:1', restartPolicy: 'Always', volumeMounts: [{ name: 'vol-native', mountPath: '/n' }] },
            ],
            containers: [
              { name: 'main', image: 'nginx:1' },
              { name: 'plain-sc', image: 'sidecar:1', volumeMounts: [{ name: 'vol-plain', mountPath: '/p' }] },
            ],
          },
        },
      },
    },
  }
  try {
    const w = mountDetail()
    await flushPromises()
    await w.vm.openEdit()
    const tags = w.vm.editForm.volumeMounts.map(v => v.target).sort()
    expect(tags).toEqual(['init:0', 'sidecar:0', 'sidecar:1'])
    await w.vm.saveEdit()
    await flushPromises()
    const spec = capturedSpec()
    const pod = spec.template?.spec || spec
    expect(pod.containers.map(c => c.name)).toEqual(['main', 'plain-sc'])
    expect(pod.containers[1].volumeMounts?.[0]?.name).toBe('vol-plain')
    expect(pod.initContainers.map(c => c.name)).toEqual(['init-plain', 'nat-side'])
    expect(pod.initContainers.find(c => c.restartPolicy === 'Always').volumeMounts?.[0]?.name).toBe('vol-native')
    expect(pod.initContainers.find(c => !c.restartPolicy).volumeMounts?.[0]?.name).toBe('vol-init')
  } finally {
    state.demoWorkload = orig
  }
})
