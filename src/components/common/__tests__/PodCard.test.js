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
