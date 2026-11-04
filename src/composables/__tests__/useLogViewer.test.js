// src/composables/__tests__/useLogViewer.test.js
import { test, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

// 捕获 k8sStream 的 handlers，模拟服务端推流
let streamHandlers = null
let streamAbort = null

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => '2026-01-01T00:00:00Z line-a\n2026-01-01T00:00:01Z error line-b') },
  k8sStream: vi.fn((path, handlers) => {
    streamHandlers = { path, ...handlers }
    streamAbort = vi.fn()
    return { abort: streamAbort }
  }),
  getSessionToken: () => 'tok-1',
}))

import { useLogViewer, openLogTab, MAX_LOG_BUFFER } from '@/composables/useLogViewer'

const apiK8sMock = await import('@/api/client').then(m => m.api.k8s)
const k8sStreamMock = await import('@/api/client').then(m => m.k8sStream)

// 宿主组件：composable 的生命周期钩子须在 setup 内注册
function mountViewer(props = {}) {
  const state = {}
  const Host = defineComponent({
    setup() {
      Object.assign(state, useLogViewer({
        namespace: ref(props.ns || 'default'),
        podName: ref(props.pod || 'pod-1'),
        container: ref(props.container || 'main'),
      }))
      return {}
    },
    template: '<div />',
  })
  const wrapper = mount(Host, { global: { plugins: [createPinia(), i18n] } })
  mountedWrappers.push(wrapper)
  return { wrapper, state }
}
// 可见性事件挂在共享 document 上:不卸载的旧宿主会残留监听器串扰后续用例,统一清理
const mountedWrappers = []
afterEach(() => { while (mountedWrappers.length) mountedWrappers.pop().unmount() })

test('挂载即启动 follow 流，路径带 follow=true 与 container', () => {
  const { state } = mountViewer()
  expect(k8sStreamMock).toHaveBeenCalledTimes(1)
  expect(streamHandlers.path).toContain('/api/v1/namespaces/default/pods/pod-1/log?')
  expect(streamHandlers.path).toContain('follow=true')
  expect(streamHandlers.path).toContain('container=main')
  expect(state.followLog.value).toBe(true)
})

test('onMessage 逐行解析入缓冲；onError 写入 streamError 与 ERROR 行', () => {
  const { state } = mountViewer()
  streamHandlers.onMessage('2026-01-01T00:00:00Z started')
  expect(state.lines.value).toHaveLength(1)
  expect(state.lines.value[0].level).toBe('INFO')
  streamHandlers.onError(new Error('boom'))
  expect(state.streamError.value).toContain('boom')
  expect(state.lines.value.at(-1).level).toBe('ERROR')
})

test('缓冲截断：超过 MAX_LOG_BUFFER 截头保尾', () => {
  const { state } = mountViewer()
  for (let i = 0; i < MAX_LOG_BUFFER + 100; i++) streamHandlers.onMessage(`2026-01-01T00:00:00Z msg-${i}`)
  expect(state.lines.value).toHaveLength(MAX_LOG_BUFFER)
  expect(state.lines.value.at(-1).message).toBe(`msg-${MAX_LOG_BUFFER + 99}`)
})

test('勾 previous 自动关 follow 并改走静态拉取；卸载断流', async () => {
  const { wrapper, state } = mountViewer()
  await wrapper.vm.$nextTick()
  state.logPrevious.value = true
  await nextTick()
  expect(state.followLog.value).toBe(false)
  expect(streamAbort).toHaveBeenCalled()
  expect(apiK8sMock).toHaveBeenCalled()
  wrapper.unmount()   // 卸载不再抛错（stopFollow 幂等）
})

// 2026-09-07 回归钉:token 必须走交接槽而非 URL(4d4eede 收紧消费分支到 /terminal-popup 后,
// openLogTab 仍拼 URL token 却无人消费 → 日志弹窗恒报「会话已过期」)。
test('openLogTab: token 走交接槽不上 URL，target 为具名 log-ns-pod-container', () => {
  const open = vi.fn()
  vi.stubGlobal('open', open)
  localStorage.removeItem('aliangboard.termTokenHandoff')
  openLogTab({ namespace: 'default', podName: 'pod-1', container: 'main' })
  expect(open).toHaveBeenCalledTimes(1)
  const [url, target] = open.mock.calls[0]
  expect(url).toContain('/log-popup?')
  expect(url).toContain('ns=default')
  expect(url).toContain('pod=pod-1')
  expect(url).toContain('container=main')
  expect(url).not.toContain('token=')   // token 不再上 URL(进浏览器历史,2026-09-04 审计裁决)
  expect(localStorage.getItem('aliangboard.termTokenHandoff')).toBe('tok-1')   // 改走交接槽
  expect(target).toBe('log-default-pod-1-main')
  vi.unstubAllGlobals()
  localStorage.removeItem('aliangboard.termTokenHandoff')
})

// ---- 页面可见性暂停(issue#20 诊断批):HTTP/1.1 每域 6 连接上限 × 长驻 follow 流 =
// 后台日志标签占住连接池,新加载排队数分钟(生产浏览器实测:4 标签第 4 个导航 60s 超时)。
// 隐藏超宽限期 → 暂停 follow(释放连接);恢复可见 → 自动重启。短暂切走(<宽限)不打断。
const setVisibility = state => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

test('页面隐藏超宽限期 → follow 暂停(abort);恢复可见 → 自动重启', async () => {
  vi.useFakeTimers()
  k8sStreamMock.mockClear(); streamAbort.mockClear()
  const { state } = mountViewer()
  expect(k8sStreamMock).toHaveBeenCalledTimes(1)
  setVisibility('hidden')
  vi.advanceTimersByTime(61000)
  expect(streamAbort).toHaveBeenCalledTimes(1)
  setVisibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(k8sStreamMock).toHaveBeenCalledTimes(2)
  vi.useRealTimers()
})

test('短暂隐藏(<宽限)恢复 → 不打断现有流', async () => {
  vi.useFakeTimers()
  k8sStreamMock.mockClear(); streamAbort.mockClear()
  const { state } = mountViewer()
  setVisibility('hidden')
  vi.advanceTimersByTime(1000)
  setVisibility('visible')
  vi.advanceTimersByTime(61000)
  expect(streamAbort).not.toHaveBeenCalled()
  expect(k8sStreamMock).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
})

test('previous 模式(follow 关)隐藏不产生暂停/重启动作', async () => {
  vi.useFakeTimers()
  k8sStreamMock.mockClear(); streamAbort.mockClear()
  const { state } = mountViewer()
  state.logPrevious.value = true
  await nextTick()
  const calls = k8sStreamMock.mock.calls.length
  setVisibility('hidden')
  vi.advanceTimersByTime(61000)
  setVisibility('visible')
  vi.advanceTimersByTime(0)
  expect(k8sStreamMock.mock.calls.length).toBe(calls)
  vi.useRealTimers()
})
