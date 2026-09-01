// src/components/common/__tests__/PodCard.test.js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

vi.mock('@/composables/useLogViewer', () => ({ openLogTab: vi.fn() }))
// PodCard 依赖的终端/文件 store 与 usePod 工具照常（不涉及网络）
vi.mock('@/stores/terminals', () => ({ useTerminalStore: () => ({ openTerminal: vi.fn() }) }))
vi.mock('@/stores/fileBrowsers', () => ({ useFileBrowserStore: () => ({ openBrowser: vi.fn() }) }))

import PodCard from '@/components/common/PodCard.vue'
import { openLogTab } from '@/composables/useLogViewer'

const POD = {
  name: 'web-abc123', namespace: 'default', status: 'Running', age: '1h',
  containers: [{ name: 'main' }, { name: 'sidecar' }],
}

function mountCard(props = {}) {
  return mount(PodCard, { props: { pod: POD, ...props }, global: { plugins: [createPinia(), i18n] } })
}

test('日志按钮默认展示：点击 openLogTab 带第一个容器', async () => {
  const w = mountCard()
  await w.find('[data-testid="podcard-logs"]').trigger('click')
  expect(openLogTab).toHaveBeenCalledWith({ namespace: 'default', podName: 'web-abc123', container: 'main' })
})

test('CrashLoopBackOff（非 Running）不禁用日志按钮——previous 日志是刚需', async () => {
  const w = mountCard({ pod: { ...POD, status: 'CrashLoopBackOff' } })
  const btn = w.find('[data-testid="podcard-logs"]')
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  expect(openLogTab).toHaveBeenCalled()
})

test('showLogs=false 隐藏日志按钮', () => {
  const w = mountCard({ showLogs: false })
  expect(w.find('[data-testid="podcard-logs"]').exists()).toBe(false)
})

test('批量模式:selectable 渲染 checkbox 视觉,selected 切换图标,点击卡片仍 emit click', async () => {
  const w1 = mountCard({ selectable: true, selected: false })
  const cb1 = w1.find('[data-test="batch-checkbox"]')
  expect(cb1.exists()).toBe(true)
  expect(cb1.text()).toBe('check_box_outline_blank')
  await cb1.trigger('click')
  expect(w1.emitted('click')).toBeTruthy()  // checkbox 不拦截,冒泡到卡片

  const w2 = mountCard({ selectable: true, selected: true })
  expect(w2.find('[data-test="batch-checkbox"]').text()).toBe('check_box')

  const w3 = mountCard({ selectable: false })
  expect(w3.find('[data-test="batch-checkbox"]').exists()).toBe(false)
})

test('行3 指标:数值在进度条下方同块内,truncate+min-w-0 防溢出结构', () => {
  const w = mountCard({ pod: { ...POD, cpu: '124m/500m', memory: '182Mi/512Mi' } })
  const row = w.find('[data-testid="pod-metrics"]')
  expect(row.exists()).toBe(true)
  expect(row.classes()).toContain('max-w-sm')          // 整行封顶,宽页进度条不拉满屏
  const cpuBlock = w.find('[data-testid="pod-cpu-block"]')
  expect(cpuBlock.exists()).toBe(true)
  expect(cpuBlock.classes()).toContain('min-w-0')      // flex 子项可收缩,溢出根因链
  expect(cpuBlock.find('[data-testid="pod-cpu-bar"]').exists()).toBe(true)
  const cpuValue = cpuBlock.find('[data-testid="pod-cpu-value"]')
  expect(cpuValue.text()).toBe('124m/500m')
  expect(cpuValue.classes()).toContain('truncate')
  const memValue = w.find('[data-testid="pod-mem-value"]')
  expect(memValue.text()).toBe('182Mi/512Mi')
  expect(memValue.classes()).toContain('truncate')
})

test('行3 超长数值:truncate 兜底不产生横向溢出结构', () => {
  const w = mountCard({ pod: { ...POD, cpu: '11234m/500m', memory: '1182Mi/512Mi' } })
  const v = w.find('[data-testid="pod-cpu-value"]')
  expect(v.text()).toBe('11234m/500m')
  expect(v.classes()).toContain('truncate')
  expect(w.find('[data-testid="pod-cpu-block"]').classes()).toContain('min-w-0')
})

test('行3 无 metrics 不渲染(现状回归)', () => {
  const w = mountCard()
  expect(w.find('[data-testid="pod-metrics"]').exists()).toBe(false)
})

test('行3 用量条分母=limit:req512Mi/lim2048Mi/used1024Mi → 50% 不标红(2026-09-01 溢出标红事故回归)', () => {
  // mapPod 产物形状:数值字段 + 展示串(分母已切 limit)
  const pod = {
    ...POD, status: 'Running',
    usedCpu: 124, reqCpu: 100, limCpu: 500,
    usedMem: 1024 * 1024, reqMem: 512 * 1024, limMem: 2048 * 1024,
    cpu: '124m/500m', memory: '1024Mi/2048Mi',
  }
  const w = mountCard({ pod })
  const bar = w.find('[data-testid="pod-mem-bar"] div')
  expect(bar.attributes('style')).toContain('width: 50%')
  expect(bar.classes()).not.toContain('bg-error')
  expect(w.find('[data-testid="pod-mem-value"]').text()).toBe('1024Mi/2048Mi')
})

test('行3 用量贴近 limit 仍标红:>80% 语义保留(分母换成 limit 不放松告警)', () => {
  const pod = {
    ...POD, status: 'Running',
    usedMem: 1800 * 1024, reqMem: 512 * 1024, limMem: 2048 * 1024,
    memory: '1800Mi/2048Mi',
  }
  const w = mountCard({ pod })
  expect(w.find('[data-testid="pod-mem-bar"] div').classes()).toContain('bg-error')
})
