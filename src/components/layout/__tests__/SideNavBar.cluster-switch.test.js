// 集群切换迁侧栏(2026-09-04 顶栏去重设计):集群头部成为全断点唯一的集群切换锚点。
// 桌面/rail:点头部 → Teleport 锚定面板;手机抽屉:点头部发 shell 通道 → bottom sheet
// (通道消费方自 TopNavBar 迁来,store 契约 requestClusterSelect/clusterSelectTick 不变)。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const { _routeObj, pushMock, _store } = vi.hoisted(() => ({
  _routeObj: { meta: { scope: 'global' }, fullPath: '/cluster', path: '/cluster', params: {} },
  pushMock: vi.fn(),
  _store: {
    cluster: { name: 'prod-cluster', version: 'v1.28.2', apiServer: 'https://prod.example' },
    currentNamespace: 'default',
    setNamespace: vi.fn(),
    namespaceList: [],
    fetchNamespaces: vi.fn(),
    currentCluster: 'prod-cluster',
    clusterList: [
      { name: 'prod-cluster', apiServer: 'https://prod.example', version: 'v1.28.2', status: 'Healthy', distribution: 'k3s' },
      { name: 'staging', apiServer: 'https://staging.example', version: 'v1.30.1', status: 'Degraded', distribution: 'Kubernetes' },
    ],
    clusterHealth: { severity: 'ok', reasons: [] },
    switchCluster: vi.fn(async () => {}),
  },
}))
const routeRef = reactive(_routeObj)
const storeMock = reactive(_store)

vi.mock('vue-router', () => ({
  useRoute: () => routeRef,
  useRouter: () => ({ push: pushMock }),
  RouterLink: { template: '<a><slot/></a>' },
  RouterView: { template: '<div></div>' },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => storeMock }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false, init: vi.fn(), user: null }) }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: storeMock.namespaceList }, isFetching: { value: false }, refetch: vi.fn() }),
}))

import SideNavBar from '@/components/layout/SideNavBar.vue'
import { useShellStore } from '@/stores/shell'
import { Z } from '@/styles/zScale'

let matchMediaSpy
function mockViewport(belowSm, belowLg) {
  matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)' ? belowSm : q === '(max-width: 1023.98px)' ? belowLg : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { matchMediaSpy?.mockRestore(); document.body.innerHTML = ''; storeMock.switchCluster.mockClear(); pushMock.mockClear() })

function mountNav() {
  return mount(SideNavBar, { global: { plugins: [i18n] } })
}
const panelEl = () => document.querySelector('[data-testid="cluster-dropdown-panel"]')

test('桌面:点集群头部弹 Teleport 锚定面板;z-30 遮罩点击关闭', async () => {
  mockViewport(false, false)
  const w = mountNav()
  const brand = w.find('[data-test="cluster-brand"]')
  expect(brand.exists()).toBe(true)
  expect(brand.attributes('role')).toBe('button')       // 桌面也变为可点(旧「纯展示」契约废除)
  expect(brand.attributes('aria-expanded')).toBe('false')
  await brand.trigger('click')
  await flushPromises()
  expect(panelEl()).toBeTruthy()
  expect(panelEl().style.position).toBe('fixed')
  expect(brand.attributes('aria-expanded')).toBe('true')
  const overlay = w.find('[data-test="cluster-panel-overlay"]')
  expect(overlay.exists()).toBe(true)
  await overlay.trigger('click')
  await flushPromises()
  expect(panelEl()).toBeFalsy()
  w.unmount()
})

test('桌面:点集群行 switchCluster(apiServer) 且面板关;管理全部 → /clusters', async () => {
  mockViewport(false, false)
  const w = mountNav()
  await w.find('[data-test="cluster-brand"]').trigger('click')
  await flushPromises()
  document.querySelectorAll('[data-test="cluster-row"]')[1].click()
  await flushPromises()
  expect(storeMock.switchCluster).toHaveBeenCalledWith('https://staging.example')
  expect(panelEl()).toBeFalsy()
  // 管理全部
  await w.find('[data-test="cluster-brand"]').trigger('click')
  await flushPromises()
  document.querySelector('[data-test="manage-all"]').click()
  await flushPromises()
  expect(pushMock).toHaveBeenCalledWith('/clusters')
  expect(panelEl()).toBeFalsy()
  w.unmount()
})

test('桌面:点当前集群行不重复 switchCluster,面板仍关闭', async () => {
  mockViewport(false, false)
  const w = mountNav()
  await w.find('[data-test="cluster-brand"]').trigger('click')
  await flushPromises()
  document.querySelectorAll('[data-test="cluster-row"]')[0].click()
  await flushPromises()
  expect(storeMock.switchCluster).not.toHaveBeenCalled()
  expect(panelEl()).toBeFalsy()
  w.unmount()
})

test('手机抽屉:点集群头部发 shell 通道(tick+1)且弹 bottom sheet 面板', async () => {
  mockViewport(true, true)
  const w = mountNav()
  const shell = useShellStore()
  const before = shell.clusterSelectTick
  await w.find('[data-test="cluster-brand"]').trigger('click')
  await flushPromises()
  expect(shell.clusterSelectTick).toBe(before + 1)
  expect(panelEl()).toBeTruthy()
  expect(panelEl().getAttribute('data-bottom-sheet')).toBe('true')
  expect(panelEl().style.bottom).toBe('0px')
  // sheet 遮罩独立全屏 Z.popover-1(盖过抽屉 55,被面板 110 盖)
  const overlay = w.find('[data-test="cluster-sheet-overlay"]')
  expect(overlay.exists()).toBe(true)
  expect(overlay.element.style.zIndex).toBe(String(Z.popover - 1))
  await overlay.trigger('click')
  await flushPromises()
  expect(panelEl()).toBeFalsy()
  w.unmount()
})

test('手机抽屉:shell.requestClusterSelect 直接请求 → 面板打开(消费方已迁至侧栏)', async () => {
  mockViewport(true, true)
  const w = mountNav()
  useShellStore().requestClusterSelect()
  await nextTick()
  await nextTick()
  expect(panelEl()).toBeTruthy()
  expect(panelEl().getAttribute('data-bottom-sheet')).toBe('true')
  w.unmount()
})

test('rail 档(<lg 非 <sm):点头部图标弹锚定面板(非 sheet)', async () => {
  mockViewport(false, true)
  const w = mountNav()
  await w.find('[data-test="cluster-brand"]').trigger('click')
  await flushPromises()
  expect(panelEl()).toBeTruthy()
  expect(panelEl().getAttribute('data-bottom-sheet')).toBe('false')
  w.unmount()
})
