// AlertBell:全局告警铃铛(2026-09-04 顶栏改版)。
// 数据 = 既有全局 events 查询(['cluster',cid,'events'],store.fetchEvents)只取 warning 子集;
// 未读 = Headlamp 语义:红点 + 面板内未读加粗,行点击/全部已读显式确认(不自动已读)。
// 跳转 = involvedObject 经 resourceNavigation.routeForResource,无路由兜底 NsEvents。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, reactive } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { i18n } from '@/i18n'

const { pushMock, fetchEventsMock, _routeObj, storeMock } = await vi.hoisted(async () => {
  const { reactive } = await import('vue')
  return {
    pushMock: vi.fn(),
    fetchEventsMock: vi.fn(async () => []),
    _routeObj: { path: '/cluster', fullPath: '/cluster', params: {} },
    storeMock: reactive({
      currentCluster: 'prod',
      fetchEvents: vi.fn(async () => []),
      fetchClusterCerts: vi.fn(async () => null),
      clusterList: [],
      clusterHealth: { severity: 'ok', reasons: [] },
      eventWatchLive: false,
    }),
  }
})
const routeRef = reactive(_routeObj)

vi.mock('vue-router', () => ({
  useRoute: () => routeRef,
  useRouter: () => ({ push: pushMock }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => storeMock,
}))
// 真实契约:useResourceList 返回的 data 是 ref(非响应性普通对象——getter 桩会让
// computed 失去追踪,红点永不刷新)。工厂内建 ref 并导出,测试逐例注入;
// 按查询第三键分流 events/certs(2026-09-06 证书告警共用铃铛);
// capturedOpts 仍只记 events 查询(既有轮询门控断言不动)。
vi.mock('@/composables/useK8sQuery', () => {
  const eventsData = ref(null)
  const certsData = ref(null)
  const capturedOpts = {}
  return {
    useResourceList: (opts) => {
      if (opts.key[2] === 'events') capturedOpts.value = opts
      return { data: opts.key[2] === 'certs' ? certsData : eventsData }
    },
    __eventsData: eventsData,
    __certsData: certsData,
    __queryOpts: capturedOpts,
  }
})
import AlertBell from '@/components/layout/AlertBell.vue'
import { __eventsData, __certsData, __queryOpts } from '@/composables/useK8sQuery'
import { Z } from '@/styles/zScale'

// color 用 eventIconColor 的真实产出(裸 token,非 tailwind 类)——上一版夹具
// 伪造成 'text-error' 恰好把「裸 token 直绑 class 是死代码」的真 bug 盖住了
const W = (uid, reason, extra = {}) => ({ uid, type: 'warning', reason, message: 'msg', namespace: 'api', relatedKind: 'Job', relatedName: 'etl-nightly', relatedNamespace: 'api', age: '5m', count: 1, icon: 'error', color: 'error', _ts: 1, ...extra })

beforeEach(() => { localStorage.clear(); pushMock.mockClear(); fetchEventsMock.mockClear(); __eventsData.value = []; __certsData.value = null; storeMock.eventWatchLive = false; storeMock.fetchEvents = fetchEventsMock })
afterEach(() => { document.body.innerHTML = ''; routeRef.path = '/cluster'; routeRef.fullPath = '/cluster' })

function mountBell() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(AlertBell, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
}
const panel = () => document.querySelector('[data-testid="alert-panel"]')

test('无未读:铃铛在场无红点;有 warning 未读:红点亮', async () => {
  __eventsData.value = [{ ...W('n1', 'Pulled'), type: 'normal' }]
  const w = mountBell()
  await flushPromises()
  expect(w.find('[data-test="alert-bell"]').exists()).toBe(true)
  expect(w.find('[data-test="alert-dot"]').exists()).toBe(false)

  __eventsData.value = [W('u1', 'BackoffLimitExceeded'), { ...W('n1', 'Pulled'), type: 'normal' }]
  await flushPromises()
  expect(w.find('[data-test="alert-dot"]').exists()).toBe(true)
  w.unmount()
})

test('点击铃铛弹 Teleport 面板:只列 warning(reason/资源/ns/时间),normal 不进列表', async () => {
  __eventsData.value = [W('u1', 'BackoffLimitExceeded'), { ...W('n1', 'Pulled'), type: 'normal' }, W('u2', 'NodeNotReady', { relatedKind: 'Node', relatedName: 'worker-2', namespace: '', relatedNamespace: '', age: '12m' })]
  const w = mountBell()
  await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click')
  await flushPromises()
  expect(panel()).toBeTruthy()
  const rows = panel().querySelectorAll('[data-test="alert-row"]')
  expect(rows).toHaveLength(2)
  expect(panel().textContent).toContain('BackoffLimitExceeded')
  expect(panel().textContent).toContain('etl-nightly')
  expect(panel().textContent).toContain('NodeNotReady')
  expect(panel().textContent).not.toContain('Pulled')
  // 未读加粗(Headlamp unseen 语义)
  const unreadRows = [...rows].filter(r => [...r.classList].includes('alert-row--unread'))
  expect(unreadRows).toHaveLength(2)
  w.unmount()
})

test('行点击:该行标记已读 + 跳 involvedObject 详情(Job → NsWorkloadDetail)', async () => {
  localStorage.setItem('ab.alertsRead.prod', JSON.stringify([]))
  __eventsData.value = [W('u1', 'BackoffLimitExceeded')]
  const w = mountBell()
  await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click')
  await flushPromises()
  panel().querySelector('[data-test="alert-row"]').click()
  await flushPromises()
  expect(pushMock).toHaveBeenCalledWith({ name: 'NsWorkloadDetail', params: { namespace: 'api', type: 'job', name: 'etl-nightly' } })
  expect(JSON.parse(localStorage.getItem('ab.alertsRead.prod'))).toContain('u1')
  w.unmount()
})

test('全部已读:一键清零,红点消失,localStorage 落账', async () => {
  __eventsData.value = [W('u1', 'BackoffLimitExceeded'), W('u2', 'NodeNotReady', { relatedKind: 'Node', relatedName: 'worker-2', namespace: '' })]
  const w = mountBell()
  await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click')
  await flushPromises()
  document.querySelector('[data-test="alert-mark-read"]').click()
  await flushPromises()
  expect(JSON.parse(localStorage.getItem('ab.alertsRead.prod'))).toEqual(expect.arrayContaining(['u1', 'u2']))
  expect(w.find('[data-test="alert-dot"]').exists()).toBe(false)
  // 面板行不再有未读加粗
  const rows = panel().querySelectorAll('[data-test="alert-row"]')
  expect([...rows].filter(r => [...r.classList].includes('alert-row--unread'))).toHaveLength(0)
  w.unmount()
})

test('无路由 kind 兜底:有 ns 跳 NsEvents,无 ns 跳 /monitoring', async () => {
  __eventsData.value = [
    W('u1', 'FailedScheduling', { relatedKind: 'ReplicaSet', relatedName: 'rs-1' }),
    W('u2', 'SystemEvent', { relatedKind: 'Unknown', relatedName: 'x', namespace: '', relatedNamespace: '' }),
  ]
  const w = mountBell()
  await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click')
  await flushPromises()
  const rows = panel().querySelectorAll('[data-test="alert-row"]')
  rows[0].click(); await flushPromises()
  expect(pushMock).toHaveBeenLastCalledWith({ name: 'NsEvents', params: { namespace: 'api' } })
  rows[1].click(); await flushPromises()
  expect(pushMock).toHaveBeenLastCalledWith('/monitoring')
  w.unmount()
})

test('空态:无 warning 时面板显示空态文本', async () => {
  __eventsData.value = [{ ...W('n1', 'Pulled'), type: 'normal' }]
  const w = mountBell()
  await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click')
  await flushPromises()
  expect(panel().querySelector('[data-test="alert-empty"]')).toBeTruthy()
  w.unmount()
})

test('查询无数据(null)不炸:无红点、面板空态', async () => {
  __eventsData.value = null
  const w = mountBell()
  await flushPromises()
  expect(w.find('[data-test="alert-dot"]').exists()).toBe(false)
  await w.find('[data-test="alert-bell"]').trigger('click')
  await flushPromises()
  expect(panel().querySelector('[data-test="alert-empty"]')).toBeTruthy()
  w.unmount()
})

test('面板遮罩点击关闭;重开保留未读状态语义', async () => {
  __eventsData.value = [W('u1', 'BackoffLimitExceeded')]
  const w = mountBell()
  await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click')
  await flushPromises()
  await w.find('[data-test="alert-overlay"]').trigger('click')
  await flushPromises()
  expect(panel()).toBeFalsy()
  // 未读未确认 → 红点仍在
  expect(w.find('[data-test="alert-dot"]').exists()).toBe(true)
  w.unmount()
})


test('行图标按 eventIconColor 裸 token 映射成色类(token 直绑 class 是死代码)', async () => {
  __eventsData.value = [W('u1', 'BackoffLimitExceeded'), W('u2', 'NodeNotReady', { relatedKind: 'Node', relatedName: 'worker-2', namespace: '', color: 'tertiary', icon: 'warning' })]
  const w = mountBell()
  await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click')
  await flushPromises()
  const rowIcons = panel().querySelectorAll('[data-test="alert-row"] .material-symbols-outlined')
  expect([...rowIcons[0].classList]).toContain('text-error')          // error → text-error
  expect([...rowIcons[1].classList]).toContain('text-tertiary')       // warning → text-tertiary
  w.unmount()
})

test('轮询门控:eventWatchLive(watch 流活跃)→ 停自轮询;不活跃 → 60s', async () => {
  __eventsData.value = []
  const w = mountBell()
  await flushPromises()
  const interval = __queryOpts.value.options.refetchInterval
  expect(interval.value).toBe(60000)
  storeMock.eventWatchLive = true
  await nextTickX2()
  expect(interval.value).toBe(false)
  w.unmount()
  async function nextTickX2() { const { nextTick } = await import('vue'); await nextTick(); await nextTick() }
})

test('面板遮罩盖过侧栏(Z.popover-1);路由变化自动关面板', async () => {
  __eventsData.value = [W('u1', 'BackoffLimitExceeded')]
  const w = mountBell()
  await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-test="alert-overlay"]').element.style.zIndex).toBe(String(Z.popover - 1))
  routeRef.fullPath = '/nodes'
  routeRef.path = '/nodes'
  await flushPromises()
  expect(panel()).toBeFalsy()
  w.unmount()
})

// ---- 证书到期告警合并(2026-09-06 证书可观测)----
const CERT_REPORT = { secrets: { items: [
  { name: 'tls-web', namespace: 'api', daysLeft: 12, fingerprint256: 'AA:BB' },
  { name: 'tls-dead', namespace: 'api', daysLeft: -3, fingerprint256: 'CC:DD' },
  { name: 'tls-far', namespace: 'api', daysLeft: 200, fingerprint256: 'EE:FF' },
], error: null } }

test('证书告警合并:≤30d/过期进面板(200d 不进),全部已读落 uid 稳定账目', async () => {
  __eventsData.value = [W('u1', 'BackoffLimitExceeded')]
  __certsData.value = CERT_REPORT
  const w = mountBell(); await flushPromises()
  expect(w.find('[data-test="alert-dot"]').exists()).toBe(true)
  await w.find('[data-test="alert-bell"]').trigger('click'); await flushPromises()
  const rows = panel().querySelectorAll('[data-test="alert-row"]')
  expect(rows).toHaveLength(3) // 1 event + 2 cert(12d warn + -3d expired)
  expect(panel().textContent).toContain('tls-web')
  expect(panel().textContent).not.toContain('tls-far')
  document.querySelector('[data-test="alert-mark-read"]').click(); await flushPromises()
  const saved = JSON.parse(localStorage.getItem('ab.alertsRead.prod'))
  expect(saved).toContain('cert:AA:BB')
  expect(saved).toContain('cert:CC:DD')
  w.unmount()
})

test('证书行点击 → ClusterCerts 页;伪事件图标 key', async () => {
  __certsData.value = CERT_REPORT
  const w = mountBell(); await flushPromises()
  await w.find('[data-test="alert-bell"]').trigger('click'); await flushPromises()
  const icons = panel().querySelectorAll('[data-test="alert-row"] .material-symbols-outlined')
  expect(icons[0].textContent.trim()).toBe('key') // 先验图标(点击会关面板)
  const rows = panel().querySelectorAll('[data-test="alert-row"]')
  rows[0].click(); await flushPromises() // 无 events 时 cert 排最前
  expect(pushMock).toHaveBeenCalledWith({ name: 'ClusterCerts' })
  w.unmount()
})
