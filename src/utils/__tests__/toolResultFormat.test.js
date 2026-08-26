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

// wb_exec exitCode 契约(2026-08-26 exit=[object Object] bug):服务端已修为数字;
// 存量 trace 里 exitCode 是 V1Status 对象,fmtExec 须就地解析成数字显示。
test('wb_exec:数字 exitCode 正常;存量 V1Status 对象形态就地解析(不显示 [object Object])', () => {
  expect(fmtResult({ name: 'wb_exec', result: { exitCode: 0, stdout: 'ok' } })).toContain('exit=0')
  // 用户实测样本形态:db-migrate 失败,码在 details.causes[reason=ExitCode].message
  const legacy = { exitCode: { kind: 'Status', status: 'Failure', reason: 'NonZeroExitCode', message: 'command terminated with non-zero exit code: 1', details: { causes: [{ reason: 'ExitCode', message: '1' }] } }, stdout: '', stderr: 'PostgresError: schema "auth" does not exist', timedOut: false, truncated: false }
  const out = fmtResult({ name: 'wb_exec', result: legacy })
  expect(out).toContain('exit=1')
  expect(out).not.toContain('[object Object]')
  // 存量成功形态:{status:'Success'} → 0
  expect(fmtResult({ name: 'wb_exec', result: { exitCode: { status: 'Success' }, stdout: 'x' } })).toContain('exit=0')
  // 无码(null/无 ExitCode cause 的 Failure)→ ?
  expect(fmtResult({ name: 'wb_exec', result: { exitCode: null, stdout: '' } })).toContain('exit=?')
  expect(fmtResult({ name: 'wb_exec', result: { exitCode: { status: 'Failure', reason: 'BadRequest' }, stdout: '' } })).toContain('exit=?')
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
