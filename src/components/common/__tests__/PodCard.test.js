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
