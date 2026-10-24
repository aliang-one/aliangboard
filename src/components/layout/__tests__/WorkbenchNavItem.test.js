// 工作台侧栏入口行(2026-10-23 顶栏退役·导航单源收敛 Task 5,自 WorkbenchEntryPill 迁入):
// ① 行契约(nav-item 类/激活 primary-container/瓷砖 workspaces);② 待审批红数角标(全断点通用,
// 旧胶囊的三徽章优先级链/手机红点退役);③ summary 数据驱动 title 摘要;④ 悬停面板
// (150ms 开/200ms 宽限/Escape/外点/项目行跳转,useDropdownPanel 定位);⑤ 手机档整链禁开面板。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

const mocks = vi.hoisted(() => ({ summary: vi.fn(), push: vi.fn(), path: '/cluster' }))
vi.mock('@/api/client', () => ({
  workbenchApi: { summary: mocks.summary },
  getPlatformToken: () => 'tok',   // I1:enabled 走平台登录态(非 K8s session)
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: mocks.path }),
  useRouter: () => ({ push: mocks.push }),
}))
const toast = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('@/composables/useToast.js', () => ({ notify: toast.notify }))

import WorkbenchNavItem from '../WorkbenchNavItem.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) } })
const mountItem = () => mount(WorkbenchNavItem, {
  global: { plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] },
})

const SUMMARY = (over = {}) => ({
  projects: [{ id: 'p1', name: 'ci-cd', clusterId: 'c1', clusterName: 'prod', lastActiveAt: Date.now(), runningConvs: 0, pendingApprovals: 0 }],
  totals: { projects: 1, runningConvs: 0, pendingApprovals: 0, sshSessions: 0 }, ...over,
})

beforeEach(() => { mocks.summary.mockReset(); mocks.push.mockReset(); mocks.path = '/cluster' })

// ===== 行契约(Task 5 新形态;brief 逐字)=====
test('行契约:nav-item 类 + 激活态 primary-container + 瓷砖 workspaces', async () => {
  mocks.summary.mockReturnValue(new Promise(() => {}))
  const w = mountItem(); await flushPromises()
  const row = w.find('[data-test="wb-nav-item"]')
  expect(row.attributes('aria-label')).toBe('工作台')
  expect(row.classes()).toContain('nav-item')
  expect(row.classes()).not.toContain('bg-primary-container')   // 非激活
  expect(row.find('.material-symbols-outlined').text()).toBe('workspaces')
  mocks.path = '/workbench'
  const w2 = mountItem(); await flushPromises()
  expect(w2.find('[data-test="wb-nav-item"]').classes()).toContain('bg-primary-container')
  w.unmount(); w2.unmount()
})

test('待审批红数角标:pendingApprovals>0 显示数字', async () => {
  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 1, runningConvs: 0, pendingApprovals: 3, sshSessions: 0 } }))
  const w = mountItem(); await flushPromises()
  expect(w.find('[data-test="wb-nav-pending"]').text()).toBe('3')
  w.unmount()
})

test('悬停面板:项目行点击跳 /workbench/p1(≥lg)', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  // brief 骨架此处无 flush:同步 advanceTimersByTime 不排 Vue 渲染微任务,面板恒 null(且断言
  // 中止会连坐泄漏假钟/挂载件污染后续用例)——按底本全文件「advance + flushPromises」配方补齐
  vi.advanceTimersByTime(200); await flushPromises()
  const panel = document.body.querySelector('[data-test="wb-panel"]')
  expect(panel).toBeTruthy()
  panel.querySelector('[data-test="panel-project"]').click()
  await vi.runOnlyPendingTimersAsync()
  expect(mocks.push).toHaveBeenCalledWith('/workbench/p1')
  vi.useRealTimers()
  w.unmount()
})

test('点击直达 /workbench(行为不变)', async () => {
  mocks.summary.mockReturnValue(new Promise(() => {}))
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('click')
  expect(mocks.push).toHaveBeenCalledWith('/workbench')
})

// 旧胶囊手机档藏文本(<template v-if="!isPhone">)退役:行 label 常驻
test('行文本常驻:手机档 label 仍在场(旧胶囊手机档藏文本的形态退役)', async () => {
  const spy = mockViewport(true)
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountItem(); await flushPromises()
  expect(w.find('[data-test="wb-nav-item"]').text()).toContain('工作台')
  expect(w.find('[data-test="wb-nav-pending"]').exists()).toBe(false)   // 归零不渲染角标
  w.unmount(); spy.mockRestore()
})

// ===== 品牌瓷砖(自胶囊原样迁入)=====
test('品牌瓷砖:workspaces 图标装进 primary→primary-container 渐变圆角瓷砖(平台双绿,无橘调和色;on-primary 图标亮暗自翻转),桌面/手机档都在场', async () => {
  mocks.summary.mockReturnValue(new Promise(() => {}))
  let w = mountItem(); await flushPromises()
  const tile = w.find('[data-test="wb-nav-tile"]')
  expect(tile.exists()).toBe(true)
  const cls = tile.classes()
  expect(cls).toContain('bg-gradient-to-br')
  expect(cls).toContain('from-primary')
  expect(cls).toContain('to-primary-container')
  expect(cls).not.toContain('to-tertiary')
  const icon = tile.find('.material-symbols-outlined')
  expect(icon.text()).toBe('workspaces')
  expect(icon.classes()).toContain('text-on-primary')
  w.unmount()
  const spy = mockViewport(true)
  w = mountItem(); await flushPromises()
  expect(w.find('[data-test="wb-nav-tile"]').exists()).toBe(true)
  w.unmount(); spy.mockRestore()
})

test('sheen 高光扫过:仅 /workbench* 在场,必带 bg-no-repeat(repeat 会把 200% 白带绕回瓷砖常驻洗白)与 motion-reduce:hidden(animate-none 会定格在 0% 洗白帧)', async () => {
  mocks.summary.mockReturnValue(new Promise(() => {}))
  let w = mountItem(); await flushPromises()
  expect(w.find('[data-test="wb-nav-sheen"]').exists()).toBe(false)   // idle 无 sheen
  w.unmount()
  mocks.path = '/workbench/p1'
  w = mountItem(); await flushPromises()
  const sheen = w.find('[data-test="wb-nav-sheen"]')
  expect(sheen.exists()).toBe(true)
  expect(sheen.classes()).toContain('animate-sheen')
  expect(sheen.classes()).toContain('bg-no-repeat')
  expect(sheen.classes()).toContain('motion-reduce:hidden')
  expect(sheen.classes()).not.toContain('motion-reduce:animate-none')
  w.unmount()
})

test('title 摘要由 summary 拼装', async () => {
  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 5, runningConvs: 1, pendingApprovals: 2, sshSessions: 3 } }))
  const w = mountItem(); await flushPromises()
  const title = w.find('[data-test="wb-nav-item"]').attributes('title')
  expect(title).toContain('5 项目')
  expect(title).toContain('1 运行中')
  expect(title).toContain('2 待审批')
  expect(title).toContain('3 SSH')
})

// ===== 手机档:整链禁开面板 =====
// 终审 A:触屏 tap 合成 mouseenter 会让悬停面板在跳转 /workbench 后残留新页(touch 无
// mouseleave 关不掉)——手机档 mouseenter 整链禁开
test('手机档:mouseenter 不开悬停面板(触屏 tap 泄漏防线)', async () => {
  const spy = mockViewport(true)
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(500); await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()
  vi.useRealTimers()
  w.unmount(); spy.mockRestore()
})

// ===== 悬停面板(自胶囊原样迁入;定位改 useDropdownPanel)=====
test('悬停 150ms 开面板;面板含汇总 chips 与项目行', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY({
    projects: [{ id: 'p1', name: 'ci-cd', clusterId: 'c1', clusterName: 'prod', lastActiveAt: Date.now() - 120_000, runningConvs: 1, pendingApprovals: 2 }],
    totals: { projects: 1, runningConvs: 1, pendingApprovals: 2, sshSessions: 0 },
  }))
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()   // 未到延迟
  vi.advanceTimersByTime(150); await flushPromises()
  const panel = document.body.querySelector('[data-test="wb-panel"]')
  expect(panel).toBeTruthy()
  expect(panel.textContent).toContain('ci-cd')
  expect(panel.textContent).toContain('prod')
  expect(panel.textContent).toContain('2 待审')            // pendingChip
  expect(panel.textContent).toContain('2 分钟前')           // relTime
  vi.useRealTimers()
  w.unmount()
})

test('未绑定行显示未绑定徽章;行点击跳项目并关面板', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY({
    projects: [{ id: 'p9', name: 'free', clusterId: '', clusterName: null, lastActiveAt: null, runningConvs: 0, pendingApprovals: 0 }],
    totals: { projects: 1, runningConvs: 0, pendingApprovals: 0, sshSessions: 0 },
  }))
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]').textContent).toContain('未绑定集群')
  document.body.querySelector('[data-test="panel-project"]').click()      // Teleport:查 body
  expect(mocks.push).toHaveBeenCalledWith('/workbench/p9')
  await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()
  vi.useRealTimers()
  w.unmount()
})

test('快捷区三键落点正确', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  const panel = document.body.querySelector('[data-test="wb-panel"]')
  const btnByText = txt => [...panel.querySelectorAll('button')].find(b => b.textContent.includes(txt))
  btnByText('新建项目').click(); expect(mocks.push).toHaveBeenLastCalledWith('/workbench?create=1')
  btnByText('集群台账').click(); expect(mocks.push).toHaveBeenLastCalledWith('/workbench/ledger')
  btnByText('记录').click(); expect(mocks.push).toHaveBeenLastCalledWith('/workbench?tab=records')
  vi.useRealTimers()
  w.unmount()
})

test('Escape 与点击外部关面板', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeTruthy()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()

  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  document.body.dispatchEvent(new Event('click', { bubbles: true }))
  await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()
  vi.useRealTimers()
  w.unmount()
})

test('空状态:0 项目 → 还没有项目+新建按钮', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY({ projects: [], totals: { projects: 0, runningConvs: 0, pendingApprovals: 0, sshSessions: 0 } }))
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  const panel = document.body.querySelector('[data-test="wb-panel"]')
  expect(panel.textContent).toContain('还没有项目')
  ;[...panel.querySelectorAll('button')].find(b => b.textContent.includes('新建项目')).click()
  expect(mocks.push).toHaveBeenLastCalledWith('/workbench?create=1')
  vi.useRealTimers(); w.unmount()
})

test('拉取失败静默:notify 不被调;首次失败面板显示加载失败', async () => {
  vi.useFakeTimers()
  toast.notify.mockClear()
  mocks.summary.mockRejectedValue(new Error('boom'))
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]').textContent).toContain('加载失败')
  expect(toast.notify).not.toHaveBeenCalled()
  vi.useRealTimers()
  w.unmount()
})

// C1 回归:模板裸 clearTimeout 编译成 _ctx.clearTimeout → TypeError → 宽限定时器不取消 → 面板自关
test('鼠标移进面板取消宽限关闭(holdPanel):300ms 后面板仍在', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  const panel = document.body.querySelector('[data-test="wb-panel"]')
  expect(panel).toBeTruthy()
  panel.dispatchEvent(new Event('mouseenter', { bubbles: true }))   // 移进面板:取消 200ms 宽限
  vi.advanceTimersByTime(300)
  await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeTruthy()   // 未被宽限关闭
  vi.useRealTimers()
  w.unmount()
})

// I2 回归:stale 文案不得与 relTime 的「前」叠成「前前」
test('降级细字:失败有旧数据 → 含「更新失败」且不含「前前」', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  let panel = document.body.querySelector('[data-test="wb-panel"]')
  expect(panel.textContent).not.toContain('更新失败')
  mocks.summary.mockRejectedValue(new Error('boom'))
  vi.advanceTimersByTime(30_000); await flushPromises()   // 触发 30s 轮询 → 失败,保旧数据
  vi.advanceTimersByTime(10); await flushPromises()       // retry:1 retryDelay:0 的重试也要走完才进 isError
  panel = document.body.querySelector('[data-test="wb-panel"]')
  expect(panel.textContent).toContain('更新失败')
  expect(panel.textContent).not.toContain('前前')
  vi.useRealTimers()
  w.unmount()
})
