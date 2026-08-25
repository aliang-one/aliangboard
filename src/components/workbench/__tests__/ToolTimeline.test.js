// ToolTimeline(轮内工具时间线):顺序一行一事件、时刻+名称+首行预览、点击开 ToolCallModal、
// assistant 事件不占行、tool_start 显示执行中、denied 显示拒绝。
import { test, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'
import ToolTimeline from '@/components/workbench/ToolTimeline.vue'

const mountTl = (trace) => mount(ToolTimeline, { props: { trace }, global: { plugins: [i18n] } })

afterEach(() => { document.body.innerHTML = '' })

const TRACE = [
  { type: 'tool', name: 'wb_list_resources', args: { kind: 'pods' }, result: { kind: 'pods', items: [{ name: 'p1' }] }, ts: 1756100025000 },
  { type: 'assistant', message: { role: 'assistant' } },
  { type: 'tool', name: 'wb_get_pod_logs', args: { pod: 'p1' }, result: { logs: 'FATAL: password auth failed\nHINT: line 5' }, ts: 1756100030000 },
  { type: 'denied', name: 'wb_exec', args: {}, ts: 1756100040000 },
  { type: 'tool_start', name: 'wb_describe_resource', args: {}, ts: 1756100050000 },
]

test('每个工具事件一行(按序),assistant 不占行;行含时刻/名称/首行预览', () => {
  const w = mountTl(TRACE)
  const rows = w.findAll('[data-testid="tool-tl-row"]')
  expect(rows.length).toBe(4)                       // assistant 滤掉
  expect(rows[0].text()).toContain('wb_list_resources')
  expect(rows[0].text()).toContain('pods')          // 预览(fmtList 首行含 items)
  expect(rows[1].text()).toContain('wb_get_pod_logs')
  expect(rows[1].text()).toContain('FATAL: password auth failed')  // logs 首行
  // 时刻:zh-CN toLocaleTimeString 数字串
  expect(rows[0].text()).toMatch(/\d{2}:\d{2}:\d{2}/)
})

test('tool_start 行显示执行中;denied 行显示拒绝文案', () => {
  const w = mountTl(TRACE)
  const rows = w.findAll('[data-testid="tool-tl-row"]')
  expect(rows[3].text()).toContain('wb_describe_resource')
  expect(rows[3].text()).toContain(i18n.global.t('workbench.toolCall.running'))
  expect(rows[2].text()).toContain(i18n.global.t('workbench.toolCall.denied'))
})

test('点击行打开 ToolCallModal:参数与完整结果在详情里', async () => {
  const w = mountTl(TRACE)
  await w.findAll('[data-testid="tool-tl-row"]')[1].trigger('click')
  await flushPromises()
  const body = document.body.innerHTML
  expect(body).toContain('工具调用详情')            // modal 标题(zh locale)
  expect(body).toContain('"pod": "p1"')            // 参数 JSON
  expect(body).toContain('HINT: line 5')           // 结果(摘要 tab,logs 全文)
})

test('无 ts 的存量事件显示 —;空 trace 不渲染', () => {
  const w = mountTl([{ type: 'tool', name: 'x', result: 'r' }])
  expect(w.find('[data-testid="tool-tl-row"]').text()).toContain('—')
  const empty = mountTl([])
  expect(empty.find('[data-testid="tool-timeline"]').exists()).toBe(false)
})
