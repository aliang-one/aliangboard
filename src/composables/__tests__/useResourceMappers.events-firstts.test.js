// Events 展开信息:mapEvent 直通 firstTimestamp 为 firstTs——Events tab / Pod 右列
// 时间线的展开面板展示「首次」用;缺失(事件只有 lastTimestamp)回落空串,UI 侧隐藏该行。
import { test, expect } from 'vitest'
import { mapEvent } from '@/composables/useResourceMappers'

test('mapEvent 直通 firstTimestamp 为 firstTs(与 time/age 同为 ageOf 相对格式)', () => {
  const now = Date.now()
  const e = mapEvent({
    metadata: { uid: 'u1', namespace: 'default', creationTimestamp: new Date(now - 60_000).toISOString() },
    involvedObject: { kind: 'Deployment', name: 'demo-deploy' },
    type: 'Warning', reason: 'BackOff', message: 'back-off restarting failed container', count: 3,
    firstTimestamp: new Date(now - 3600_000).toISOString(),
    lastTimestamp: new Date(now - 60_000).toISOString(),
  })
  expect(typeof e.firstTs).toBe('string')
  expect(e.firstTs).not.toBe('')
})

test('mapEvent 无 firstTimestamp 时 firstTs 为空串(展开面板隐藏首次行)', () => {
  const e = mapEvent({
    metadata: { uid: 'u2', namespace: 'default', creationTimestamp: new Date().toISOString() },
    involvedObject: { kind: 'Pod', name: 'p1' },
    type: 'Normal', reason: 'Created', message: 'Created container',
  })
  expect(e.firstTs).toBe('')
})
