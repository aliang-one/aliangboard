// src/components/common/__tests__/LogViewerBody.test.js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

// k8sStream 捕获 handlers 后由测试手动推流；api.k8s 静态返回三行
let streamHandlers = null

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => '2026-01-01T00:00:00Z app started\n2026-01-01T00:00:01Z error cannot connect db\n2026-01-01T00:00:02Z warn retrying') },
  k8sStream: vi.fn((path, handlers) => { streamHandlers = { path, ...handlers }; return { abort: vi.fn() } }),
  getSessionToken: () => 'tok',
}))

import LogViewerBody from '@/components/common/LogViewerBody.vue'

function mountBody() {
  return mount(LogViewerBody, {
    props: { namespace: 'default', podName: 'pod-1', containers: ['main', 'sidecar'] },
    global: { plugins: [createPinia(), i18n] },
  })
}

test('follow 流推入的行渲染时间戳/级别/消息，级别着色 ERROR', async () => {
  const w = mountBody()
  streamHandlers.onMessage('2026-01-01T00:00:00Z error cannot connect db')
  await w.vm.$nextTick()
  const line = w.find('[data-testid="log-line"]')
  expect(line.text()).toContain('error cannot connect db')
  expect(line.text()).toContain('ERROR')
  expect(w.find('[data-testid="log-line"] .text-error').exists()).toBe(true)
})

test('搜索过滤：只保留命中行，命中片段带高亮标记', async () => {
  const w = mountBody()
  streamHandlers.onMessage('2026-01-01T00:00:00Z app started')
  streamHandlers.onMessage('2026-01-01T00:00:01Z error cannot connect db')
  await w.vm.$nextTick()
  await w.find('[data-testid="log-search"]').setValue('db')
  await w.vm.$nextTick()
  const lines = w.findAll('[data-testid="log-line"]')
  expect(lines).toHaveLength(1)
  expect(lines[0].text()).toContain('cannot connect db')
  expect(w.find('[data-testid="log-highlight"]').exists()).toBe(true)
})

test('非法正则：显示错误提示且不过滤', async () => {
  const w = mountBody()
  streamHandlers.onMessage('2026-01-01T00:00:00Z hello')
  await w.vm.$nextTick()
  await w.find('[data-testid="log-regex"]').setValue(true)
  await w.find('[data-testid="log-search"]').setValue('[invalid')
  await w.vm.$nextTick()
  expect(w.find('[data-testid="log-regex-error"]').exists()).toBe(true)
  expect(w.findAll('[data-testid="log-line"]')).toHaveLength(1)
})

test('级别 chip：只留 ERROR', async () => {
  const w = mountBody()
  streamHandlers.onMessage('2026-01-01T00:00:00Z fine')
  streamHandlers.onMessage('2026-01-01T00:00:01Z error boom')
  await w.vm.$nextTick()
  const chips = w.findAll('[data-testid="log-level"]')   // [ERROR, WARN, INFO] 顺序
  await chips[1].trigger('click')   // 关 WARN
  await chips[2].trigger('click')   // 关 INFO
  await w.vm.$nextTick()
  const lines = w.findAll('[data-testid="log-line"]')
  expect(lines).toHaveLength(1)
  expect(lines[0].text()).toContain('boom')
})

test('previous 勾选：follow 自动关闭并改走静态拉取', async () => {
  const w = mountBody()
  await w.find('[data-testid="log-previous"]').setValue(true)
  await w.vm.$nextTick()
  expect(w.find('[data-testid="log-follow"]').element.disabled).toBe(true)
  expect(w.text()).toContain('app started')   // 静态三行渲染
})

test('缓冲打满(cap)后 follow 自动滚动仍持续工作', async () => {
  const w = mountBody()
  const el = w.find('[data-testid="log-scroll"]').element
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  // 推满并超过 MAX_LOG_BUFFER:长度恒定在 cap,滚动必须仍跟随
  const { MAX_LOG_BUFFER } = await import('@/composables/useLogViewer')
  for (let i = 0; i < MAX_LOG_BUFFER + 10; i++) streamHandlers.onMessage(`2026-01-01T00:00:00Z msg-${i}`)
  await w.vm.$nextTick()
  await new Promise(r => setTimeout(r, 0))   // nextTick 滚动
  expect(el.scrollTop).toBe(1000)
  expect(w.find('[data-testid="back-to-bottom"]').exists()).toBe(false)  // following 未丢失
})

test('静态拉取失败显示 loadFailed 横幅（previous 模式）', async () => {
  const w = mountBody()
  const { api } = await import('@/api/client')
  api.k8s.mockRejectedValueOnce(new Error('boom'))
  await w.find('[data-testid="log-previous"]').setValue(true)
  await w.vm.$nextTick()
  await new Promise(r => setTimeout(r, 0))
  expect(w.find('[data-testid="log-error-banner"]').exists()).toBe(true)
})

test('上滚暂停跟随：出现回到底部按钮，点击恢复', async () => {
  const w = mountBody()
  const el = w.find('[data-testid="log-scroll"]').element
  streamHandlers.onMessage('2026-01-01T00:00:00Z one')
  await w.vm.$nextTick()
  // happy-dom 无真实布局：手动构造「远离底部」再派发 scroll
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  el.scrollTop = 0
  await w.find('[data-testid="log-scroll"]').trigger('scroll')
  expect(w.find('[data-testid="back-to-bottom"]').exists()).toBe(true)
  streamHandlers.onMessage('2026-01-01T00:00:01Z two')
  await w.vm.$nextTick()
  expect(w.find('[data-testid="back-to-bottom"]').text()).toContain('1')
  await w.find('[data-testid="back-to-bottom"]').trigger('click')
  expect(w.find('[data-testid="back-to-bottom"]').exists()).toBe(false)
})
