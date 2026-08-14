// 纯函数测试:资源量 <-> {数值, 单位} 互转。ResourceInput 组件靠它把 "4000m"/"512Mi"
// 拆成「数字框 + 单位下拉」,再把 数字+单位 合成回 K8s 规范串,交给 buildResources 原样下发。
import { describe, it, expect } from 'vitest'
import { parseQuantity, formatQuantity, RESOURCE_UNITS } from '@/composables/useResourceQuantity'

describe('parseQuantity: K8s 串 → {数值, 单位}', () => {
  it('cpu: 4000m → 4000 + m', () => {
    expect(parseQuantity('4000m', 'cpu')).toEqual({ num: '4000', unit: 'm' })
  })
  it('cpu: 0.5 (cores, 无后缀) → 0.5 + 空', () => {
    expect(parseQuantity('0.5', 'cpu')).toEqual({ num: '0.5', unit: '' })
  })
  it('cpu: 2 → 2 + 空(cores)', () => {
    expect(parseQuantity('2', 'cpu')).toEqual({ num: '2', unit: '' })
  })
  it('cpu: 空串 → 空 + 默认(cores)', () => {
    expect(parseQuantity('', 'cpu')).toEqual({ num: '', unit: '' })
  })
  it('memory: 512Mi → 512 + Mi', () => {
    expect(parseQuantity('512Mi', 'memory')).toEqual({ num: '512', unit: 'Mi' })
  })
  it('memory: 1Gi → 1 + Gi', () => {
    expect(parseQuantity('1Gi', 'memory')).toEqual({ num: '1', unit: 'Gi' })
  })
  it('memory: 无后缀裸数 → 回退到 Mi', () => {
    expect(parseQuantity('256', 'memory')).toEqual({ num: '256', unit: 'Mi' })
  })
  it('非法输入(字母混入) → 清空 + 默认单位', () => {
    expect(parseQuantity('abc', 'cpu')).toEqual({ num: '', unit: '' })
  })
})

describe('formatQuantity: {数值, 单位} → K8s 串', () => {
  it('cpu cores 保留小数: 0.5 → "0.5"', () => {
    expect(formatQuantity('0.5', '', 'cpu')).toBe('0.5')
  })
  it('cpu m 取整: 4000 + m → "4000m"', () => {
    expect(formatQuantity('4000', 'm', 'cpu')).toBe('4000m')
  })
  it('cpu m 小数输入自动取整: 4000.7 → "4001m"', () => {
    expect(formatQuantity('4000.7', 'm', 'cpu')).toBe('4001m')
  })
  it('memory 取整 + 后缀: 512 + Mi → "512Mi"', () => {
    expect(formatQuantity('512', 'Mi', 'memory')).toBe('512Mi')
  })
  it('空数值 → 空串(清空)', () => {
    expect(formatQuantity('', 'm', 'cpu')).toBe('')
    expect(formatQuantity('', 'Mi', 'memory')).toBe('')
  })
  it('负数/非法 → 空串', () => {
    expect(formatQuantity('-5', 'm', 'cpu')).toBe('')
  })
  it('单位表定义正确', () => {
    expect(RESOURCE_UNITS.cpu.map(u => u.value)).toEqual(['', 'm'])
    expect(RESOURCE_UNITS.memory.map(u => u.value)).toEqual(['Mi', 'Gi', 'Ki', 'Ti'])
  })
})
