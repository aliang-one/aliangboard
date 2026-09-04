import { describe, it, expect } from 'vitest'
import { mapIngressClass, mapRuntimeClass } from '../useResourceMappers'

// 回归锚:详情页 Overview 的可见性依赖 mapper 保留 labels/annotations 与
// spec.parameters(IngressClass)/overhead+scheduling(RuntimeClass)。
// 2026-09-04 前 mapper 只留 3 字段,详情页这些区块将恒空——此测试钉住不回退。
// 注意:RuntimeClass 无 spec(与 PriorityClass 同为顶层字段资源),handler 读 spec 是存量 bug,一并钉死。

const INGRESS_CLASS_RAW = {
  metadata: {
    name: 'nginx',
    creationTimestamp: '2026-08-05T00:00:00Z',
    labels: { team: 'edge' },
    annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' },
  },
  spec: {
    controller: 'k8s.io/ingress-nginx',
    parameters: { apiGroup: 'k8s.example.com', kind: 'NginxConfiguration', name: 'nginx-config' },
  },
}

const RUNTIME_CLASS_RAW = {
  metadata: {
    name: 'kata',
    creationTimestamp: '2026-08-30T00:00:00Z',
    labels: { runtime: 'sandboxed' },
    annotations: { note: 'x' },
  },
  handler: 'kata-runtime',
  overhead: { podFixed: { memory: '120Mi', cpu: '250m' } },
  scheduling: { nodeSelector: { 'kubernetes.io/os': 'linux' } },
}

describe('class 资源 mapper 字段保真(详情页数据源)', () => {
  it('mapIngressClass 保留 controller/isDefault/labels/annotations/parameters', () => {
    const m = mapIngressClass(INGRESS_CLASS_RAW)
    expect(m.name).toBe('nginx')
    expect(m.controller).toBe('k8s.io/ingress-nginx')
    expect(m.isDefault).toBe(true)
    expect(m.labels).toEqual({ team: 'edge' })
    expect(m.annotations).toEqual({ 'ingressclass.kubernetes.io/is-default-class': 'true' })
    expect(m.parameters).toEqual({ apiGroup: 'k8s.example.com', kind: 'NginxConfiguration', name: 'nginx-config' })
  })

  it('mapIngressClass 缺省安全:无 labels/annotations/parameters 时为空容器', () => {
    const m = mapIngressClass({ metadata: { name: 'bare' }, spec: {} })
    expect(m.isDefault).toBe(false)
    expect(m.labels).toEqual({})
    expect(m.annotations).toEqual({})
    expect(m.parameters).toBeNull()
  })

  it('mapRuntimeClass 读顶层 handler(非 spec.handler)+保留 labels/annotations/overhead/scheduling', () => {
    const m = mapRuntimeClass(RUNTIME_CLASS_RAW)
    expect(m.name).toBe('kata')
    expect(m.handler).toBe('kata-runtime')
    expect(m.labels).toEqual({ runtime: 'sandboxed' })
    expect(m.annotations).toEqual({ note: 'x' })
    expect(m.overhead).toEqual({ podFixed: { memory: '120Mi', cpu: '250m' } })
    expect(m.scheduling).toEqual({ nodeSelector: { 'kubernetes.io/os': 'linux' } })
  })

  it('mapRuntimeClass 缺省安全:无 overhead/scheduling 时空容器', () => {
    const m = mapRuntimeClass({ handler: 'runc', metadata: { name: 'bare' } })
    expect(m.handler).toBe('runc')
    expect(m.labels).toEqual({})
    expect(m.annotations).toEqual({})
    expect(m.overhead).toBeNull()
    expect(m.scheduling).toBeNull()
  })
})
