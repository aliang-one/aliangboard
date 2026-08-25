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
