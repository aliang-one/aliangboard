// useAlertReadState:告警铃铛已读状态(按集群隔离,localStorage 持久,uid 上限防膨胀)。
// 纯函数导出 + 组合式包装;事件形状 = useResourceMappers.mapEvent 产物。
import { describe, it, expect, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { loadReadUids, saveReadUids, unreadWarnings, eventKey, MAX_READ_UIDS, useAlertReadState } from '../useAlertReadState'

beforeEach(() => { localStorage.clear() })

const warn = (uid, extra = {}) => ({ uid, type: 'warning', reason: 'BackoffLimitExceeded', namespace: 'api', relatedName: 'job-7d9', ...extra })

describe('loadReadUids/saveReadUids', () => {
  it('roundtrip:save 后 load 读回', () => {
    saveReadUids('prod', ['u1', 'u2'])
    expect(loadReadUids('prod')).toEqual(['u1', 'u2'])
  })
  it('损坏 JSON → 空数组(防御式读,不抛)', () => {
    localStorage.setItem('ab.alertsRead.prod', '{not json')
    expect(loadReadUids('prod')).toEqual([])
  })
  it('非数组值(字符串/对象)→ 空数组', () => {
    localStorage.setItem('ab.alertsRead.prod', '"abc"')
    expect(loadReadUids('prod')).toEqual([])
    localStorage.setItem('ab.alertsRead.prod', '{"a":1}')
    expect(loadReadUids('prod')).toEqual([])
  })
  it('上限 MAX_READ_UIDS:超出保留最新(尾部)', () => {
    const uids = Array.from({ length: MAX_READ_UIDS + 100 }, (_, i) => `u${i}`)
    saveReadUids('prod', uids)
    const loaded = loadReadUids('prod')
    expect(loaded).toHaveLength(MAX_READ_UIDS)
    expect(loaded[0]).toBe(`u${100}`)       // 旧头部被裁
    expect(loaded.at(-1)).toBe(`u${uids.length - 1}`)
  })
  it('集群键隔离:prod 的已读不泄漏到 staging', () => {
    saveReadUids('prod', ['u1'])
    expect(loadReadUids('staging')).toEqual([])
  })
})

describe('eventKey / unreadWarnings', () => {
  it('eventKey:uid 优先,缺 uid 退化为 ns/reason/relatedName 复合键(可追踪不永久未读)', () => {
    expect(eventKey({ uid: 'u9' })).toBe('u9')
    expect(eventKey({ uid: '', namespace: 'api', reason: 'Failed', relatedName: 'p1' })).toBe('api/Failed/p1')
  })
  it('unreadWarnings:只算 warning 且未在已读集合', () => {
    const events = [
      warn('u1'),
      warn('u2'),
      { uid: 'u3', type: 'normal', reason: 'Pulled', namespace: 'api', relatedName: 'p1' },
    ]
    expect(unreadWarnings(events, ['u1'])).toEqual([events[1]])
  })
  it('空 events → 空数组', () => {
    expect(unreadWarnings(undefined, [])).toEqual([])
  })
})

describe('useAlertReadState(组合式)', () => {
  it('markAllRead 合并写入并刷新 readUids;切集群键重载', async () => {
    const key = ref('prod')
    const { readUids, markAllRead } = useAlertReadState(key)
    expect(readUids.value).toEqual([])
    markAllRead([warn('u1'), warn('u2')])
    expect(readUids.value).toContain('u1')
    expect(loadReadUids('prod')).toContain('u2')
    key.value = 'staging'
    await nextTick()                        // watch 异步 flush 后重载新账本
    expect(readUids.value).toEqual([])      // 换集群 → 各自账本
  })
  it('重复 markAllRead 幂等(uid 集合不重复膨胀)', () => {
    const { readUids, markAllRead } = useAlertReadState(ref('prod'))
    markAllRead([warn('u1')])
    markAllRead([warn('u1')])
    expect(readUids.value.filter(u => u === 'u1')).toHaveLength(1)
  })
})
