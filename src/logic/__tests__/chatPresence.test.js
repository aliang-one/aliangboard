// 悬浮对话纯逻辑:活跃定义(running/paused + 未读终答)、徽标优先级(paused>未读>running)、
// 已读 Map 的读写/防膨胀。时间全部注入,无 Date.now 直接断言。
import { test, expect, beforeEach } from 'vitest'
import {
  isUnread, visibleConversations, presenceState,
  loadReadAt, markRead, pruneReadAt,
} from '../chatPresence'

const T0 = 1_700_000_000_000

const conv = (over = {}) => ({ id: 'c1', projectId: 'p1', projectName: 'P1', title: null, status: 'running', updatedAt: T0, ...over })

beforeEach(() => localStorage.clear())

test('isUnread:仅终态可为未读;无 readAt 或 updatedAt>readAt 即未读', () => {
  expect(isUnread(conv({ status: 'running' }), {})).toBe(false)
  expect(isUnread(conv({ status: 'paused' }), {})).toBe(false)
  expect(isUnread(conv({ status: 'cancelled' }), {})).toBe(false)
  expect(isUnread(conv({ status: 'done', updatedAt: T0 }), {})).toBe(true)          // 从没读过
  expect(isUnread(conv({ status: 'done', updatedAt: T0 }), { c1: T0 })).toBe(false) // 读到点了
  expect(isUnread(conv({ status: 'done', updatedAt: T0 }), { c1: T0 - 1 })).toBe(true)
  expect(isUnread(conv({ status: 'failed', updatedAt: T0 }), { c1: T0 - 1 })).toBe(true)
})

test('visibleConversations:排除正在看的项目;排除已读终态;保留其余', () => {
  const convs = [
    conv({ id: 'a', projectId: 'here', status: 'running' }),                          // 正在看的项目 → 排除
    conv({ id: 'b', projectId: 'other', status: 'done', updatedAt: T0 }),             // 未读终态 → 保留
    conv({ id: 'c', projectId: 'other', status: 'done', updatedAt: T0 - 5 }),         // 已读终态 → 排除
    conv({ id: 'd', projectId: 'other', status: 'paused' }),                          // 保留
  ]
  const readAt = { c: T0 }
  expect(visibleConversations(convs, { currentProjectId: 'here', readAt }).map(c => c.id))
    .toEqual(['b', 'd'])
  // 不在任何项目页时(currentProjectId null),'a' 也保留
  expect(visibleConversations(convs, { currentProjectId: null, readAt }).map(c => c.id))
    .toEqual(['a', 'b', 'd'])
})

test('presenceState:空→不显示;优先级 paused > 未读终答 > running;单个直开', () => {
  expect(presenceState([], {})).toEqual({ show: false, level: 'none', icon: '', badgeCount: 0, directOpen: false })
  expect(presenceState([conv({ status: 'running' })], {}))
    .toEqual({ show: true, level: 'running', icon: 'progress_activity', badgeCount: 1, directOpen: true })
  const doneUnread = conv({ status: 'done', updatedAt: T0 })
  expect(presenceState([conv({ status: 'running' }), doneUnread], {}))
    .toEqual({ show: true, level: 'unread', icon: 'smart_toy', badgeCount: 2, directOpen: false })
  expect(presenceState([conv({ status: 'paused' }), doneUnread], {}))
    .toEqual({ show: true, level: 'paused', icon: 'pending_actions', badgeCount: 2, directOpen: false })
  // 已读终态不推高优先级
  expect(presenceState([conv({ id: 'x', status: 'running' }), conv({ status: 'done', updatedAt: T0 - 5 })], { x: 0, c1: T0 }).level)
    .toBe('running')
})

test('markRead/loadReadAt:roundtrip、不回退、多 id 一次写', () => {
  let m = markRead({}, ['a'], T0)
  m = markRead(m, ['a', 'b'], T0 + 100)
  expect(m).toEqual({ a: T0 + 100, b: T0 + 100 })
  m = markRead(m, ['a'], T0 + 50) // 更早的时间不回退
  expect(m.a).toBe(T0 + 100)
  expect(loadReadAt()).toEqual(m) // 已持久化
})

test('pruneReadAt:只保留仍活跃对话的条目', () => {
  const m = { keep: 1, drop: 2 }
  expect(pruneReadAt(m, ['keep'])).toEqual({ keep: 1 })
})
