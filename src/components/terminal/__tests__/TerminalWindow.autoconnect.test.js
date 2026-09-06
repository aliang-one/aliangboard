// TerminalWindow auto-connect 契约(2026-09-05 P1:Pod 侧补齐 SSH 的「auto-connect 仅 open」):
// minimized 挂载(刷新水合的常态)不得自动建连;open 挂载才连;恢复翻转不炸。
// 此前硬编码 auto-connect=true:刷新后所有历史窗口(含用户没点的)各自静默开 exec/tmux,
// 死 sid 被同 sid 新建 shell =「chip 在、内容全新」。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const terminalStubProps = []
const exposeSpies = []
vi.mock('@/components/common/InteractiveTerminal.vue', () => ({
  default: {
    name: 'InteractiveTerminal',
    props: ['podName', 'namespace', 'container', 'sessionId', 'autoConnect'],
    template: '<div data-test="stub-term" :data-auto-connect="String(autoConnect)" />',
    setup(props, { expose }) {
      const spy = { connectIfIdle: vi.fn(), refit: vi.fn() }
      exposeSpies.push(spy)
      expose(spy)
      return { autoConnect: props.autoConnect }
    },
    mounted() { terminalStubProps.push({ autoConnect: this.autoConnect, sessionId: this.sessionId }) },
  },
}))
vi.mock('@/components/common/FloatingWindow.vue', () => ({
  default: { name: 'FloatingWindow', template: '<div data-test="stub-fw"><slot /><slot name="title-actions" /></div>' },
}))

import TerminalWindow from '../TerminalWindow.vue'

const mkTerminal = status => ({
  id: 'term-x', name: 'pod-a/main', namespace: 'ns', podName: 'pod-a', container: 'main', status, zIndex: 1,
})

const mountWin = async status => {
  setActivePinia(createPinia())
  const w = mount(TerminalWindow, { global: { plugins: [i18n] }, props: { terminal: mkTerminal(status) } })
  await w.vm.$nextTick()
  return w
}

beforeEach(() => { terminalStubProps.length = 0; localStorage.clear() })

test('minimized 挂载:InteractiveTerminal 收到 autoConnect=false(不自动建连)', async () => {
  await mountWin('minimized')
  expect(terminalStubProps.at(-1).autoConnect).toBe(false)
})

test('open 挂载:autoConnect=true(用户显式打开的窗口照常直连)', async () => {
  await mountWin('open')
  expect(terminalStubProps.at(-1).autoConnect).toBe(true)
})

test('minimized → open 翻转:watcher 触发子组件 refit+connectIfIdle(按需补连)', async () => {
  const w = await mountWin('minimized')
  await w.setProps({ terminal: { ...mkTerminal('open') } })
  // watcher 内部 nextTick+50ms setTimeout 后调 refit/connectIfIdle
  await new Promise(r => setTimeout(r, 120))
  const spy = exposeSpies.at(-1)
  expect(spy.refit).toHaveBeenCalled()
  expect(spy.connectIfIdle).toHaveBeenCalled()
})
