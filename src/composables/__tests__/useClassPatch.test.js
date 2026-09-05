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

// 全参数结构化编辑(2026-09-05):controller/parameters/labels/annotations 手术式合并。
// parameters 语义:undefined=不动;null=整体删除(merge-patch);对象=设置。
describe('buildIngressClassPatch 全参数扩展', () => {
  const BASE = {
    name: 'nginx',
    controller: 'k8s.io/ingress-nginx',
    isDefault: false,
    labels: { team: 'edge' },
    annotations: { note: 'x' },
    parameters: { apiGroup: 'k8s.example.com', kind: 'NginxConfiguration', name: 'cfg' },
  }

  it('controller 变更 → spec.controller;未变不写', () => {
    expect(buildIngressClassPatch(BASE, { controller: 'k8s.io/other' }))
      .toEqual({ spec: { controller: 'k8s.io/other' } })
    expect(buildIngressClassPatch(BASE, { controller: 'k8s.io/ingress-nginx' })).toBeNull()
  })

  it('parameters 置 null → 整体删除;已空时 null 幂等', () => {
    expect(buildIngressClassPatch(BASE, { parameters: null }))
      .toEqual({ spec: { parameters: null } })
    expect(buildIngressClassPatch({ ...BASE, parameters: null }, { parameters: null })).toBeNull()
  })

  it('parameters 对象变更 → 设置;未提及(undefined)不动', () => {
    const next = { kind: 'ConfigMap', name: 'other-cfg' }
    expect(buildIngressClassPatch(BASE, { parameters: next }))
      .toEqual({ spec: { parameters: next } })
    expect(buildIngressClassPatch(BASE, {})).toBeNull()
  })

  it('labels diff:增/改/删(null)', () => {
    expect(buildIngressClassPatch(BASE, { labels: { team: 'core', new: '1' } }))
      .toEqual({ metadata: { labels: { team: 'core', new: '1' } } })
    expect(buildIngressClassPatch(BASE, { labels: {} }))
      .toEqual({ metadata: { labels: { team: null } } })
  })

  it('annotations diff 排除 is-default 键;与 isDefault 分支合并不互覆', () => {
    const withDefault = { ...BASE, isDefault: true, annotations: { note: 'x', [INGRESSCLASS_DEFAULT_KEY]: 'true' } }
    // 仅 annotations:is-default 键不参与 diff(由 promote/demote 管)
    expect(buildIngressClassPatch(withDefault, { annotations: { note: 'y' } }))
      .toEqual({ metadata: { annotations: { note: 'y' } } })
    // isDefault + annotations 同时改:合并进同一 annPatch
    const p = buildIngressClassPatch(BASE, { isDefault: true, annotations: { note: 'y' } })
    expect(p.metadata.annotations).toEqual({ [INGRESSCLASS_DEFAULT_KEY]: 'true', note: 'y' })
  })

  it('spec+metadata 联合改动进同一 patch;全无改动 → null', () => {
    const p = buildIngressClassPatch(BASE, { controller: 'k8s.io/other', labels: { team: 'core' } })
    expect(p).toEqual({ spec: { controller: 'k8s.io/other' }, metadata: { labels: { team: 'core' } } })
    expect(buildIngressClassPatch(BASE, { controller: BASE.controller, labels: { team: 'edge' }, annotations: { note: 'x' }, parameters: BASE.parameters })).toBeNull()
  })
})
