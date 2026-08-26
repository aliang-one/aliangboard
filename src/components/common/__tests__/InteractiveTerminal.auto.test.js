// InteractiveTerminal 自动模式契约(2026-08-26 终端 tab 补全/方向键修复):
// ① 首连传 auto=true → 网关探测最优 shell(bash 优先;默认 sh 在 Debian 系镜像=dash,无 tab 补全);
// ② 无输出降级重试不带 auto —— 网关须尊重前端指定的 shell,否则探测结果覆盖梯子选择导致死循环;
// ③ onMode 回传的实际 shell 显示在头部(手测时可确认拿到了 bash)。
// mock 策略:@/api/client 捕获 execStream 入参;xterm 三件套桩掉(happy-dom 渲染非被测行为)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const calls = vi.hoisted(() => [])
vi.mock('@/api/client', () => ({
  execStream: vi.fn(opts => { calls.push(opts); return { send() {}, resize() {}, close() {}, isOpen: true } }),
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({}) }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class { constructor() { this.cols = 80; this.rows = 24 } open() {} write() {} writeln() {} onData() {} onResize() {} loadAddon() {} focus() {} dispose() {} },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

import InteractiveTerminal from '../InteractiveTerminal.vue'

function mountTerm() {
  setActivePinia(createPinia())
  return mount(InteractiveTerminal, {
    props: { podName: 'web-1', namespace: 'default', container: 'main', sessionId: 't1', autoConnect: true },
    global: { plugins: [i18n] },
  })
}

beforeEach(() => { calls.length = 0 })

test('自动模式首连:execStream 带 auto=true', async () => {
  mountTerm()
  await flushPromises()
  expect(calls.length).toBe(1)
  expect(calls[0].auto).toBe(true)
})

test('无输出退出 → 降级重试不带 auto(网关尊重前端指定的 shell)', async () => {
  mountTerm()
  await flushPromises()
  calls[0].onExit({ status: 'Failure' })   // 全程无输出 → 梯子前进
  await flushPromises()
  expect(calls.length).toBe(2)
  expect(calls[1].auto).toBeFalsy()
  expect(calls[1].command).toBe('bash')    // SHELLS 梯子:sh → bash
})

test('onMode 回传 shell → 头部显示实际 shell(而非前端的 sh 假设)', async () => {
  const w = mountTerm()
  await flushPromises()
  calls[0].onMode({ persistent: true, shell: 'bash' })
  await flushPromises()
  expect(w.html()).toContain('· bash')
})
