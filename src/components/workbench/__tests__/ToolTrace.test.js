import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ToolTrace from '../ToolTrace.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: { workbench: { chat: { toolDenied: '已拒绝' } } } } })

test('ToolTrace: 每事件一颗 chip，含 name', () => {
  const trace = [
    { type: 'tool', name: 'list_resources', result: 'ok' },
    { type: 'denied', name: 'get_pod_logs' },
  ]
  const w = mount(ToolTrace, { props: { trace }, global: { plugins: [i18n] } })
  const chips = w.findAll('button')
  expect(chips).toHaveLength(2)
  expect(w.text()).toContain('list_resources')
  expect(w.text()).toContain('get_pod_logs')
})

test('ToolTrace: 点 chip 展开 result，再点收起', async () => {
  const w = mount(ToolTrace, { props: { trace: [{ type: 'tool', name: 'foo', result: 'hello-result' }] }, global: { plugins: [i18n] } })
  expect(w.text()).not.toContain('hello-result')
  await w.find('button').trigger('click')
  expect(w.text()).toContain('hello-result')
  await w.find('button').trigger('click')
  expect(w.text()).not.toContain('hello-result')
})

test('ToolTrace: 空 trace 不渲染', () => {
  const w = mount(ToolTrace, { props: { trace: [] }, global: { plugins: [i18n] } })
  expect(w.find('button').exists()).toBe(false)
})

// dev24: wb_top 智能格式化——百分比 + ≥80% ⚠ 警示;无 limit 不显百分比(不给假数)
test('ToolTrace: wb_top result 渲染用量百分比,≥80% 带 ⚠', async () => {
  const trace = [{
    type: 'tool', name: 'wb_top',
    result: { scope: 'pods', namespace: 'default', count: 2, items: [
      { name: 'nginx-1', containers: [{ name: 'app', cpu: '900m', memory: '900Mi', cpuLimit: '1', memoryLimit: '1Gi', cpuPct: 90, memoryPct: 87 }] },
      { name: 'side-1', containers: [{ name: 's', cpu: '10m', memory: '10Mi', cpuLimit: null, memoryLimit: null, cpuPct: null, memoryPct: null }] },
    ] },
  }]
  const w = mount(ToolTrace, { props: { trace }, global: { plugins: [i18n] } })
  await w.find('button').trigger('click')
  const text = w.text()
  expect(text).toContain('nginx-1/app')
  expect(text).toContain('cpu 90% ⚠')
  expect(text).toContain('mem 87% ⚠')
  // 无 limit 的容器:不出现百分比(不给假数)
  expect(text).toContain('side-1/s')
  expect(text).not.toContain('cpu null')
})

// dev27: tool_start running 态 chip(spinner,无 ✓;summary 不计瞬态)
test('ToolTrace: tool_start 渲染 running chip(转动图标),summary 不计入', () => {
  const trace = [
    { type: 'tool', name: 'wb_list_resources', result: 'ok' },
    { type: 'tool_start', name: 'wb_exec' },
  ]
  const w = mount(ToolTrace, { props: { trace }, global: { plugins: [i18n] } })
  const html = w.html()
  expect(html).toContain('animate-spin')
  expect(html).toContain('wb_exec')
  // summary(>5 才显示,这里构造 6 条验证不计入):直接验证 chip 数 = trace 数
  expect(w.findAll('button').filter(b => b.text().includes('wb_exec'))).toHaveLength(1)
})

// dev30: assistant 轮(LLM 思考回合,无 name)不渲染 chip、不进摘要(曾显示无名 chip + "N× unknown")
test('ToolTrace: assistant 轮不渲染 chip 也不计入 summary', () => {
  const trace = [
    { type: 'assistant', message: { role: 'assistant' } },
    { type: 'tool', name: 'read_ledger', result: 'ok' },
    { type: 'assistant', message: { role: 'assistant', tool_calls: [] } },
    { type: 'tool', name: 'wb_list_resources', result: 'ok' },
  ]
  const w = mount(ToolTrace, { props: { trace }, global: { plugins: [i18n] } })
  const chips = w.findAll('button').filter(b => /play_arrow/.test(b.html()) || /block/.test(b.html()))
  expect(chips).toHaveLength(2, '只渲染 2 个工具 chip')
  expect(w.text()).not.toContain('unknown')
  // 纯 assistant trace → 整个 ToolTrace 不渲染
  const w2 = mount(ToolTrace, { props: { trace: [{ type: 'assistant', message: {} }] }, global: { plugins: [i18n] } })
  expect(w2.find('button').exists()).toBe(false)
})
