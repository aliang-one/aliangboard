// popupSync 弹窗↔opener 信令契约(2026-09-01 终端状态管理修复):
// 背景:opener 此前仅靠内存 popupWins + 2s win.closed 轮询感知弹窗,opener 一刷新即永久失明
// (症状:关了还提示开着 / 再点击在本页复活浮窗)。现在弹窗页持续发「存活信标」、关闭发「墓碑」。
// ①alive/closed 两键;payload 带随机 n——storage 事件只在新旧值不同时触发,同 sid 连续两次关闭也须能通知
// ②onPopupSync 只分发本工具两键;坏 JSON 忽略;退订干净
// ③startPopupHeartbeat:立即发信标 + 心跳续约;pagehide(关闭/刷新)发墓碑;stop 全清;空 sid no-op
import { test, expect, vi, afterEach } from 'vitest'
import {
  POPUP_ALIVE_KEY, POPUP_CLOSED_KEY,
  announcePopupAlive, writePopupTombstone, startPopupHeartbeat, onPopupSync,
} from '../popupSync'

afterEach(() => { localStorage.clear(); vi.useRealTimers() })

const read = key => { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null }
const fire = (key, val) => window.dispatchEvent(new StorageEvent('storage', { key, newValue: val }))

test('announcePopupAlive / writePopupTombstone:写对应键,带 kind/sid/meta', () => {
  announcePopupAlive('ssh', 's1', { serverId: 'sv1', name: 'gw' })
  expect(read(POPUP_ALIVE_KEY)).toMatchObject({ kind: 'ssh', sid: 's1', meta: { serverId: 'sv1', name: 'gw' } })
  writePopupTombstone('pod', 'p1')
  expect(read(POPUP_CLOSED_KEY)).toMatchObject({ kind: 'pod', sid: 'p1' })
})

test('同 sid 连续两次写:n 变体保证 payload 变化(storage 事件需要值不同才触发)', () => {
  announcePopupAlive('pod', 'p1')
  const first = read(POPUP_ALIVE_KEY)
  announcePopupAlive('pod', 'p1')
  expect(read(POPUP_ALIVE_KEY).n).not.toBe(first.n)
})

test('onPopupSync:只分发两键且形状正确;他键/坏 JSON 忽略;退订后不再收', () => {
  const seen = []
  const off = onPopupSync(sig => seen.push(sig))
  try {
    fire(POPUP_ALIVE_KEY, JSON.stringify({ kind: 'ssh', sid: 's1', meta: { a: 1 }, at: 1, n: 'x' }))
    fire(POPUP_CLOSED_KEY, JSON.stringify({ kind: 'pod', sid: 'p2', at: 2, n: 'y' }))
    fire('aliangboard.ssh.windows', JSON.stringify([]))
    fire(POPUP_ALIVE_KEY, '{broken')
    expect(seen).toEqual([
      { type: 'alive', kind: 'ssh', sid: 's1', meta: { a: 1 } },
      { type: 'closed', kind: 'pod', sid: 'p2', meta: {} },
    ])
  } finally { off() }
  seen.length = 0
  fire(POPUP_ALIVE_KEY, JSON.stringify({ kind: 'ssh', sid: 's9', meta: {}, at: 3, n: 'z' }))
  expect(seen).toEqual([])
})

test('startPopupHeartbeat:立即发信标 + 心跳续约;pagehide 发墓碑;stop 后不再续约', () => {
  vi.useFakeTimers()
  const stop = startPopupHeartbeat('pod', 'p1', { podName: 'pod-a' }, 1000)
  expect(read(POPUP_ALIVE_KEY)).toMatchObject({ kind: 'pod', sid: 'p1' })
  const v1 = read(POPUP_ALIVE_KEY)
  vi.advanceTimersByTime(1000)
  expect(read(POPUP_ALIVE_KEY).n).not.toBe(v1.n)
  window.dispatchEvent(new Event('pagehide'))
  expect(read(POPUP_CLOSED_KEY)).toMatchObject({ kind: 'pod', sid: 'p1' })
  stop()
  const dead = localStorage.getItem(POPUP_ALIVE_KEY)
  vi.advanceTimersByTime(10000)
  expect(localStorage.getItem(POPUP_ALIVE_KEY)).toBe(dead)   // 停止后心跳停摆(值不再变化)
})

test('startPopupHeartbeat:空 sid 直接 no-op(手输 URL 无 sid 的场景)', () => {
  const stop = startPopupHeartbeat('pod', '')
  expect(read(POPUP_ALIVE_KEY)).toBeNull()
  stop()
})
