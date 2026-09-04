import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 2026-09-04 事故②:SshTerminalPopup 漏在守卫豁免名单外——登出态下弹窗 reload 被
// 守卫整页改写到 /login(或集群选择页),复活信标永不发出 → opener 墓碑 5s 收尾删 chip
// 且镜像级联到所有标签页(「一条 chip 直接消失」的机制)。TerminalPopup/LogPopup 早已豁免,
// SSH 弹窗必须对称。豁免 early-return 同时跳过集群层(Layer 2),重登回跳后不会再被弹去 /select-cluster。

const src = readFileSync(resolve('src/router/index.js'), 'utf8')

test('守卫豁免名单含 SshTerminalPopup(与 TerminalPopup/LogPopup 弹窗族对称)', () => {
  expect(src).toMatch(/\['TerminalPopup',\s*'LogPopup',\s*'SshTerminalPopup'\]/)
})

test('/ssh-terminal-popup 路由 name 必须恰为 SshTerminalPopup(守卫按 to.name 匹配)', () => {
  expect(src).toMatch(/name:\s*'SshTerminalPopup'/)
})

test('豁免 return 必须在 Layer 1 判定之前(整链跳过,含集群层)', () => {
  const guard = src.slice(src.indexOf('router.beforeEach'))
  const exempt = guard.indexOf(".includes(to.name)")
  const layer1 = guard.indexOf('无平台 token')
  expect(exempt).toBeGreaterThan(-1)
  expect(layer1).toBeGreaterThan(-1)
  expect(exempt).toBeLessThan(layer1)
})
