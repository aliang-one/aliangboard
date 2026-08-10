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
