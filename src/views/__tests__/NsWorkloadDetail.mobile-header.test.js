// Wave5 W2 Task6(R4/R3):页头可换行可截断 + tab 条横滚 + tab 名 i18n + 幽灵类清零。
// mock 策略照 NsWorkloadDetail.action-bar.test.js(真实 i18n + Vue Query)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
const demoWorkload = {
  name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo' },
  raw: { metadata: { name: 'demo-deploy', namespace: 'default' },
    spec: { replicas: 1, selector: { matchLabels: { app: 'demo' } },
      template: { metadata: { labels: { app: 'demo' } }, spec: { containers: [{ name: 'main', image: 'nginx' }] } } } },
}
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off', currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [demoWorkload]), fetchPods: vi.fn(async () => []),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  restartWorkload: vi.fn(), scaleWorkload: vi.fn(), invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' }, query: {} }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

async function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true, WorkloadTopologyTab: true } } })
  await flushPromises()
  return w
}

test('手机档页头(R4):外层 flex-wrap、h1 max-sm:truncate、按钮组去 shrink-0', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountDetail()
    const h1 = w.find('h1')
    expect(h1.classes().join(' ')).toContain('max-sm:truncate')
    const scaleBtn = w.findAll('button').find(b => b.text() === i18n.global.t('workload.scale'))
    const btnGroup = scaleBtn.element.parentElement
    expect(btnGroup.classList.contains('flex-wrap')).toBe(true)
    expect(btnGroup.classList.contains('shrink-0')).toBe(false)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('tab 条(R3):容器 overflow-x-auto,按钮 shrink-0+nowrap,文案走 i18n', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountDetail()
    const tabBar = w.findAll('div').find(d => d.classes().includes('border-b') && d.findAll('button').some(b => b.text() === i18n.global.t('workload.tabs.overview')))
    expect(tabBar).toBeTruthy()
    expect(tabBar.classes()).toContain('overflow-x-auto')
    const tabBtn = tabBar.findAll('button').find(b => b.text() === i18n.global.t('workload.tabs.overview'))
    expect(tabBtn.classes()).toContain('shrink-0')
    expect(tabBtn.classes()).toContain('whitespace-nowrap')
    // 纯 bug:tab 名不再是裸 key
    expect(tabBar.text()).not.toContain('overview')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('幽灵透明度类清零:渲染 HTML 不含 bg-primary/8', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountDetail()
    expect(w.html()).not.toContain('bg-primary/8')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})
