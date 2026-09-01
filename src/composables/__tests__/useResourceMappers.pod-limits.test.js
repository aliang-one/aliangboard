// mapPod 资源用量分母契约:优先 limits、缺省回退 requests(2026-09-01 溢出标红事故固化)。
// 事故:req=512Mi/limit=2048Mi/used=1024Mi 时,分母误用 request → 200% 封顶 100% → 满格标红;
// 且展示串成 "1024Mi/512Mi"(分子大于分母)。正确读法:用量条分母 = 容器上限(超限 throttle/OOMKill),
// limits 未设(K8s 常态:只设 requests)才回退 requests 承诺量。
// usePod.podCpuPct/podMemPct 与 mapPod 展示串必须同分母(单一事实源,PodDetail 重复实现已收编)。
import { test, expect } from 'vitest'
import { mapPod } from '../useResourceMappers'
import { podCpuPct, podMemPct, pctRatio } from '../usePod'

const BASE = {
  metadata: { name: 'web-abc', namespace: 'demo' },
  status: { phase: 'Running' },
  spec: { nodeName: 'node-1', containers: [{ name: 'main' }] },
}
const METRIC_1024Mi = { cpuMilli: 124, memKi: 1024 * 1024 } // used: 124m / 1024Mi

test('mapPod:limits 存在时分母=limit(用户事故场景 req512Mi/lim2048Mi/used1024Mi)', () => {
  const item = {
    ...BASE,
    spec: { containers: [{ resources: { requests: { cpu: '100m', memory: '512Mi' }, limits: { cpu: '500m', memory: '2048Mi' } } }] },
  }
  const p = mapPod(item, METRIC_1024Mi)
  expect(p.memory).toBe('1024Mi/2048Mi') // 不再是 1024Mi/512Mi
  expect(p.cpu).toBe('124m/500m')
  expect(p.limMem).toBe(2048 * 1024)
  expect(p.limCpu).toBe(500)
  expect(podMemPct(p)).toBe(50) // 不再 200→封顶 100
  expect(podCpuPct(p)).toBe(25)
})

test('mapPod:limits 未设(只设 requests)回退 request 作分母', () => {
  const item = {
    ...BASE,
    spec: { containers: [{ resources: { requests: { cpu: '100m', memory: '512Mi' } } }] },
  }
  const p = mapPod(item, { cpuMilli: 124, memKi: 512 * 1024 })
  expect(p.memory).toBe('512Mi/512Mi')
  expect(p.limMem).toBe(0)
  expect(podMemPct(p)).toBe(100) // 用满承诺量=100%,语义成立
})

test('mapPod:多容器部分容器未设 limits → 无可信上限,整体回退 request 分母', () => {
  const item = {
    ...BASE,
    spec: {
      containers: [
        { resources: { requests: { memory: '512Mi' }, limits: { memory: '1024Mi' } } },
        { resources: { requests: { memory: '512Mi' } } }, // 无 limit(不设上限)
      ],
    },
  }
  const p = mapPod(item, { cpuMilli: 0, memKi: 768 * 1024 })
  expect(p.memory).toBe('768Mi/1024Mi') // 分母=requests 总和(512+512),不是部分 limits(1024)
  expect(podMemPct(p)).toBe(75)
})

test('pct 函数:旧结构(无 limCpu/limMem 字段)回退 req 字段,向后兼容', () => {
  const legacy = { usedCpu: 90, reqCpu: 100, usedMem: 256 * 1024, reqMem: 512 * 1024 }
  expect(podCpuPct(legacy)).toBe(90)
  expect(podMemPct(legacy)).toBe(50)
})

test('pct 函数:仅字符串时解析 used/total(展示串分母已由 mapPod 切到 limit)', () => {
  expect(pctRatio('1024Mi/2048Mi')).toBe(50)
  expect(pctRatio('0/0')).toBe(0)
})

test('pct 函数:无任何分母数据返回 0,不 NaN', () => {
  expect(podMemPct({ usedMem: 100 })).toBe(0)
  expect(podCpuPct({})).toBe(0)
})
