// 手机虚拟按键条(Task 5,mobile Wave 2):KEY_BYTES 纯映射直测 + 模板静态断言。
// xterm 挂载重,故模板分支采用源码静态断言(readFileSync 模式,参照 shell-width-guard.test.js):
// 手机档按键条 v-if="isPhone" 兜底桌面零回归;TerminalTaskbar 4 处关闭 × 触控目标类。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { KEY_BYTES, clampFont, FONT_MIN, FONT_MAX } from '../InteractiveTerminal.vue'

test('虚拟按键字节映射:与 VT100/xterm 标准转义一致', () => {
  expect(KEY_BYTES['Esc']).toBe('\x1b')
  expect(KEY_BYTES['Tab']).toBe('\t')
  expect(KEY_BYTES['↑']).toBe('\x1b[A')
  expect(KEY_BYTES['↓']).toBe('\x1b[B')
  expect(KEY_BYTES['←']).toBe('\x1b[D')
  expect(KEY_BYTES['→']).toBe('\x1b[C')
  expect(KEY_BYTES['Ctrl+C']).toBe('\x03')
  expect(Object.keys(KEY_BYTES)).toHaveLength(7)
})

// vitest 环境下 import.meta.url 非 file 协议,静态断言统一走 cwd 相对路径
const src = readFileSync(resolve('src/components/common/InteractiveTerminal.vue'), 'utf8')

test('手机档按键条模板:isPhone 分支 + 7 键位 + 40px 触控目标', () => {
  expect(src).toContain('v-if="isPhone"')
  expect(src).toContain('data-test="term-keybar"')
  for (const key of Object.keys(KEY_BYTES)) expect(src).toContain(`{{ key }}`)
  expect(src).toContain('min-h-[40px]')
  expect(src).toContain('min-w-[40px]')
  expect(src).toContain('sendInput(bytes)')
})

test('sendInput 复用既有 term.onData 同款数据通路(stream?.send)+ 终审修复(B):发送后回焦 xterm 收软键盘', () => {
  expect(src).toContain('function sendInput(d)')
  expect(src).toContain('stream?.send(d); term?.focus()')
})

test('终审修复(B):按键钮 @pointerdown.prevent 阻止焦点转移(软键盘不收起)', () => {
  expect(src).toContain('@pointerdown.prevent @click="sendInput(bytes)"')
})

// Task 2(mobile Wave 3):字号热调——钳制纯函数直测 + 模板/接线静态断言
test('字号钳制:8~20,默认外值收敛到界内', () => {
  expect(FONT_MIN).toBe(8)
  expect(FONT_MAX).toBe(20)
  expect(clampFont(12)).toBe(12)
  expect(clampFont(4)).toBe(8)
  expect(clampFont(99)).toBe(20)
  expect(clampFont(19)).toBe(19)
})

test('字号钮模板:A-/A+ 在按键条 v-for 之前 + 防焦点转移配方 + 热调接线', () => {
  expect(src).toContain('@pointerdown.prevent @click="adjustFont(-1)"')
  expect(src).toContain('@pointerdown.prevent @click="adjustFont(1)"')
  expect(src.indexOf('adjustFont(-1)')).toBeLessThan(src.indexOf('v-for="(bytes, key) in KEY_BYTES"'))
  expect(src).toContain('termFont.value = clampFont(termFont.value + delta)')
  expect(src).toContain('term.options.fontSize = termFont.value')
  expect(src).toContain('fit?.fit()')
})

const taskbar = readFileSync(resolve('src/components/terminal/TerminalTaskbar.vue'), 'utf8')

test('TerminalTaskbar 4 处 chip 关闭 × 手机触控目标类', () => {
  const touchCls = 'max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center'
  const occurrences = taskbar.split('opacity-0 group-hover:opacity-100 max-sm:opacity-100').length - 1
  expect(occurrences).toBe(4)
  expect(taskbar.split(touchCls).length - 1).toBe(4)
})
