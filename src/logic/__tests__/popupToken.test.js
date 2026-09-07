// src/logic/__tests__/popupToken.test.js
// 弹窗页 K8s session token 交接的消费端契约——2026-09-07 日志弹窗「会话已过期」事故的回归钉:
// 4d4eede 把消费分支收紧到 /terminal-popup,漏了同为 ?token= 消费者的 /log-popup,
// 导致 openLogTab 仍拼 URL token 但无人消费、新标签页 sessionStorage 恒空。
// 此测试直接钉住「/log-popup 也必须被消费分支覆盖」这一接线,防同类遗忘。
import { test, expect, beforeEach } from 'vitest'
import { writePopupTokenHandoff, consumePopupToken, TOKEN_HANDOFF_KEY, SESSION_KEY } from '../popupToken'

// 可注入存储桩(happy-dom 的 localStorage 也可用,但桩让「谁读了谁写了」显式可见)
function makeStorage() {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _map: map,
  }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

test('writePopupTokenHandoff: 写交接槽,存储不可用时静默降级', () => {
  writePopupTokenHandoff('tok-1')
  expect(localStorage.getItem(TOKEN_HANDOFF_KEY)).toBe('tok-1')
  const throwing = { setItem: () => { throw new Error('quota') } }
  expect(() => writePopupTokenHandoff('tok-1', throwing)).not.toThrow()
})

test('consumePopupToken: /log-popup 从交接槽读 token 写 sessionStorage,读后即焚(2026-09-07 事故回归)', () => {
  const ls = makeStorage()
  const ss = makeStorage()
  ls.setItem(TOKEN_HANDOFF_KEY, 'tok-log')
  consumePopupToken({ pathname: '/log-popup', search: '', localStorage: ls, sessionStorage: ss })
  expect(ss.getItem(SESSION_KEY)).toBe('tok-log')
  expect(ls._map.has(TOKEN_HANDOFF_KEY)).toBe(false)   // 读后即焚
})

test('consumePopupToken: /terminal-popup 交接槽路径不回退(既有行为保持)', () => {
  const ls = makeStorage()
  const ss = makeStorage()
  ls.setItem(TOKEN_HANDOFF_KEY, 'tok-term')
  consumePopupToken({ pathname: '/terminal-popup', search: '', localStorage: ls, sessionStorage: ss })
  expect(ss.getItem(SESSION_KEY)).toBe('tok-term')
  expect(ls._map.has(TOKEN_HANDOFF_KEY)).toBe(false)
})

test('consumePopupToken: legacy URL ?token= 仍被两弹窗路径兼容(旧链接/书签过渡)', () => {
  for (const pathname of ['/terminal-popup', '/log-popup']) {
    const ls = makeStorage()
    const ss = makeStorage()
    ls.setItem(TOKEN_HANDOFF_KEY, 'tok-slot')   // legacy 优先于槽?不——legacy 在则不烧槽
    consumePopupToken({ pathname, search: '?ns=a&token=tok-url', localStorage: ls, sessionStorage: ss })
    expect(ss.getItem(SESSION_KEY)).toBe('tok-url')
    expect(ls._map.has(TOKEN_HANDOFF_KEY)).toBe(true)   // legacy 命中时槽保留
  }
})

test('consumePopupToken: 非弹窗路径一律不动(主应用不受交接槽残留影响)', () => {
  const ls = makeStorage()
  const ss = makeStorage()
  ls.setItem(TOKEN_HANDOFF_KEY, 'tok-slot')
  for (const pathname of ['/', '/workbench', '/pods', '/login']) {
    consumePopupToken({ pathname, search: '?token=tok-url', localStorage: ls, sessionStorage: ss })
  }
  expect(ss._map.size).toBe(0)
  expect(ls.getItem(TOKEN_HANDOFF_KEY)).toBe('tok-slot')
})

test('consumePopupToken: 弹窗路径但槽与 URL 均无 token → 不写 sessionStorage(LogPopup 自行渲染过期页)', () => {
  const ls = makeStorage()
  const ss = makeStorage()
  consumePopupToken({ pathname: '/log-popup', search: '', localStorage: ls, sessionStorage: ss })
  expect(ss._map.size).toBe(0)
})
