// Events 点击展开全部信息(2026-10-25):两处「看不全」——
// ① Events tab DataTable:加 expandable + #expanded 插槽,chevron 展开完整 message+
//    对象/类型/次数/首次(DataTable 现成机制,手机档 data-card-expand 自动同款);
// ② Pod 右列事件时间线:行点击切换展开,truncate→完整换行 + 元信息行。
// 展开态以事件 uid 为键(对抗评审确认:_idx 位置索引在 watch 重排后展开面板漂移到别的行)。
// mock 头照同目录 mobile-tables.test.js(真实 i18n + Vue Query);三个事件走真实 mapEvent
// 管线;fetchPods 给一个 pod 让 selectedPod 自动选中、右列时间线渲染。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'
import { fetchWorkloadRevisions } from '@/composables/useFetchers'
import { mapEvent } from '@/composables/useResourceMappers'
import { api } from '@/api/client'

const MSG_A = 'Back-off restarting failed container main in pod demo-deploy-abc_default(1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d) with a very long diagnostic message that overflows the cell'
const MSG_B = 'Created container main'
const MSG_C = 'Successfully pulled image nginx:1.27'
const T0 = Date.now()
const mkEvent = (name, uid, ts, msg, extra = {}) => ({
  metadata: { name, namespace: 'default', uid, creationTimestamp: ts },
  involvedObject: { kind: 'Deployment', name: 'demo-deploy', namespace: 'default' },
  type: 'Warning', reason: 'BackOff', message: msg, count: 3,
  firstTimestamp: new Date(T0 - 3600_000).toISOString(), lastTimestamp: ts, ...extra,
})
const EV1_RAW = mkEvent('demo-deploy.17a', 'ev-1', new Date(T0 - 60_000).toISOString(), MSG_A)            // 最新
const EV2_RAW = mkEvent('demo-deploy.17b', 'ev-2', new Date(T0 - 600_000).toISOString(), MSG_B, { type: 'Normal', reason: 'Created', count: 1 })
const EV3_RAW = mkEvent('demo-deploy.17c', 'ev-3', new Date(T0 - 10_000).toISOString(), MSG_C, { type: 'Normal', reason: 'Pulled', count: 1 })

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async (path) => {
    const p = String(path)
    if (p.includes('replicasets')) return { items: [{
      metadata: { name: 'demo-abc123', namespace: 'default',
        annotations: { 'deployment.kubernetes.io/revision': '2' },
        creationTimestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        ownerReferences: [{ kind: 'Deployment', controller: true, name: 'demo-deploy' }] },
      status: { replicas: 1, readyReplicas: 1 },
      spec: { replicas: 1, template: { spec: { containers: [{ image: 'nginx:1.27' }] } } } }] }
    if (p.includes('/deployments/demo-deploy')) return {
      metadata: { name: 'demo-deploy', namespace: 'default',
        annotations: { 'deployment.kubernetes.io/revision': '2' } },
      spec: { template: { spec: { containers: [{ image: 'nginx:1.27' }] } } } }
    if (p.includes('/api/v1/events')) return { items: [EV1_RAW, EV2_RAW] }
    return { items: [] }
  }) },
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
const demoPod = {
  name: 'demo-deploy-abc', namespace: 'default', containers: ['main'], status: 'Running',
  labels: { app: 'demo' },
  raw: { metadata: { name: 'demo-deploy-abc', namespace: 'default', labels: { app: 'demo' } },
    spec: { containers: [{ name: 'main', image: 'nginx' }] },
    status: { phase: 'Running' } },
}
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off', currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [demoWorkload]), fetchPods: vi.fn(async () => [demoPod]),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  restartWorkload: vi.fn(), scaleWorkload: vi.fn(), invalidateAllClusterQueries: vi.fn(async () => {}),
  fetchWorkloadRevisions: vi.fn(fetchWorkloadRevisions),
  fetchEvents: vi.fn(async () => {
    const d = await api.k8s('/api/v1/events?limit=1000')
    return ((d?.items || []).map(mapEvent)).sort((a, b) => (b._ts || 0) - (a._ts || 0))
  }),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' }, query: {} }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

// 传回 qc 供用例向 query 缓存写重排后的数据(模拟 watch 喂缓存,同 queryKey)
async function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true, WorkloadTopologyTab: true } } })
  await flushPromises()
  return { w, qc }
}

async function openEventsTab(w) {
  const tabBar = w.findAll('div').find(d => d.findAll('button').some(b => b.text() === i18n.global.t('workload.tabs.events')))
  await tabBar.findAll('button').find(b => b.text() === i18n.global.t('workload.tabs.events')).trigger('click')
  await flushPromises()
}

// 模拟 watch 重排:新事件 ev-3 到达,原展开的 ev-1 从第 1 行掉到第 2 行
function reshuffle(qc) {
  qc.setQueryData(['cluster', 'demo', 'events'], [mapEvent(EV3_RAW), mapEvent(EV1_RAW), mapEvent(EV2_RAW)])
}

test('Events tab 桌面档:chevron 展开行显示完整 message+对象/次数/首次', async () => {
  const spy = mockViewport(false)
  try {
    const { w } = await mountDetail()
    await openEventsTab(w)
    // expandable 接上:行首有展开钮(DataTable 现成机制)
    const toggle = w.find('[data-expand-toggle]')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')
    // 展开面板:完整 message 不截断 + 对象/次数/首次元信息
    const panel = w.find('[data-testid="event-expand-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain(MSG_A)
    expect(panel.text()).toContain('demo-deploy')
    expect(panel.text()).toContain('×3')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('Events tab:事件 watch 重排后展开面板跟随事件本身(不漂移到未点击的行)', async () => {
  const spy = mockViewport(false)
  try {
    const { w, qc } = await mountDetail()
    await openEventsTab(w)
    await w.find('[data-expand-toggle]').trigger('click')
    expect(w.find('[data-testid="event-expand-panel"]').text()).toContain(MSG_A)
    reshuffle(qc)
    await flushPromises()
    // 面板仍显示被点击事件(ev-1)的 message,而非占据第 1 行的 ev-3
    expect(w.find('[data-testid="event-expand-panel"]').text()).toContain(MSG_A)
    expect(w.find('[data-testid="event-expand-panel"]').text()).not.toContain(MSG_C)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('Events tab 手机档:卡片模式 data-card-expand 同款展开', async () => {
  const spy = mockViewport(true)
  try {
    const { w } = await mountDetail()
    await openEventsTab(w)
    const expand = w.find('[data-card-expand]')
    expect(expand.exists()).toBe(true)
    await expand.trigger('click')
    expect(w.find('[data-testid="event-expand-panel"]').exists()).toBe(true)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('Pod 右列事件时间线:点击行展开完整 message+元信息,再点收起', async () => {
  const spy = mockViewport(false)
  try {
    const { w } = await mountDetail()
    const row = w.find('[data-testid="event-timeline-row"]')
    expect(row.exists()).toBe(true)
    // 收起态:message 截断,无元信息行
    let msg = row.find('[data-testid="event-timeline-msg"]')
    expect(msg.classes().join(' ')).toContain('truncate')
    expect(row.find('[data-testid="event-timeline-meta"]').exists()).toBe(false)
    // 点开:完整换行 + 对象/首次元信息
    await row.trigger('click')
    msg = row.find('[data-testid="event-timeline-msg"]')
    expect(msg.classes().join(' ')).not.toContain('truncate')
    expect(msg.classes().join(' ')).toContain('break-words')
    expect(msg.text()).toContain(MSG_A)
    const meta = row.find('[data-testid="event-timeline-meta"]')
    expect(meta.exists()).toBe(true)
    expect(meta.text()).toContain('Deployment')
    expect(meta.text()).toContain(i18n.global.t('workload.eventsTab.firstSeen'))
    // 再点收起
    await row.trigger('click')
    expect(row.find('[data-testid="event-timeline-msg"]').classes().join(' ')).toContain('truncate')
    expect(row.find('[data-testid="event-timeline-meta"]').exists()).toBe(false)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('Pod 右列事件时间线:watch 重排后展开态跟随事件本身(不漂移)', async () => {
  const spy = mockViewport(false)
  try {
    const { w, qc } = await mountDetail()
    await w.find('[data-testid="event-timeline-row"]').trigger('click')
    reshuffle(qc)
    await flushPromises()
    // 展开态落在 ev-1 那一行(MSG_A),而非重排后占据第 1 行的 ev-3
    const rows = w.findAll('[data-testid="event-timeline-row"]')
    const aRow = rows.find(r => r.text().includes(MSG_A))
    expect(aRow).toBeTruthy()
    expect(aRow.find('[data-testid="event-timeline-meta"]').exists()).toBe(true)
    expect(rows[0].text()).toContain(MSG_C)
    expect(rows[0].find('[data-testid="event-timeline-meta"]').exists()).toBe(false)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})
