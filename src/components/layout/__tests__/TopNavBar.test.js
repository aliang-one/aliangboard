// src/components/layout/__tests__/TopNavBar.test.js
// issue #3 顶栏溢出回归(搜索框收缩链)+ 2026-09-04 顶栏去重:
// 集群/ns 切换器已剃除(上下文归侧栏,集群面板迁 SideNavBar.cluster-switch.test.js),
// 顶栏只留 全局搜索/刷新/身份舷板(+告警铃铛);手机档保留单颗上下文胶囊(Wave 4)。
import { test, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { i18n } from '@/i18n'

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }))

vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/cluster' }), useRouter: () => ({ push: pushMock }) }))

import TopNavBar from '@/components/layout/TopNavBar.vue'
import { useClusterStore } from '@/stores/cluster'
import { useShellStore } from '@/stores/shell'
import { Z } from '@/styles/zScale'

// 搜索查询注入桩:useResourceList 返回的 data 是 ref,按查询 key[2](资源名)分桶,
// 测试用 __seed 逐例注入(与 AlertBell.test.js 同契约教训:getter 桩丢响应性)
vi.mock('@/composables/useK8sQuery', async () => {
  const { ref } = await import('vue')
  const bags = new Map()
  return {
    useResourceList: (opts) => {
      const kind = opts.key[2]
      if (!bags.has(kind)) bags.set(kind, ref([]))
      return { data: bags.get(kind) }
    },
    __seed: (kind, rows) => {
      if (!bags.has(kind)) bags.set(kind, ref([]))
      bags.get(kind).value = rows
    },
    __reset: () => bags.clear(),
  }
})
import { __seed, __reset } from '@/composables/useK8sQuery'

// 统一清场:防 spyOn/mockImplementation 跨文件泄漏(与既有单点 mockRestore 幂等共存);
// body 清场消掉 Teleport 面板跨用例残留(不再依赖 .pop() 取最后一个)
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

function mountNav() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(TopNavBar, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
}

test('收缩链:搜索框包裹层 min-w-0(吸溢出压力);桌面左区无集群/ns chip 包裹层(防复活)', () => {
  setActivePinia(createPinia())
  const w = mountNav()
  const searchWrap = w.find('header div.max-w-xs')
  expect(searchWrap.classes()).toContain('min-w-0')
  expect(w.find('[data-test="cluster-trigger"]').exists()).toBe(false)
  expect(w.find('[data-test="ns-trigger"]').exists()).toBe(false)
})

test('用户名 span truncate+max-w(title 兜底语义保留在 UserMenu)', () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const w = mountNav()
  const logoutBtn = w.findAll('header button').at(-1)
  const userSpan = logoutBtn.findAll('span').find(s => s.classes().includes('truncate'))
  expect(userSpan.classes()).toContain('xl:max-w-[120px]')
})

test('手机档:顶栏左端汉堡可见,点击开抽屉;桌面档无汉堡', async () => {
  const spy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  setActivePinia(createPinia())
  const w = mountNav()
  const btn = w.find('[data-test="menu-trigger"]')
  expect(btn.exists()).toBe(true)
  await btn.trigger('click')
  expect(useShellStore().drawerOpen).toBe(true)
  w.unmount()
  spy.mockRestore()

  const spy2 = vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  setActivePinia(createPinia())
  const w2 = mountNav()
  expect(w2.find('[data-test="menu-trigger"]').exists()).toBe(false)
  w2.unmount()
  spy2.mockRestore()
})

// === 手机档 Wave 4:单颗上下文胶囊 + 选择器 bottom sheet ===
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

function mountTopNav() {
  setActivePinia(createPinia())
  const store = useClusterStore()
  store.savedClusters = [{ name: 'kind-local', apiServer: 'https://k8s.example', version: 'v1.31', distribution: 'k3s' }]
  store.currentCluster = 'kind-local'
  store.currentNamespace = 'default'
  return mountNav()
}

test('手机档:上下文胶囊在场(ns 主/集群副);面板为底部面板', async () => {
  const spy = mockViewport(true)
  const w = await mountTopNav()
  const cap = w.find('[data-test="context-capsule"]')
  expect(cap.exists()).toBe(true)
  // 终审 D:375px 省空间——px-sm + 无 expand_more 尾图标
  expect(cap.classes().join(' ')).toContain('px-sm')
  expect(cap.findAll('.material-symbols-outlined').map(s => s.text())).toEqual(['folder_open'])  // 仅 folder_open,无 expand_more
  expect(cap.text()).toContain('default')            // ns 主文本
  expect(cap.text()).toContain('kind-local')         // 集群副文本
  await cap.trigger('click')
  expect(w.vm.showNsDropdown).toBe(true)
  await flushPromises()
  const panel = Array.from(document.querySelectorAll('[data-testid="ns-dropdown-panel"]')).pop()
  expect(panel.getAttribute('data-bottom-sheet')).toBe('true')
  expect(panel.style.bottom).toBe('0px')
  w.unmount(); spy.mockRestore()
})

test('桌面档:双 chip 已剃(防复活),胶囊不渲染', async () => {
  const spy = mockViewport(false)
  const w = await mountTopNav()
  expect(w.find('[data-test="cluster-trigger"]').exists()).toBe(false)
  expect(w.find('[data-test="ns-trigger"]').exists()).toBe(false)
  expect(w.find('[data-test="context-capsule"]').exists()).toBe(false)
  w.unmount(); spy.mockRestore()
})

test('<lg 档:搜索收成图标触发钮,弹层 Teleport 到 body 且开启时 enabled 查询', async () => {
  const mqSpy = vi.spyOn(window, 'matchMedia').mockImplementation(q => ({ matches: q.includes('1023.98'), media: q, addEventListener() {}, removeEventListener() {} }))
  setActivePinia(createPinia())
  const w = mountNav()
  expect(w.find('[data-test="search-trigger"]').exists()).toBe(true)
  expect(w.find('input[type="text"]').exists()).toBe(false) // 内联输入框不渲染
  await w.find('[data-test="search-trigger"]').trigger('click')
  await flushPromises()
  expect(document.querySelector('[data-test="search-modal"]')).toBeTruthy()
  mqSpy.mockRestore()
})

test('手机档:shell 集群通道不再由顶栏消费(requestClusterSelect 后顶栏无集群面板,归侧栏)', async () => {
  const spy = mockViewport(true)
  const w = await mountTopNav()
  useShellStore().requestClusterSelect()
  await nextTick()
  await nextTick()
  expect(document.querySelector('[data-testid="cluster-dropdown-panel"]')).toBeFalsy()
  w.unmount(); spy.mockRestore()
})

// 手机档 bottom sheet 遮罩独立全屏,Z.popover-1 盖过顶栏/抽屉;点击关闭面板
test('手机档:bottom sheet 遮罩 zIndex=Z.popover-1 全屏,点击关面板', async () => {
  const spy = mockViewport(true)
  const w = await mountTopNav()
  await w.find('[data-test="context-capsule"]').trigger('click')
  await flushPromises()
  const overlay = w.find('[data-test="sheet-overlay"]')
  expect(overlay.exists()).toBe(true)
  expect(overlay.element.style.zIndex).toBe(String(Z.popover - 1))
  await overlay.trigger('click')
  expect(w.vm.showNsDropdown).toBe(false)
  expect(w.find('[data-test="sheet-overlay"]').exists()).toBe(false)
  w.unmount(); spy.mockRestore()
})

test('桌面档:顶栏不再有任何下拉遮罩(切换面板均已离场)', async () => {
  const spy = mockViewport(false)
  const w = await mountTopNav()
  expect(document.querySelector('[data-test="sheet-overlay"]')).toBeFalsy()
  const z30 = w.findAll('div').find(d => d.classes().join(' ') === 'fixed inset-0 z-30')
  expect(z30).toBeFalsy()
  w.unmount(); spy.mockRestore()
})

// === 2026-09-04 顶栏改版:告警铃铛(全局态势感知)===
test('告警铃铛:桌面在场(刷新与身份舷板之间)', async () => {
  const spy = mockViewport(false)
  const w = await mountTopNav()
  expect(w.find('[data-test="alert-bell"]').exists()).toBe(true)
  expect(w.find('[data-test="refresh-btn"]').exists()).toBe(true)
  w.unmount(); spy.mockRestore()
})

test('手机档:铃铛在场,刷新钮让位(375px 像素算术:胶囊 ≥80px 优先,刷新手机低频)', async () => {
  const spy = mockViewport(true)
  const w = await mountTopNav()
  expect(w.find('[data-test="alert-bell"]').exists()).toBe(true)
  expect(w.find('[data-test="refresh-btn"]').exists()).toBe(false)
  w.unmount(); spy.mockRestore()
})

// === 2026-09-04 搜索升级:⌘K + 页面导航 + kinds 扩容 ===
afterEach(() => { __reset() })

test('⌘K/Ctrl+K:桌面聚焦内联搜索框', async () => {
  const spy = mockViewport(false)
  // attachTo:focus() 只在元素挂进 document 时才会改写 activeElement
  setActivePinia(createPinia())
  const store = useClusterStore()
  store.savedClusters = [{ name: 'kind-local', apiServer: 'https://k8s.example', version: 'v1.31', distribution: 'k3s' }]
  store.currentCluster = 'kind-local'
  store.currentNamespace = 'default'
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(TopNavBar, { attachTo: document.body, global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  await nextTick()
  expect(document.activeElement).toBe(w.find('input[type="text"]').element)
  // Ctrl 同款
  ;(w.find('input[type="text"]').element).blur()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  await nextTick()
  expect(document.activeElement).toBe(w.find('input[type="text"]').element)
  // 焦点守卫:焦点在其它可编辑元素(textarea)时 ⌘K 不抢焦点(否则 Modal/编辑器
  // 打开时按键悄悄灌进看不见的顶栏输入框——审查抓回)。
  // 事件必须从 textarea 派发(真实路径 target=可编辑元素,冒泡到 window)
  const ta = document.createElement('textarea')
  document.body.appendChild(ta)
  ta.focus()
  expect(document.activeElement).toBe(ta)
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  await nextTick()
  expect(document.activeElement).toBe(ta)
  ta.remove()
  w.unmount(); spy.mockRestore()
})

test('⌘K:<lg 档打开搜索弹层', async () => {
  const mqSpy = vi.spyOn(window, 'matchMedia').mockImplementation(q => ({ matches: q.includes('1023.98'), media: q, addEventListener() {}, removeEventListener() {} }))
  setActivePinia(createPinia())
  const w = mountNav()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  await flushPromises()
  expect(document.querySelector('[data-test="search-modal"]')).toBeTruthy()
  w.unmount(); mqSpy.mockRestore()
})

test('搜索框带 ⌘K 快捷键提示(kbd)', async () => {
  const spy = mockViewport(false)
  const w = await mountTopNav()
  expect(w.find('[data-test="search-kbd"]').exists()).toBe(true)
  expect(w.find('[data-test="search-kbd"]').text()).toContain('⌘K')
  w.unmount(); spy.mockRestore()
})

test('搜索升级:页面词直达路由(输 monitor 回车 → /monitoring)', async () => {
  const spy = mockViewport(false)
  const w = await mountTopNav()
  const input = w.find('input[type="text"]')
  await input.trigger('focus')
  await input.setValue('monitor')
  await input.trigger('keydown', { key: 'Enter' })
  expect(pushMock).toHaveBeenCalledWith('/monitoring')
  w.unmount(); spy.mockRestore()
})

test('搜索升级:locale 同义词直达(中文「监控」→ /monitoring,同义词表来自 i18n)', async () => {
  const spy = mockViewport(false)
  const { i18n } = await import('@/i18n')
  const prev = i18n.global.locale.value
  i18n.global.locale.value = 'zh'
  try {
    const w = await mountTopNav()
    const input = w.find('input[type="text"]')
    await input.trigger('focus')
    await input.setValue('监控')
    await input.trigger('keydown', { key: 'Enter' })
    expect(pushMock).toHaveBeenCalledWith('/monitoring')
    w.unmount()
  } finally { i18n.global.locale.value = prev }
  spy.mockRestore()
})

test('搜索升级:扩容 kinds 可搜可跳(Role → NsRoleDetail)', async () => {
  const spy = mockViewport(false)
  __seed('roles', [{ name: 'admin-all', namespace: 'web', scope: 'Namespace' }])
  const w = await mountTopNav()
  const input = w.find('input[type="text"]')
  await input.trigger('focus')
  await input.setValue('admin-all')
  await flushPromises()
  const row = w.findAll('[data-test="search-row"]').find(r => r.text().includes('admin-all'))
  expect(row).toBeTruthy()
  await row.trigger('click')
  expect(pushMock).toHaveBeenCalledWith({ name: 'NsRoleDetail', params: { namespace: 'web', name: 'admin-all' } })
  w.unmount(); spy.mockRestore()
})

test('搜索升级:Event 行点击兜底 NsEvents(带 ns)', async () => {
  const spy = mockViewport(false)
  __seed('events', [{ kind: 'Event', name: 'etl-nightly', namespace: 'job', reason: 'BackoffLimitExceeded', relatedKind: 'Job', relatedName: 'etl-nightly' }])
  const w = await mountTopNav()
  const input = w.find('input[type="text"]')
  await input.trigger('focus')
  await input.setValue('etl-nightly')
  await flushPromises()
  const row = w.findAll('[data-test="search-row"]').find(r => r.text().includes('etl-nightly'))
  expect(row).toBeTruthy()
  await row.trigger('click')
  expect(pushMock).toHaveBeenCalledWith({ name: 'NsEvents', params: { namespace: 'job' } })
  w.unmount(); spy.mockRestore()
})
