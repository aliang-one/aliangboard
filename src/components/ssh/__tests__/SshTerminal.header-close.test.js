import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 2026-09-04 关闭钮迁入终端头部(用户裁决):浮窗壳层的 ssh://名 + 关闭钮冗余,关闭钮
// 挪到 SshTerminal 头部(Live/刷新旁)。xterm 挂载重,模板断言走源码静态检查
// (同 InteractiveTerminal.keys.test.js readFileSync 模式)。

const src = readFileSync(resolve('src/components/ssh/SshTerminal.vue'), 'utf8')

test('closable prop:默认 false(弹窗页有自己的顶栏关闭钮,不受影响)', () => {
  expect(src).toMatch(/closable:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/)
})

test('关闭钮:closable 门控 + data-test + 点击 emit close(不直接碰 store,组件保持哑)', () => {
  expect(src).toContain('v-if="closable"')
  expect(src).toContain('data-test="btnCloseTerminal"')
  expect(src).toMatch(/@click="\$emit\('close'\)"/)
  expect(src).toContain('terminal.closeWindow')
})

test('关闭钮位置:在刷新按钮(btnReconnect)之后——「放到 Live 标签旁边、刷新按钮旁边」', () => {
  const reconnect = src.indexOf('data-test="btnReconnect"')
  const close = src.indexOf('data-test="btnCloseTerminal"')
  expect(reconnect).toBeGreaterThan(-1)
  expect(close).toBeGreaterThan(reconnect)
})

test('defineExpose 不受影响(refit 仍暴露)', () => {
  expect(src).toContain('defineExpose({ refit')
})

test('SshTerminalWindow 接线:壳层关 close 钮、终端开 close 钮并接 closeWindow、标题去 ssh:// 重复', () => {
  const win = readFileSync(resolve('src/components/ssh/SshTerminalWindow.vue'), 'utf8')
  expect(win).toContain(':closable="false"')            // FloatingWindow 壳层关闭钮隐藏
  expect(win).toMatch(/closable(?!\s*=)[\s\S]{0,40}@close="sshStore\.closeWindow\(window\.id\)"/)   // SshTerminal 开钮 + 杀会话接线
  expect(win).not.toContain('ssh://')                    // 标题不再重复 ssh://名(终端头部已有)
  expect(win).toContain('data-test="btnOpenExternal"')   // 新标签页入口保留
})
