// 手机虚拟按键条 + 字号热调(Wave5 B6 抽共享后):KEY_BYTES 迁 TerminalKeyBar.vue、
// 字号逻辑迁 useTerminalFont.js,纯映射/纯行为直测 + 双消费方模板静态断言。
// xterm 挂载重,故模板分支采用源码静态断言(readFileSync 模式,参照 shell-width-guard.test.js):
// pod(InteractiveTerminal)与 SSH(SshTerminal,Wave5 B6 接入)均须 isPhone 按键条 + 字号钮,
// 桌面档(≥640)v-if 掉零回归;TerminalTaskbar 4 处关闭 × 触控目标类。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import TerminalKeyBar, { KEY_BYTES } from '../TerminalKeyBar.vue'
import { FONT_MIN, FONT_MAX, clampFont, useTerminalFont } from '@/composables/useTerminalFont'

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
const keybar = readFileSync(resolve('src/components/common/TerminalKeyBar.vue'), 'utf8')
const pod = readFileSync(resolve('src/components/common/InteractiveTerminal.vue'), 'utf8')
const ssh = readFileSync(resolve('src/components/ssh/SshTerminal.vue'), 'utf8')

test('TerminalKeyBar 组件:term-keybar 容器 + 7 键 v-for + 40px 触控目标 + 防焦点转移 + send 契约', () => {
  expect(keybar).toContain('data-test="term-keybar"')
  expect(keybar).toContain('v-for="(bytes, key) in KEY_BYTES"')
  expect(keybar).toContain('@pointerdown.prevent @click="send(bytes)"')
  expect(keybar).toContain('min-h-[40px]')
  expect(keybar).toContain('min-w-[40px]')
  for (const key of Object.keys(KEY_BYTES)) expect(keybar).toContain(`{{ key }}`)
  // 字号钮等前置件经默认槽注入,须渲染在 7 键之前(pod 既有布局:A-/A+ 居首)
  expect(keybar.indexOf('<slot')).toBeLessThan(keybar.indexOf('v-for="(bytes, key) in KEY_BYTES"'))
  // 组件持有键位表与键钮样式;send 回调由消费方供(须与其键盘同通路,消费方侧契约见下)
  expect(keybar).toContain('send: { type: Function, required: true }')
})

// 双消费方结构同构断言:pod(旧主)与 SSH(Wave5 B6 接入)
const assertConsumer = src => {
  expect(src).toContain('<TerminalKeyBar v-if="isPhone" :send="sendInput">')
  // 字号钮 A-/A+(防焦点转移配方)
  expect(src).toContain('@pointerdown.prevent @click="adjustFont(-1)"')
  expect(src).toContain('@pointerdown.prevent @click="adjustFont(1)"')
  // sendInput 复用既有 term.onData 同款数据通路(stream?.send)+ 发送后回焦 xterm 收软键盘(终审 B)
  expect(src).toContain('function sendInput(d)')
  expect(src).toContain('stream?.send(d); term?.focus()')
  // 字号热调接线:useTerminalFont + 重建复位(终审 E)+ 创建取 termFont
  expect(src).toContain('useTerminalFont({ term: () => term, fit: () => fit })')
  expect(src).toContain('resetFont()')
  expect(src).toContain('fontSize: termFont.value')
}

test('消费方 InteractiveTerminal(pod):TerminalKeyBar + isPhone 按键条 + 字号钮', () => assertConsumer(pod))

test('消费方 SshTerminal(SSH,Wave5 B6 手机配件补齐):TerminalKeyBar + isPhone 按键条 + 字号钮', () => assertConsumer(ssh))

// Task 2(mobile Wave 3):字号钳制——钳制纯函数直测(自 useTerminalFont 单源)
test('字号钳制:8~20,默认外值收敛到界内', () => {
  expect(FONT_MIN).toBe(8)
  expect(FONT_MAX).toBe(20)
  expect(clampFont(12)).toBe(12)
  expect(clampFont(4)).toBe(8)
  expect(clampFont(99)).toBe(20)
  expect(clampFont(19)).toBe(19)
})

// 字号热调行为直测(Wave5 B6 抽 composable 后,接线靠行为而非模板字符串):
// 钳制生效、term.options.fontSize 热写 + fit 重排、term 未建时静默、复位 13。
test('useTerminalFont:热写 fontSize + fit 重排 + 钳制 + 未建静默 + 复位', () => {
  let term = null, fit = null
  let fits = 0
  const { termFont, adjustFont, resetFont } = useTerminalFont({ term: () => term, fit: () => fit })
  expect(termFont.value).toBe(13)
  adjustFont(-1)                                  // term 未初始化:静默安全,只记账字号
  expect(termFont.value).toBe(12)
  term = { options: {} }
  fit = { fit: () => { fits++ } }
  adjustFont(1)
  expect(term.options.fontSize).toBe(13)
  expect(fits).toBe(1)
  adjustFont(-100)                                // 钳到下界 8
  expect(term.options.fontSize).toBe(8)
  adjustFont(100)                                 // 钳到上界 20
  expect(term.options.fontSize).toBe(20)
  resetFont()                                     // 重连重建复位
  expect(termFont.value).toBe(13)
  adjustFont(1)                                   // 复位后从 13 起步
  expect(term.options.fontSize).toBe(14)
})

const taskbar = readFileSync(resolve('src/components/terminal/TerminalTaskbar.vue'), 'utf8')

// 组件自身挂载直测(Wave5 B6 抽出后补):槽内容(字号钮)渲染在 7 键之前 + 点击经 send 下发字节。
// 组件无 xterm 依赖,轻挂载即可覆盖渲染路径(消费方接入由上面双消费方静态断言钉住)。
test('TerminalKeyBar 挂载:槽内容居首 + 7 键渲染 + 点击经 send 下发对应字节', async () => {
  const sent = []
  const w = mount(TerminalKeyBar, {
    props: { send: b => sent.push(b) },
    slots: { default: '<button class="font-btn" data-test="font-minus">A-</button>' },
  })
  const btns = w.findAll('[data-test="term-keybar"] button')
  expect(btns).toHaveLength(8)                          // 槽 1(字号钮)+ 7 键
  expect(btns[0].classes()).toContain('font-btn')      // 槽内容渲染在 7 键之前(pod 既有布局)
  const keyNames = btns.slice(1).map(b => b.text())
  expect(keyNames).toEqual(Object.keys(KEY_BYTES))     // 键序与字节表一致
  await btns[1].trigger('click')                       // Esc
  await btns[7].trigger('click')                       // Ctrl+C(末键)
  expect(sent).toEqual(['\x1b', '\x03'])
})

test('TerminalTaskbar 4 处 chip 关闭 × 手机触控目标类', () => {
  const touchCls = 'max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center'
  const occurrences = taskbar.split('opacity-0 group-hover:opacity-100 max-sm:opacity-100').length - 1
  expect(occurrences).toBe(4)
  expect(taskbar.split(touchCls).length - 1).toBe(4)
})
