// 审计#11(2026-09-06):ref→资源按下标配对,同名不同 kind 不再错绑。
import { describe, test, expect } from 'vitest'
import { pairRefResources } from '../refResources'

describe('pairRefResources', () => {
  test('按下标各归各位:同名不同 kind 不串位', () => {
    const refs = [
      { kind: 'deployments', namespace: 'default', name: 'app' },
      { kind: 'services', namespace: 'default', name: 'app' },
    ]
    const fetched = [
      { kind: 'Deployment', metadata: { name: 'app', namespace: 'default' } },
      { kind: 'Service', metadata: { name: 'app', namespace: 'default' } },
    ]
    pairRefResources(refs, fetched)
    expect(refs[0].resource.kind).toBe('Deployment')
    expect(refs[1].resource.kind).toBe('Service')
  })

  test('not-found 占位 null:不被他项顶替(旧 find 行为会把失败 ref 绑到同名资源)', () => {
    const refs = [
      { kind: 'deployments', namespace: 'default', name: 'app' },
      { kind: 'services', namespace: 'default', name: 'app' },
    ]
    pairRefResources(refs, [{ kind: 'Deployment', metadata: { name: 'app' } }, null])
    expect(refs[0].resource?.kind).toBe('Deployment')
    expect(refs[1].resource).toBeNull()
  })

  test('fetched 异常形态 → 全部 null(防御,不抛)', () => {
    const refs = [{ kind: 'pods', name: 'a' }, { kind: 'pods', name: 'b' }]
    pairRefResources(refs, undefined)
    expect(refs.every(r => r.resource === null)).toBe(true)
    expect(pairRefResources(null, [])).toBeNull()
  })
})
