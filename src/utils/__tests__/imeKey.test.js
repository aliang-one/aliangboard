// IME 组合期按键防线单源(2026-11-16 终端 tab 改名事故):判定依据与工厂契约。
// 判定两层同 Chrome 官方指南「IME-safe enter-to-submit」:
// 1) isComposing —— Chrome/Edge/Firefox 组合期 keydown(含提交候选的 Enter)恒 true;
// 2) keyCode 229 —— Safari 把 compositionend 先于确认 Enter 派发(WebCore bug 165004,
//    isComposing 已翻回 false),但该 keydown 仍报 VK_PROCESSKEY(229),第二条拦它;
//    部分旧实现也以 229 标记组合期,双保险。
import { describe, it, expect } from 'vitest'
import { isImeKeyEvent, enterEscKeydown } from '../imeKey.js'

describe('isImeKeyEvent', () => {
  it('组合期 keydown(isComposing=true)→ true', () => {
    expect(isImeKeyEvent({ key: 'Enter', isComposing: true, keyCode: 229 })).toBe(true)
    expect(isImeKeyEvent({ key: 'a', isComposing: true, keyCode: 229 })).toBe(true)
  })

  it('Safari 乱序确认 Enter(keyCode 229、isComposing=false)→ true', () => {
    expect(isImeKeyEvent({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(true)
    expect(isImeKeyEvent({ key: 'Escape', isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('普通键 → false(Enter keyCode 13 / Escape / 字母)', () => {
    expect(isImeKeyEvent({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false)
    expect(isImeKeyEvent({ key: 'Escape', isComposing: false, keyCode: 27 })).toBe(false)
    expect(isImeKeyEvent({ key: 'a', isComposing: false, keyCode: 65 })).toBe(false)
    expect(isImeKeyEvent({ key: 'Enter' })).toBe(false)   // happy-dom trigger('keydown.enter') 形态
  })
})

describe('enterEscKeydown 工厂', () => {
  // cancelable 必显式:DOM 规范 preventDefault 只对 cancelable 事件生效(defaultPrevented 才会翻 true)
  const key = (init) => new KeyboardEvent('keydown', { cancelable: true, ...init })

  it('普通 Enter → onEnter 且 preventDefault;普通 Esc → onEscape 且 preventDefault', () => {
    let entered = 0, escaped = 0
    const handler = enterEscKeydown({ onEnter: () => entered++, onEscape: () => escaped++ })
    const enter = key({ key: 'Enter', keyCode: 13 })
    handler(enter)
    expect(entered).toBe(1)
    expect(enter.defaultPrevented).toBe(true)
    const esc = key({ key: 'Escape', keyCode: 27 })
    handler(esc)
    expect(escaped).toBe(1)
    expect(esc.defaultPrevented).toBe(true)
  })

  it('IME 组合期 Enter/Esc → 不触发动作、也不 preventDefault(键交还输入法)', () => {
    let fired = 0
    const handler = enterEscKeydown({ onEnter: () => fired++, onEscape: () => fired++ })
    const enter = key({ key: 'Enter', isComposing: true, keyCode: 229 })
    handler(enter)
    const safariEnter = key({ key: 'Enter', isComposing: false, keyCode: 229 })
    handler(safariEnter)
    const esc = key({ key: 'Escape', isComposing: true, keyCode: 229 })
    handler(esc)
    expect(fired).toBe(0)
    expect(enter.defaultPrevented).toBe(false)
    expect(safariEnter.defaultPrevented).toBe(false)
    expect(esc.defaultPrevented).toBe(false)
  })

  it('其它键不触发动作;onEscape 缺省时 Esc 无动作;事件对象透传给回调', () => {
    let got = null
    const handler = enterEscKeydown({ onEnter: e => { got = e } })
    handler(key({ key: 'a', keyCode: 65 }))
    expect(got).toBeNull()
    const escHandler = enterEscKeydown({ onEnter: () => {} })
    const esc = key({ key: 'Escape', keyCode: 27 })
    escHandler(esc)
    const enter = key({ key: 'Enter', keyCode: 13 })
    handler(enter)
    expect(got).toBe(enter)
    expect(esc.defaultPrevented).toBe(false)
  })
})
