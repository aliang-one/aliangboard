// fmtResult 搬迁回归:断言与 ToolTrace 时代逐字一致的行为(搬迁前固化)。
import { test, expect } from 'vitest'
import { fmtResult } from '@/utils/toolResultFormat'

test('string 结果原样返回', () => {
  expect(fmtResult({ name: 'wb_get_pod_logs', result: 'raw text' })).toBe('raw text')
})

test('wb_get_pod_logs:取 r.logs', () => {
  expect(fmtResult({ name: 'wb_get_pod_logs', result: { logs: 'line1\nline2', tail: 200 } })).toBe('line1\nline2')
})

test('wb_describe_resource:kind/name + phase', () => {
  const out = fmtResult({ name: 'wb_describe_resource', result: { resource: { kind: 'Pod', metadata: { name: 'p1', namespace: 'ns1' }, status: { phase: 'Running' } }, events: { count: 0, items: [] } } })
  expect(out).toContain('Pod/p1 (ns1)')
  expect(out).toContain('phase: Running')
})

test('wb_top:百分比行 + ≥80% 带 ⚠', () => {
  const out = fmtResult({ name: 'wb_top', result: { scope: 'pods', namespace: 'ns1', items: [{ name: 'p1', containers: [{ name: 'c1', cpu: '100m', memory: '1Gi', cpuPct: 95, memoryPct: 50 }] }] } })
  expect(out).toContain('p1/c1')
  expect(out).toContain('cpu 95% ⚠')
  expect(out).toContain('mem 50%')
})

test('未知工具对象结果:JSON pretty 兜底', () => {
  expect(fmtResult({ name: 'wb_unknown', result: { a: 1 } })).toBe(JSON.stringify({ a: 1 }, null, 2))
})

test('result null:空串', () => {
  expect(fmtResult({ name: 'wb_get_pod_logs', result: null })).toBe('')
})

import { applyLegacyTs } from '@/utils/toolResultFormat'

test('applyLegacyTs:无 ts 的历史事件用轮次时刻兜底,已有 ts 不动', () => {
  const evts = [{ type: 'tool', name: 'a' }, { type: 'tool', name: 'b', ts: 111 }]
  const out = applyLegacyTs(evts, 1756100000000)
  expect(out[0].ts).toBe(1756100000000)
  expect(out[1].ts).toBe(111)          // 已有 ts 保留
  expect(evts[0].ts).toBe(1756100000000) // 原数组就地补(重建路径每次 JSON.parse 新数组,安全)
})

test('applyLegacyTs:空数组/空兜底安全', () => {
  expect(applyLegacyTs([], 1)).toEqual([])
  expect(applyLegacyTs([{ type: 'tool', name: 'a' }], null)[0].ts).toBeUndefined()
})
