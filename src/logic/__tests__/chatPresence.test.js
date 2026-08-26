// 近期动态模型纯逻辑(2026-08-17):窗口过滤在服务端,前端只排「正在看的项目」;
// readAt 仅驱动「新动态」徽标(点击不清条目)。时间全部注入。
import { test, expect, beforeEach } from 'vitest'
import {
  hasUpdate, visibleConversations, presenceState,
  loadReadAt, markRead, pruneReadAt,
} from '../chatPresence'

const T0 = 1_700_000_000_000
const conv = (over = {}) => ({ id: 'c1', projectId: 'p1', projectName: 'P1', title: null, status: 'running', updatedAt: T0, ...over })

beforeEach(() => localStorage.clear())

test('hasUpdate:无记录=有更新;等于=无;晚于=有;任意状态(running 的新动静也算)', () => {
  expect(hasUpdate(conv({ status: 'running', updatedAt: T0 }), {})).toBe(true)          // 没看过
  expect(hasUpdate(conv({ updatedAt: T0 }), { c1: T0 })).toBe(false)
  expect(hasUpdate(conv({ updatedAt: T0 + 1 }), { c1: T0 })).toBe(true)
  expect(hasUpdate(conv({ status: 'done', updatedAt: T0 + 1 }), { c1: T0 })).toBe(true)  // 终态新动静
})

test('visibleConversations:排当前项目的 running/终态;已读终态不再被滤(窗口过滤在服务端)', () => {
  const convs = [
    conv({ id: 'a', projectId: 'here', status: 'running' }),
    conv({ id: 'b', projectId: 'other', status: 'done', updatedAt: T0 }),  // 已读终态 → 保留(新模型)
  ]
  expect(visibleConversations(convs, { currentProjectId: 'here' }).map(c => c.id)).toEqual(['b'])
  expect(visibleConversations(convs, { currentProjectId: null }).map(c => c.id)).toEqual(['a', 'b'])
})

// 2026-08-26 修复:审批等人的对话(paused)不参与「正在看的项目」排除——用户正在该项目
// 工作台页时,若把本项目的 paused 也藏掉,审批就只剩悬浮 Modal 一处可见(用户报告:
// 「审批只在 modal 里出现,工作台里没弹出来」)。paused 是等人决策的紧急态,任何页面都必须露出。
test('visibleConversations:当前项目的 paused 不被排除(审批必须处处可见)', () => {
  const convs = [
    conv({ id: 'wait', projectId: 'here', status: 'paused' }),
    conv({ id: 'run', projectId: 'here', status: 'running' }),
    conv({ id: 'done', projectId: 'here', status: 'done', updatedAt: T0 }),
  ]
  expect(visibleConversations(convs, { currentProjectId: 'here' }).map(c => c.id)).toEqual(['wait'])
})

test('presenceState:空→不显示;paused > update > running;全读终态→idle', () => {
  expect(presenceState([], {})).toEqual({ show: false, level: 'none', icon: '', badgeCount: 0 })
  const seen = { a: T0, c1: T0 }
  expect(presenceState([conv({ id: 'a', status: 'paused' }), conv({ id: 'b', status: 'done', updatedAt: T0 })], seen))
    .toEqual({ show: true, level: 'paused', icon: 'pending_actions', badgeCount: 1 })
  expect(presenceState([conv({ id: 'a', updatedAt: T0 })], { a: T0 - 1 }).level).toBe('update')
  expect(presenceState([conv({ id: 'a', status: 'running', updatedAt: T0 })], { a: T0 }).level).toBe('running')
  // 全部是已读终态 → idle:常驻但安静(smart_toy 不转圈),未读数 0
  expect(presenceState([conv({ id: 'a', status: 'done', updatedAt: T0 })], { a: T0 }))
    .toEqual({ show: true, level: 'idle', icon: 'smart_toy', badgeCount: 0 })
})

test('presenceState.badgeCount = 未读数(有新动态的条数),读了就减', () => {
  const convs = [
    conv({ id: 'u1', status: 'running', updatedAt: T0 }),              // 未看 → 计
    conv({ id: 'u2', projectId: 'p2', projectName: 'P2', status: 'done', updatedAt: T0 }), // 未看 → 计
    conv({ id: 's1', projectId: 'p3', projectName: 'P3', status: 'running', updatedAt: T0 - 1 }), // readAt 晚于 → 已读不计
  ]
  expect(presenceState(convs, { s1: T0 }).badgeCount).toBe(2)
  expect(presenceState(convs, { u1: T0, u2: T0, s1: T0 }).badgeCount).toBe(0)
})

test('markRead/loadReadAt:roundtrip、不回退;pruneReadAt 保留 live', () => {
  let m = markRead({}, ['a'], T0)
  m = markRead(m, ['a', 'b'], T0 + 100)
  expect(m).toEqual({ a: T0 + 100, b: T0 + 100 })
  expect(markRead(m, ['a'], T0 + 50).a).toBe(T0 + 100)
  expect(loadReadAt()).toEqual(m)
  expect(pruneReadAt({ keep: 1, drop: 2 }, ['keep'])).toEqual({ keep: 1 })
})
