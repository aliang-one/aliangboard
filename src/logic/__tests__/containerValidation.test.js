// quantityValue/compareQuantity 完整文法换算 + 浮点容差比较(2026-10-11 换算层根修配套)。
// 曾沿 parseQuantity 的 UI 单位表回退:compareQuantity('100u','250m') 误判 1(真值 -1)、
// ('2G','1Gi') 误判 -1(真值 1)——requests≤limits 校验假阳性阻断合法保存/假阴性漏成 422。
import { describe, it, expect } from 'vitest'
import { quantityValue, compareQuantity, validateContainerFields } from '@/logic/containerValidation'

describe('quantityValue: 完整 K8s quantity 文法 → 基准数值', () => {
  it('cpu 十进制后缀链', () => {
    expect(quantityValue('250m', 'cpu')).toBe(250)
    expect(quantityValue('0.5', 'cpu')).toBe(500)
    expect(quantityValue('100u', 'cpu')).toBeCloseTo(0.1, 10)
    expect(quantityValue('2500000n', 'cpu')).toBeCloseTo(2.5, 10)
  })
  it('memory 十进制 SI / 二进制 / 裸字节', () => {
    expect(quantityValue('1Gi', 'memory')).toBe(1024 ** 2)
    expect(quantityValue('1G', 'memory')).toBeCloseTo(1e9 / 1024, 6)
    expect(quantityValue('512M', 'memory')).toBeCloseTo((512 * 1e6) / 1024, 6)
  })
  it('空/非法 → null', () => {
    expect(quantityValue('', 'cpu')).toBe(null)
    expect(quantityValue('abc', 'memory')).toBe(null)
  })
})

describe('compareQuantity: 真实量纲比较 + 浮点容差', () => {
  it('100u ≤ 250m(曾是假阳性「超限」)', () => {
    expect(compareQuantity('100u', '250m', 'cpu')).toBe(-1)
  })
  it('2G > 1Gi(曾是假阴性漏到 apiserver 422)', () => {
    expect(compareQuantity('2G', '1Gi', 'memory')).toBe(1)
  })
  it('等值跨单位表示判相等(0.1 cores = 100m;500m = 0.5 cores)', () => {
    expect(compareQuantity('0.1', '100m', 'cpu')).toBe(0)
    expect(compareQuantity('500m', '0.5', 'cpu')).toBe(0)
  })
  it('跨进制等值不误判(512Mi vs 0.5Gi)', () => {
    expect(compareQuantity('512Mi', '0.5Gi', 'memory')).toBe(0)
  })
})

describe('validateContainerFields: 外来串参与 req≤lim 校验不再失真', () => {
  it('100u 请求 + 250m 上限 → 合法不报', () => {
    const errs = validateContainerFields({ image: 'nginx', cpuRequest: '100u', cpuLimit: '250m', memoryRequest: '', memoryLimit: '' })
    expect(errs.filter(e => e.field === 'cpu')).toEqual([])
  })
  it('2000m 请求 + 500m 上限 → 报 cpuOverLimit', () => {
    const errs = validateContainerFields({ image: 'nginx', cpuRequest: '2000m', cpuLimit: '500m', memoryRequest: '', memoryLimit: '' })
    expect(errs.some(e => e.field === 'cpu' && e.msgKey === 'deploy.containerFv.cpuOverLimit')).toBe(true)
  })
  it('2G 请求 + 1Gi 上限(真超限)→ 报 memoryOverLimit', () => {
    const errs = validateContainerFields({ image: 'nginx', cpuRequest: '', cpuLimit: '', memoryRequest: '2G', memoryLimit: '1Gi' })
    expect(errs.some(e => e.field === 'memory' && e.msgKey === 'deploy.containerFv.memoryOverLimit')).toBe(true)
  })
})
