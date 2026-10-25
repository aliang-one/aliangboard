// 无集群态侧边栏简化(2026-09-08 round-3):从选择页「免集群通道」进入工作台后,
// 无 K8s session——集群域控件(集群管理节/NAMESPACE 带/底部活动设置)全是「点击即被
// 守卫弹回选择页」的陷阱。此态整节隐藏,只留头部 + CTA 卡两个「返回选择」入口。
// 信号与 _nsEnabled 同源:getSession()。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const { pushMock, _session } = vi.hoisted(() => ({ pushMock: vi.fn(), _session: { v: '' } }))

vi.mock('@/api/client', () => ({ getSession: () => _session.v }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    cluster: { name: '', version: '' },
    currentNamespace: '',
    setNamespace: vi.fn(),
    namespaceList: [],
    fetchNamespaces: vi.fn(),
    currentCluster: '',
    clusterList: [],
    clusterHealth: null,
  }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false }) }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ meta: { scope: 'global' }, fullPath: '/workbench', path: '/workbench', params: {} }),
  useRouter: () => ({ push: pushMock }),
}))

import SideNavBar from '@/components/layout/SideNavBar.vue'

beforeEach(() => { setActivePinia(createPinia()); pushMock.mockClear() })
afterEach(() => { document.body.innerHTML = '' })

function mountNav() { return mount(SideNavBar, { global: { plugins: [i18n] } }) }

test('无 session:集群域控件整节隐藏(ns 带/集群管理节/底部活动设置)', () => {
  _session.v = ''
  const w = mountNav()
  expect(w.find('[data-test="ns-home"]').exists()).toBe(false)
  expect(w.find('[data-test="cluster-nav-section"]').exists()).toBe(false)
  expect(w.find('[data-test="bottom-activity"]').exists()).toBe(false)
  expect(w.find('[data-test="bottom-settings"]').exists()).toBe(false)
})

test('无 session:唯一显式入口 CTA 卡渲染,点击 push /select-cluster', async () => {
  _session.v = ''
  const w = mountNav()
  const cta = w.find('[data-test="sidenav-select-cluster"]')
  expect(cta.exists()).toBe(true)
  expect(cta.text()).toContain('选择集群')
  await cta.trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/select-cluster')
})

test('无 session:头部为「未连接集群」态(不弹切换面板),点击回选择页', async () => {
  _session.v = ''
  const w = mountNav()
  expect(w.find('[data-test="cluster-brand"]').exists()).toBe(false)
  const h = w.find('[data-test="cluster-brand-nocluster"]')
  expect(h.exists()).toBe(true)
  expect(h.text()).toContain('未连接集群')
  await h.trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/select-cluster')
})

test('有 session(回归):集群域控件照旧,CTA 与未连接头部不出现', () => {
  _session.v = 'k8s-token'
  const w = mountNav()
  expect(w.find('[data-test="cluster-nav-section"]').exists()).toBe(true)
  expect(w.find('[data-test="ns-home"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-activity"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-settings"]').exists()).toBe(true)
  expect(w.find('[data-test="cluster-brand"]').exists()).toBe(true)
  expect(w.find('[data-test="sidenav-select-cluster"]').exists()).toBe(false)
  expect(w.find('[data-test="cluster-brand-nocluster"]').exists()).toBe(false)
})
