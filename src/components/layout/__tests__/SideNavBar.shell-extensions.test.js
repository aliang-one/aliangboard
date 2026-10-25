// 顶栏退役 Task 7:SideNavBar 装配后的壳扩展段契约——
//  - 无集群态:头像行+工作台段+搜索段恒显(登出/个人中心/工作台无集群必须可达),集群域控件隐藏;
//  - 工作台段点击跳 /workbench;
//  - 集群态底部行:活动/告警/设置三颗在场;告警颗 belowSm 互斥钉在源码(手机抽屉内不渲染,
//    由 footer 侧承担——RF1,v-if 与 AppLayout footer 的 belowSm v-if 语义互补);
//  - ns 态 dock:告警以 tile 瓦片形态入 4 列网格(bottom-alerts);
//  - rail 折叠可达性:头像行文本容器挂 sb-user-txt(rail 折叠隐藏,头像图标保留)。
// 骨架取自 SideNavBar.bottom-row.test.js(cluster/auth/useK8sQuery/vue-router mock + sessionStorage
// 会话);四新段为真实子组件(useI18n/useQuery 消费者),mount 需真实 i18n + VueQueryPlugin。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { i18n } from '@/i18n'
import { readFileSync } from 'node:fs'

const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn() }))
let currentNs = 'default'

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentNamespace: currentNs,
    namespaceList: [],
    currentCluster: 'demo',
    cluster: { name: 'test', version: 'v1' },
    setNamespace: vi.fn(),
    fetchNamespaces: vi.fn(),
  }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false }) }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/ns/default', params: { namespace: currentNs }, name: 'NamespaceOverview', meta: { scope: currentNs ? 'namespace' : 'global' } }),
  useRouter: () => ({ push: pushSpy }),
}))
// 头像行(UserMenu)挂载即拉 getAvatar:桩掉防真实 fetch 噪音;getSession 保持真实(sessionStorage 驱动)
vi.mock('@/api/client', async (importOriginal) => {
  const orig = await importOriginal()
  return { ...orig, authApi: { ...orig.authApi, getAvatar: vi.fn(async () => null) } }
})

import SideNavBar from '../SideNavBar.vue'

beforeEach(() => {
  sessionStorage.setItem('aliangboard.session', 'test-session') // 有集群行为默认态;无集群用例自行移除
  localStorage.clear()
})
const mountIt = () => mount(SideNavBar, {
  global: {
    plugins: [createPinia(), i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]],
  },
})

// 无集群态:头像行恒显(登出可达,Review Focus 2);工作台段恒显
test('无集群态:头像行+工作台段仍在,集群域控件隐藏', () => {
  sessionStorage.removeItem('aliangboard.session')
  currentNs = ''
  const w = mountIt()
  expect(w.find('[data-testid="user-menu-trigger"]').exists()).toBe(true)
  expect(w.find('[data-test="wb-nav-item"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-settings"]').exists()).toBe(false) // 底部行仍门控
  w.unmount()
})

test('工作台段:点击跳 /workbench', async () => {
  currentNs = ''
  const w = mountIt()
  await w.find('[data-test="wb-nav-item"]').trigger('click')
  expect(pushSpy).toHaveBeenCalledWith('/workbench')
  w.unmount()
})

test('集群态底部行:活动/告警/设置三颗在场;告警颗源码级 belowSm 互斥(RF1)', () => {
  currentNs = ''
  const w = mountIt()
  expect(w.find('[data-test="bottom-activity"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-alerts-row"]').exists()).toBe(true)
  // 互斥钉在源码:侧栏告警颗 !belowSm(手机抽屉内不渲染),footer 侧 v-if="belowSm"(Task 8)
  const src = readFileSync('./src/components/layout/SideNavBar.vue', 'utf8')
  expect(src).toMatch(/v-if="!belowSm"[\s\S]{0,120}<AlertBell/)
  w.unmount()
})

test('ns 态 dock:告警瓦片在场(bottom-alerts,tile 形态)', () => {
  currentNs = 'default'
  const w = mountIt()
  expect(w.find('[data-test="bottom-alerts"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-alerts"]').classes()).toContain('dock-ig')
  w.unmount()
})

test('搜索段/头像行/工作台段的 rail 折叠可达性(RF5,静态类断言)', () => {
  currentNs = ''
  const w = mountIt()
  expect(w.find('[data-test="sidenav-search"]').exists()).toBe(true)
  // 头像行文本容器挂 sb-user-txt(rail 折叠隐藏,头像图标保留)
  expect(w.find('.sb-user-txt').exists()).toBe(true)
  w.unmount()
})
