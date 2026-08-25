// src/composables/__tests__/useLogViewer.test.js
import { test, expect, vi } from 'vitest'
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
  return { wrapper, state }
}

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

test('openLogTab: URL 含 query 与 token，target 为具名 log-ns-pod-container', () => {
  const open = vi.fn()
  vi.stubGlobal('open', open)
  openLogTab({ namespace: 'default', podName: 'pod-1', container: 'main' })
  expect(open).toHaveBeenCalledTimes(1)
  const [url, target] = open.mock.calls[0]
  expect(url).toContain('/log-popup?')
  expect(url).toContain('ns=default')
  expect(url).toContain('pod=pod-1')
  expect(url).toContain('container=main')
  expect(url).toContain('token=tok-1')
  expect(target).toBe('log-default-pod-1-main')
  vi.unstubAllGlobals()
})
