import { describe, it, expect } from 'vitest'
import { buildIngressClassPatch, INGRESSCLASS_DEFAULT_KEY } from '../useClassPatch'

// spec §3.2:IC 单键;设默认写 'true',取消默认走 null 删除(不留 'false' 尸体);无改动返回 null。
describe('buildIngressClassPatch', () => {
  it('设默认:写注解 true', () => {
    const p = buildIngressClassPatch({ name: 'nginx', isDefault: false }, { isDefault: true })
    expect(p).toEqual({ metadata: { annotations: { [INGRESSCLASS_DEFAULT_KEY]: 'true' } } })
  })
  it('取消默认:注解置 null(merge-patch 删除语义)', () => {
    const p = buildIngressClassPatch({ name: 'nginx', isDefault: true }, { isDefault: null })
    expect(p).toEqual({ metadata: { annotations: { [INGRESSCLASS_DEFAULT_KEY]: null } } })
  })
  it('状态未变 → null(不发起空 PATCH)', () => {
    expect(buildIngressClassPatch({ isDefault: true }, { isDefault: true })).toBeNull()
    expect(buildIngressClassPatch({ isDefault: false }, { isDefault: false })).toBeNull()
    expect(buildIngressClassPatch({}, {})).toBeNull()
  })
  it('无默认对象上取消默认(幂等)→ null', () => {
    expect(buildIngressClassPatch({ isDefault: false }, { isDefault: null })).toBeNull()
  })
})
