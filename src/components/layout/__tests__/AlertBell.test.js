// AlertBell:全局告警铃铛(2026-09-04 顶栏改版)。
// 数据 = 既有全局 events 查询(['cluster',cid,'events'],store.fetchEvents)只取 warning 子集;
// 未读 = Headlamp 语义:红点 + 面板内未读加粗,行点击/全部已读显式确认(不自动已读)。
// 跳转 = involvedObject 经 resourceNavigation.routeForResource,无路由兜底 NsEvents。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { i18n } from '@/i18n'

const { pushMock, fetchEventsMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  fetchEventsMock: vi.fn(async () => []),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/cluster' }),
  useRouter: () => ({ push: pushMock }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'prod',
    fetchEvents: fetchEventsMock,
    clusterList: [],
    clusterHealth: { severity: 'ok', reasons: [] },
    getCurrentCluster: () => ({ name: 'prod' }),
  }),
}))
// 真实契约:useResourceList 返回的 data 是 ref(非响应性普通对象——getter 桩会让
// computed 失去追踪,红点永不刷新)。工厂内建 ref 并导出,测试逐例注入。
vi.mock('@/composables/useK8sQuery', () => {
  const data = ref(null)
  return { useResourceList: () => ({ data }), __eventsData: data }
})

import AlertBell from '@/components/layout/AlertBell.vue'
import { __eventsData } from '@/composables/useK8sQuery'

const W = (uid, reason, extra = {}) => ({ uid, type: 'warning', reason, message: 'msg', namespace: 'api', relatedKind: 'Job', relatedName: 'etl-nightly', relatedNamespace: 'api', age: '5m', count: 1, icon: 'error', color: 'text-error', _ts: 1, ...extra })

beforeEach(() => { localStorage.clear(); pushMock.mockClear(); fetchEventsMock.mockClear(); __eventsData.value = [] })
afterEach(() => { document.body.innerHTML = '' })

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
