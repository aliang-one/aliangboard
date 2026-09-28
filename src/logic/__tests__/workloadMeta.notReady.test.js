// issue#16 对抗审查 P1 回归:监控告警谓词按 kind 分治。
// 旧谓词 status!=='Running' 在 batch 入列后把健康终态(Succeeded Job)与正常空闲
// (Succeeded/Pending CronJob)永久标红,「一切正常」永不可达。
import { test, expect } from 'vitest'
import { isWorkloadNotReady } from '../workloadMeta'

test('apps 三类:非 Running 即异常(零回归)', () => {
  expect(isWorkloadNotReady({ type: 'Deployment', status: 'Degraded' })).toBe(true)
  expect(isWorkloadNotReady({ type: 'StatefulSet', status: 'Pending' })).toBe(true)
  expect(isWorkloadNotReady({ type: 'DaemonSet', status: 'Running' })).toBe(false)
})

test('Job:Succeeded 是健康终态不入告警;仅 Failed 异常', () => {
  expect(isWorkloadNotReady({ type: 'Job', status: 'Succeeded' })).toBe(false)
  expect(isWorkloadNotReady({ type: 'Job', status: 'Running' })).toBe(false)
  expect(isWorkloadNotReady({ type: 'Job', status: 'Pending' })).toBe(false)
  expect(isWorkloadNotReady({ type: 'Job', status: 'Failed' })).toBe(true)
})

test('CronJob:状态词表无异常态,恒不入告警(空闲/暂停/运行皆正常)', () => {
  expect(isWorkloadNotReady({ type: 'CronJob', status: 'Succeeded' })).toBe(false)
  expect(isWorkloadNotReady({ type: 'CronJob', status: 'Pending' })).toBe(false)
  expect(isWorkloadNotReady({ type: 'CronJob', status: 'Running' })).toBe(false)
})

test('空对象安全', () => {
  expect(isWorkloadNotReady(null)).toBe(false)
  expect(isWorkloadNotReady({})).toBe(false)
})
