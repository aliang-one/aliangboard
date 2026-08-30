// 工作台入口胶囊:① C3 契约(aria/文字/两态类/点击 /workbench);② 角标常驻优先级
// (待审批红数字 > 运行中绿数字 > 项目数中性,0 活跃也不空);③ summary 数据驱动 title 摘要。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'

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

import WorkbenchEntryPill from '../WorkbenchEntryPill.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) } })
const mountPill = () => mount(WorkbenchEntryPill, {
  global: { plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] },
})

const SUMMARY = (over = {}) => ({
  projects: [{ id: 'p1', name: 'ci-cd', clusterId: 'c1', clusterName: 'prod', lastActiveAt: Date.now(), runningConvs: 0, pendingApprovals: 0 }],
  totals: { projects: 1, runningConvs: 0, pendingApprovals: 0, sshSessions: 0 }, ...over,
})

beforeEach(() => { mocks.summary.mockReset(); mocks.push.mockReset(); mocks.path = '/cluster' })

test('C3 契约:aria-label/文字/图标/默认态描边类', async () => {
  mocks.summary.mockReturnValue(new Promise(() => {}))   // 挂起,聚焦静态契约
  const w = mountPill(); await flushPromises()
  const btn = w.find('button')
  expect(btn.attributes('aria-label')).toBe('工作台')
  expect(btn.text()).toContain('工作台')
  expect(btn.find('.material-symbols-outlined').text()).toBe('workspaces')
  expect(btn.classes()).toContain('border-primary/40')
  expect(btn.classes()).not.toContain('bg-primary-container')
})

test('激活态:/workbench/* 路由填充类', async () => {
  mocks.path = '/workbench/p1'
  mocks.summary.mockReturnValue(new Promise(() => {}))
  const w = mountPill(); await flushPromises()
  expect(w.find('button').classes()).toContain('bg-primary-container')
})

test('点击直达 /workbench(行为不变)', async () => {
  mocks.summary.mockReturnValue(new Promise(() => {}))
  const w = mountPill(); await flushPromises()
  await w.find('button').trigger('click')
  expect(mocks.push).toHaveBeenCalledWith('/workbench')
})

test('角标常驻优先级:待审批红数字 > 运行中绿数字 > 项目数中性(0 活跃也不空)', async () => {
  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 1, runningConvs: 2, pendingApprovals: 3, sshSessions: 0 } }))
  let w = mountPill(); await flushPromises()
  expect(w.find('[data-test="pill-pending"]').text()).toBe('3')
  expect(w.find('[data-test="pill-running"]').exists()).toBe(false)
  expect(w.find('[data-test="pill-projects"]').exists()).toBe(false)
  w.unmount()

  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 1, runningConvs: 2, pendingApprovals: 0, sshSessions: 0 } }))
  w = mountPill(); await flushPromises()
  expect(w.find('[data-test="pill-running"]').text()).toBe('2')
  expect(w.find('[data-test="pill-pending"]').exists()).toBe(false)
  expect(w.find('[data-test="pill-projects"]').exists()).toBe(false)
  w.unmount()

  // 均零:常驻项目数徽章(用户反馈:入口一眼要有信息)
  mocks.summary.mockResolvedValue(SUMMARY())
  w = mountPill(); await flushPromises()
  expect(w.find('[data-test="pill-pending"]').exists()).toBe(false)
  expect(w.find('[data-test="pill-running"]').exists()).toBe(false)
  expect(w.find('[data-test="pill-projects"]').text()).toBe('1')
})

test('迷你统计条(≥lg):三段常驻,数字状态着色;徽章 lg 隐藏防重复', async () => {
  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 5, runningConvs: 1, pendingApprovals: 2, sshSessions: 0 } }))
  const w = mountPill(); await flushPromises()
  const stats = w.find('[data-test="pill-stats"]')
  expect(stats.exists()).toBe(true)
  expect(stats.classes()).toContain('hidden')                       // 窄屏整条隐藏
  expect(stats.text()).toContain('5') && expect(stats.text()).toContain('项目')
  expect(stats.text()).toContain('运行中')
  expect(stats.text()).toContain('待审批')
  expect(stats.find('.text-status-running').text()).toBe('1')       // 运行绿
  expect(stats.find('.text-error').text()).toBe('2')                // 待审批红
  // ≥lg 时单枚徽章隐藏,防止与统计条信息重复
  expect(w.find('[data-test="pill-pending"]').classes()).toContain('lg:hidden')
})

test('title 摘要由 summary 拼装', async () => {
  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 5, runningConvs: 1, pendingApprovals: 2, sshSessions: 3 } }))
  const w = mountPill(); await flushPromises()
  const title = w.find('button').attributes('title')
  expect(title).toContain('5 项目')
  expect(title).toContain('1 运行中')
  expect(title).toContain('2 待审批')
  expect(title).toContain('3 SSH')
})

// ===== Task 4:悬停面板 =====
test('悬停 150ms 开面板;面板含汇总 chips 与项目行', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY({
    projects: [{ id: 'p1', name: 'ci-cd', clusterId: 'c1', clusterName: 'prod', lastActiveAt: Date.now() - 120_000, runningConvs: 1, pendingApprovals: 2 }],
    totals: { projects: 1, runningConvs: 1, pendingApprovals: 2, sshSessions: 0 },
  }))
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
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
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
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
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
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
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeTruthy()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()

  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
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
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
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
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
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
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
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
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
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
