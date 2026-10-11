// toMi 十进制 SI 后缀换算(2026-10-11 工作流审计 #5 根修配套):
// '1G'/'512M'/'1500k' 类集群真值曾被按裸 Mi 处理——1G 的 limit 参考线画在 1Mi 位置(约 953 倍偏低)。
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })) } }))

import { toMi, toMilli } from '@/composables/useMetricsHistory'

describe('toMi: 全后缀量纲换算', () => {
  it('二进制后缀(既有行为不回归;亚 Mi 非零值 ≥1 参考线可见,与 toMilli 同款守卫)', () => {
    expect(toMi('1Ki')).toBe(1)
    expect(toMi('512Mi')).toBe(512)
    expect(toMi('1Gi')).toBe(1024)
    expect(toMi('1Ti')).toBe(1024 * 1024)
  })
  it('十进制 SI 后缀按 1000 进制换算(曾按裸 Mi)', () => {
    expect(toMi('1G')).toBe(954)            // 1e9/2^20 = 953.674 → 954
    expect(toMi('512M')).toBe(488)          // 512e6/2^20 = 488.28125 → 488
    expect(toMi('1k')).toBe(1)              // 1000/2^20 = 0.00095 → 守卫抬到 1
  })
  it('裸数字按字节换算(曾误当 Mi)', () => {
    expect(toMi('1048576')).toBe(1)
    expect(toMi('2097152')).toBe(2)
  })
  it('科学计数按值换算(审查修复:曾按裸前缀 1 画到 ~9.5e11 Mi)', () => {
    expect(toMi('1E9')).toBe(954)     // 1e9 bytes = 953.67 Mi
    expect(toMi('1e3')).toBe(1)       // 1000 bytes 亚 Mi → 守卫抬 1
  })
  it('toMilli n/u 后缀(既有正确行为钉住)', () => {
    expect(toMilli('100u')).toBe(1)
    expect(toMilli('2500000n')).toBe(3)     // 2.5m → Math.max(1, round(2.5)) = 3
  })
})
