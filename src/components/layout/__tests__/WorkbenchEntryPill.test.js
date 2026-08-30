// 工作台入口胶囊:① C3 契约(aria/文字/两态类/点击 /workbench);② 角标优先级
// (待审批红数字 > 运行中绿点 > 无);③ summary 数据驱动 title 摘要。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({ summary: vi.fn(), push: vi.fn(), path: '/cluster' }))
vi.mock('@/api/client', () => ({
  workbenchApi: { summary: mocks.summary },
  getSession: () => true,
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: mocks.path }),
  useRouter: () => ({ push: mocks.push }),
}))

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

test('角标优先级:待审批红数字 > 运行中绿点 > 无', async () => {
  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 1, runningConvs: 2, pendingApprovals: 3, sshSessions: 0 } }))
  let w = mountPill(); await flushPromises()
  expect(w.find('[data-test="pill-pending"]').text()).toBe('3')
  expect(w.find('[data-test="pill-running"]').exists()).toBe(false)
  w.unmount()

  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 1, runningConvs: 2, pendingApprovals: 0, sshSessions: 0 } }))
  w = mountPill(); await flushPromises()
  expect(w.find('[data-test="pill-running"]').exists()).toBe(true)
  w.unmount()

  mocks.summary.mockResolvedValue(SUMMARY())
  w = mountPill(); await flushPromises()
  expect(w.find('[data-test="pill-pending"]').exists()).toBe(false)
  expect(w.find('[data-test="pill-running"]').exists()).toBe(false)
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
