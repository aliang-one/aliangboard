import { test, expect } from 'vitest'
import { aggregatePvcUsage } from '../usePvcUsage'

test('aggregate: 1 pod → stats pvcRef → percent=30, mounted=true', async () => {
  const deps = {
    listPods: async () => ({ items: [{ metadata: { name: 'app' }, spec: { nodeName: 'n1', volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'pvc1' } }] } }] }),
    nodeStats: async () => ({ pods: [{ podRef: { name: 'app' }, volume: [{ name: 'data', usedBytes: 3221225472, capacityBytes: 10737418240, pvcRef: { name: 'pvc1', namespace: 'ns1' } }] }] }),
  }
  const { usage, noStatsAccess } = await aggregatePvcUsage('ns1', deps)
  expect(usage.get('pvc1')).toEqual({ usedBytes: 3221225472, capacityBytes: 10737418240, percent: 30, mounted: true })
  expect(noStatsAccess).toBe(false)
})

test('aggregate: RWX 多挂载取 max usedBytes', async () => {
  const deps = {
    listPods: async () => ({ items: [
      { metadata: { name: 'a' }, spec: { nodeName: 'n1', volumes: [{ name: 'v', persistentVolumeClaim: { claimName: 'pvc1' } }] } },
      { metadata: { name: 'b' }, spec: { nodeName: 'n1', volumes: [{ name: 'v', persistentVolumeClaim: { claimName: 'pvc1' } }] } },
    ] }),
    nodeStats: async () => ({ pods: [
      { podRef: { name: 'a' }, volume: [{ name: 'v', usedBytes: 1000, capacityBytes: 10000, pvcRef: { name: 'pvc1', namespace: 'ns1' } }] },
      { podRef: { name: 'b' }, volume: [{ name: 'v', usedBytes: 3000, capacityBytes: 10000, pvcRef: { name: 'pvc1', namespace: 'ns1' } }] },
    ] }),
  }
  const { usage } = await aggregatePvcUsage('ns1', deps)
  expect(usage.get('pvc1').usedBytes).toBe(3000)
  expect(usage.get('pvc1').percent).toBe(30)
})

test('aggregate: 无 pod 引用 → map 空,noStatsAccess=false(targetNodes 空)', async () => {
  const deps = { listPods: async () => ({ items: [] }), nodeStats: async () => ({ pods: [] }) }
  const { usage, noStatsAccess } = await aggregatePvcUsage('ns1', deps)
  expect(usage.size).toBe(0)
  expect(noStatsAccess).toBe(false)
})

test('aggregate: 全 node stats 失败 → noStatsAccess=true,mounted 仍 true,用量 null,不抛', async () => {
  const deps = {
    listPods: async () => ({ items: [{ metadata: { name: 'a' }, spec: { nodeName: 'n1', volumes: [{ name: 'v', persistentVolumeClaim: { claimName: 'pvc1' } }] } }] }),
    nodeStats: async () => { throw new Error('403') },
  }
  const { usage, noStatsAccess } = await aggregatePvcUsage('ns1', deps)
  expect(usage.get('pvc1')).toEqual({ usedBytes: null, capacityBytes: null, percent: null, mounted: true })
  expect(noStatsAccess).toBe(true)
})

test('aggregate: 无 pvcRef 时按 {podName,volumeName} 兜底匹配', async () => {
  const deps = {
    listPods: async () => ({ items: [{ metadata: { name: 'a' }, spec: { nodeName: 'n1', volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'pvc1' } }] } }] }),
    nodeStats: async () => ({ pods: [{ podRef: { name: 'a' }, volume: [{ name: 'data', usedBytes: 500, capacityBytes: 1000 }] }] }),
  }
  const { usage } = await aggregatePvcUsage('ns1', deps)
  expect(usage.get('pvc1')).toEqual({ usedBytes: 500, capacityBytes: 1000, percent: 50, mounted: true })
})
