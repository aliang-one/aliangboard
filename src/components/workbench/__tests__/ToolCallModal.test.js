// src/components/workbench/__tests__/ToolCallModal.test.js
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const notifyMock = vi.fn()
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))

import ToolCallModal from '@/components/workbench/ToolCallModal.vue'

beforeEach(() => {
  notifyMock.mockClear()
  const writeTextMock = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true
  })
})

afterEach(() => { document.body.innerHTML = '' })

const mountM = (event) => mount(ToolCallModal, { props: { modelValue: true, event }, global: { plugins: [i18n] } })

test('tool 事件:头部工具名+ts、参数 JSON、摘要 tab 默认', () => {
  const w = mountM({ type: 'tool', name: 'wb_get_pod_logs', args: { namespace: 'ns1', pod: 'p1' }, result: { logs: 'err line' }, ts: 1756100000000 })
  const bodyText = document.body.innerHTML
  expect(bodyText).toContain('wb_get_pod_logs')
  expect(bodyText).toContain('"namespace": "ns1"')
  expect(bodyText).toContain('err line')
})

test('原始 tab:完整 JSON 可切换', async () => {
  const w = mountM({ type: 'tool', name: 'wb_describe_resource', args: {}, result: { resource: { kind: 'Pod' } } })
  const buttons = document.querySelectorAll('button')
  const rawTabBtn = Array.from(buttons).find(b => b.textContent.includes(i18n.global.t('workbench.toolCall.rawTab')))
  expect(rawTabBtn).toBeTruthy()
  await rawTabBtn.click()
  expect(document.body.innerHTML).toContain('"kind": "Pod"')
})

test('denied:显示拒绝提示;无 ts 显示 —', () => {
  mountM({ type: 'denied', name: 'wb_exec', args: { cmd: 'ls' } })
  const bodyText = document.body.innerHTML
  expect(bodyText).toContain(i18n.global.t('workbench.toolCall.denied'))
  expect(bodyText).toContain('—')
})

test('复制:clipboard.writeText 收到当前 tab 内容', async () => {
  mountM({ type: 'tool', name: 'wb_get_pod_logs', args: { pod: 'p' }, result: { logs: 'L1' } })
  const buttons = document.querySelectorAll('button')
  const copyBtn = Array.from(buttons).find(b => b.textContent.includes(i18n.global.t('common.copy')))
  expect(copyBtn).toBeTruthy()
  await copyBtn.click()
  expect(navigator.clipboard.writeText).toHaveBeenCalled()
  expect(notifyMock).toHaveBeenCalled()
})

test('超大结果截断提示', () => {
  const big = 'x'.repeat(70 * 1024)
  mountM({ type: 'tool', name: 'wb_get_pod_logs', args: {}, result: { logs: big } })
  expect(document.body.innerHTML).toContain(i18n.global.t('workbench.toolCall.truncated'))
})
