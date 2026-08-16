// src/logic/workloadTransition.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workloadCounts, isWorkloadTransitioning, anyWorkloadTransitioning } from './workloadTransition.js'

// K8s 真实结构:generation 在 metadata 下,observedGeneration 在 status 下
function k8s(kind, spec, status, generation, observedGeneration) {
  return {
    kind,
    metadata: { name: 'x', ...(generation != null ? { generation } : {}) },
    spec,
    status: { ...(observedGeneration != null ? { observedGeneration } : {}), ...status },
  }
}

test('workloadCounts: Deployment 取数与默认值', () => {
  assert.deepEqual(workloadCounts(k8s('Deployment', { replicas: 3 }, { readyReplicas: 2, updatedReplicas: 3, replicas: 3 })), { desired: 3, updated: 3, ready: 2, total: 3 })
  assert.deepEqual(workloadCounts(k8s('Deployment', {}, {})), { desired: 1, updated: 0, ready: 0, total: 0 })
})

test('workloadCounts: DaemonSet 用 scheduled 系列字段', () => {
  const raw = k8s('DaemonSet', {}, { desiredNumberScheduled: 5, updatedNumberScheduled: 4, numberReady: 4, currentNumberScheduled: 5 })
  assert.deepEqual(workloadCounts(raw), { desired: 5, updated: 4, ready: 4, total: 5 })
})

test('workloadCounts: kind 缺失按 replicas 公式;null 安全', () => {
  assert.equal(workloadCounts({ spec: {}, status: {} }).desired, 1)
  assert.deepEqual(workloadCounts(undefined), { desired: 1, updated: 0, ready: 0, total: 0 })
})

test('isWorkloadTransitioning: 扩容中(ready<desired)→ true', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 3 }, { readyReplicas: 1, updatedReplicas: 1 })), true)
})

test('isWorkloadTransitioning: 滚动中(updated<desired)→ true', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 3 }, { readyReplicas: 3, updatedReplicas: 2 })), true)
})

test('isWorkloadTransitioning: 刚 apply 未观测(generation>observedGeneration)→ true', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 1 }, { readyReplicas: 1, updatedReplicas: 1 }, 5, 4)), true)
})

test('isWorkloadTransitioning: 全收敛 → false', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 3 }, { readyReplicas: 3, updatedReplicas: 3, replicas: 3 }, 5, 5)), false)
})

test('isWorkloadTransitioning: 缩容到 0 → false(不误报)', () => {
  assert.equal(isWorkloadTransitioning(k8s('Deployment', { replicas: 0 }, { readyReplicas: 0, updatedReplicas: 0, replicas: 0 }, 2, 2)), false)
})

test('isWorkloadTransitioning: DaemonSet 三维判定', () => {
  assert.equal(isWorkloadTransitioning(k8s('DaemonSet', {}, { desiredNumberScheduled: 5, updatedNumberScheduled: 3, numberReady: 5 })), true)
  assert.equal(isWorkloadTransitioning(k8s('DaemonSet', {}, { desiredNumberScheduled: 5, updatedNumberScheduled: 5, numberReady: 4 })), true)
  assert.equal(isWorkloadTransitioning(k8s('DaemonSet', {}, { desiredNumberScheduled: 5, updatedNumberScheduled: 5, numberReady: 5 })), false)
})

test('isWorkloadTransitioning: Job/CronJob/未知 kind 恒 false', () => {
  assert.equal(isWorkloadTransitioning(k8s('Job', {}, { active: 3 })), false)
  assert.equal(isWorkloadTransitioning(k8s('CronJob', {}, {})), false)
  assert.equal(isWorkloadTransitioning({ spec: {}, status: {} }), false)
  assert.equal(isWorkloadTransitioning(undefined), false)
})

test('anyWorkloadTransitioning: 任一进行中/全收敛/空安全', () => {
  const busy = k8s('Deployment', { replicas: 3 }, { readyReplicas: 1 })
  const ok = k8s('Deployment', { replicas: 2 }, { readyReplicas: 2, updatedReplicas: 2 })
  assert.equal(anyWorkloadTransitioning([ok, busy]), true)
  assert.equal(anyWorkloadTransitioning([ok]), false)
  assert.equal(anyWorkloadTransitioning([]), false)
  assert.equal(anyWorkloadTransitioning(undefined), false)
})
