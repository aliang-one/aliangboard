// 终端剪贴板按键接管(2026-10-16「Ctrl+V 粘贴不到」根因修复):
// 纯行为直测(假 term 捕获 handler,合成 KeyboardEvent 形状)+ 双消费方接线静态断言
// (readFileSync 模式,参照 InteractiveTerminal.keys.test.js——xterm 挂载重,不进组件)。
// 根因备忘:xterm 默认把 Ctrl+V 求值为 \x16、Ctrl+C 求值为 \x03 并 preventDefault 浏览器
// 剪贴板动作;接管 = 对目标键 return false(xterm 官方约定:不再处理、不 preventDefault),
// 让浏览器 paste/copy 事件落到 xterm 自带监听 → onData/剪贴板写入。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { attachTerminalClipboardKeys } from '@/composables/useTerminalClipboard'

// 捕获 handler 的假 term;hasSelection 可控,模拟选中/未选中两种态
function stubTerm(hasSelection = false) {
  let handler = null
  const term = {
    hasSelection: () => hasSelection,
    attachCustomKeyEventHandler: h => { handler = h },
  }
  attachTerminalClipboardKeys(term, { isMac: false })
  return { term, fire: ev => handler(ev) }
}
const kd = over => ({ type: 'keydown', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: '', ...over })

test('Ctrl+V(裸 ctrl,无 shift/alt/meta):return false 放行浏览器粘贴——onData 同通路接收', () => {
  const { fire } = stubTerm()
  expect(fire(kd({ ctrlKey: true, code: 'KeyV' }))).toBe(false)
  expect(fire(kd({ ctrlKey: true, code: 'KeyV', repeat: true }))).toBe(false)   // 长按重复同判定
})

test('既有原生通路不拦:Ctrl+Shift+V / Cmd+V / Ctrl+Insert / 其余 ctrl 组合一律 return true', () => {
  const { fire } = stubTerm()
  expect(fire(kd({ ctrlKey: true, shiftKey: true, code: 'KeyV' }))).toBe(true)   // Linux 粘贴惯例,原生已通
  expect(fire(kd({ metaKey: true, code: 'KeyV' }))).toBe(true)                   // macOS Cmd+V,原生已通
  expect(fire(kd({ ctrlKey: true, code: 'Insert' }))).toBe(true)                 // Windows 复制惯例,原生已通
  expect(fire(kd({ ctrlKey: true, code: 'KeyA' }))).toBe(true)                   // 不误伤其他 ctrl 组合(仍产 \x01 等)
  expect(fire(kd({ code: 'KeyV' }))).toBe(true)                                  // 裸 V:正常输入
})

test('Ctrl+C:无选区保持 \x03(SIGINT);有选区(非 Mac)放行为浏览器复制;Mac 恒终端语义', () => {
  const plain = stubTerm(false)
  expect(plain.fire(kd({ ctrlKey: true, code: 'KeyC' }))).toBe(true)             // 无选区:SIGINT 不动
  const selecting = stubTerm(true)
  expect(selecting.fire(kd({ ctrlKey: true, code: 'KeyC' }))).toBe(false)        // 有选区:变复制
  let macHandler = null
  const macTerm = { hasSelection: () => true, attachCustomKeyEventHandler: h => { macHandler = h } }
  attachTerminalClipboardKeys(macTerm, { isMac: true })
  expect(macHandler(kd({ ctrlKey: true, code: 'KeyC' }))).toBe(true)             // Mac 复制=Cmd+C,Ctrl+C 恒 SIGINT
})

test('keydown 之外的事件类型不拦(keypress/keyup 拦了会断输入路径)', () => {
  const { fire } = stubTerm(true)
  expect(fire({ type: 'keypress', ctrlKey: true, code: 'KeyV' })).toBe(true)
  expect(fire({ type: 'keyup', ctrlKey: true, code: 'KeyV' })).toBe(true)
})

// 双消费方接线静态断言:ensureTerm 创建 term 后必须挂接管(每次重建实例都重挂)
const assertConsumer = (src, name) => {
  expect(src).toContain(`import { attachTerminalClipboardKeys } from '@/composables/useTerminalClipboard'`)
  // 接线点在 term.open 之后、onData 附近(创建即挂,重连重建实例同步覆盖)
  const openAt = src.indexOf('term.open(root.value)')
  const attachAt = src.indexOf('attachTerminalClipboardKeys(term)')
  const onDataAt = src.indexOf('term.onData(d => stream?.send(d))')
  expect(attachAt).toBeGreaterThan(openAt)
  expect(onDataAt).toBeGreaterThan(attachAt)
}
const pod = readFileSync(resolve('src/components/common/InteractiveTerminal.vue'), 'utf8')
const ssh = readFileSync(resolve('src/components/ssh/SshTerminal.vue'), 'utf8')

test('消费方 InteractiveTerminal(pod):创建 term 即挂剪贴板接管', () => assertConsumer(pod))
test('消费方 SshTerminal(SSH):创建 term 即挂剪贴板接管(与 pod 同源)', () => assertConsumer(ssh))
