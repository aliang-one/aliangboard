import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 2026-09-08 单行头部收编(用户裁决):壳层标题栏整体退役,●●● 圆点变真窗口钮
// (红关/黄最小化/绿最大化,macOS 语义),open_in_new 迁入终端头部。closable 被 chrome
// 取代。xterm 挂载重,模板断言走源码静态检查(同 InteractiveTerminal.keys.test.js 模式)。

const src = readFileSync(resolve('src/components/ssh/SshTerminal.vue'), 'utf8')
const win = readFileSync(resolve('src/components/ssh/SshTerminalWindow.vue'), 'utf8')
const popup = readFileSync(resolve('src/views/SshTerminalPopup.vue'), 'utf8')

test('chrome prop:取代 closable(false=装饰 | window=浮窗全套 | page=仅红点)', () => {
  expect(src).toMatch(/chrome:\s*\{\s*type:\s*\[Boolean,\s*String\],\s*default:\s*false\s*\}/)
  expect(src).not.toMatch(/closable:\s*\{/)                // 旧 prop 定义彻底退役(注释提及不算)
  expect(src).toContain("props.chrome === 'window'")
  expect(src).toContain("props.chrome === 'page'")
})

test('●●● 真窗口钮:三 data-test + emit win-close/win-minimize/win-maximize(组件哑,不碰 store)', () => {
  expect(src).toContain('data-test="dot-close"')
  expect(src).toContain('data-test="dot-minimize"')
  expect(src).toContain('data-test="dot-maximize"')
  expect(src).toMatch(/emit\('win-close'\)/)
  expect(src).toMatch(/emit\('win-minimize'\)/)
  expect(src).toMatch(/emit\('win-maximize'\)/)
  // 黄/绿仅 window 模式(page 只红点)
  expect(src).toMatch(/v-if="isWindowChrome" data-test="dot-minimize"/)
  expect(src).toMatch(/v-if="isWindowChrome" data-test="dot-maximize"/)
})

test('拖拽把手:window 模式头部标 data-window-drag(FloatingWindow 委托)', () => {
  expect(src).toMatch(/:data-window-drag="isWindowChrome \? '' : null"/)
})

test('open_in_new 迁入终端头部(在 btnReconnect 之后),emit open-external', () => {
  const reconnect = src.indexOf('data-test="btnReconnect"')
  const external = src.indexOf('data-test="btnOpenExternal"')
  expect(reconnect).toBeGreaterThan(-1)
  expect(external).toBeGreaterThan(reconnect)
  expect(src).toMatch(/emit\('open-external'\)/)
})

test('defineExpose 不受影响(refit 仍暴露)', () => {
  expect(src).toContain('defineExpose({ refit')
})

test('SshTerminalWindow 接线:壳层 headerless + 终端 chrome=window + 四路事件接 store', () => {
  expect(win).toContain(':headerless="true"')
  expect(win).not.toContain('data-test="btnOpenExternal"')   // 入口迁入终端头部
  expect(win).toContain('chrome="window"')
  expect(win).toContain('@win-close="sshStore.closeWindow(window.id)"')
  expect(win).toContain('@win-minimize="sshStore.minimizeWindow(window.id)"')
  expect(win).toContain('@win-maximize="floatRef?.toggleMaximize()"')
  expect(win).toContain('@open-external="sshStore.openExternal(window.id)"')
  expect(win).toContain('@maximize-change="isMax = $event"')
})

test('SshTerminalPopup 接线:外部顶条退役,红点(chrome=page)承接杀会话+关窗', () => {
  expect(popup).not.toContain('btnClosePopup')               // 旧顶条按钮退役
  expect(popup).toContain('chrome="page"')
  expect(popup).toContain('@win-close="closeWindow"')
  expect(popup).toMatch(/sshApi\.killSession\(sid\.value\)/) // 杀会话语义保留
})

test('事故③:恢复的 minimized 窗口不在挂载时建连;恢复(open)时按需 connectIfIdle', () => {
  expect(win).toContain('const connectAtMount = props.window.status === \'open\'')
  expect(win).toContain(':auto-connect="connectAtMount"')
  expect(win).toContain('termRef.value?.connectIfIdle?.()')
  expect(src).toContain('function connectIfIdle()')
  expect(src).toContain('defineExpose({ refit, replayed, connectIfIdle, connect, status })')
})
