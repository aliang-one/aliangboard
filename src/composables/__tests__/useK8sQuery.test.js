import { describe, it, expect } from 'vitest'
import { applyWatchEvent, uidKey } from '../useK8sQuery.js'

const id = item => item.uid

describe('uidKey', () => {
  it('prefers uid', () => {
    expect(uidKey({ uid: 'u1' })).toBe('u1')
    expect(uidKey({ metadata: { uid: 'u2' } })).toBe('u2')
  })
  it('falls back to ns/name', () => {
    expect(uidKey({ namespace: 'default', name: 'web' })).toBe('default/web')
    expect(uidKey({ metadata: { namespace: 'ns', name: 'n' } })).toBe('ns/n')
  })
  it('empty when nothing', () => {
    expect(uidKey({})).toBe('/')
  })
})

describe('applyWatchEvent', () => {
  const list = [{ uid: 'a', v: 1 }, { uid: 'b', v: 2 }]

  it('ADDED new → append', () => {
    const r = applyWatchEvent(list, 'ADDED', { uid: 'c', v: 3 }, id)
    expect(r.map(x => x.uid)).toEqual(['a', 'b', 'c'])
    expect(list.map(x => x.uid)).toEqual(['a', 'b']) // 原列表不可变
  })
  it('MODIFIED hit → merge in place', () => {
    const r = applyWatchEvent(list, 'MODIFIED', { uid: 'a', v: 9 }, id)
    expect(r.find(x => x.uid === 'a').v).toBe(9)
    expect(r.map(x => x.uid)).toEqual(['a', 'b'])
  })
  it('ADDED existing → treated as upsert (merge)', () => {
    const r = applyWatchEvent(list, 'ADDED', { uid: 'b', v: 7 }, id)
    expect(r.find(x => x.uid === 'b').v).toBe(7)
    expect(r.length).toBe(2)
  })
  it('DELETED hit → remove', () => {
    const r = applyWatchEvent(list, 'DELETED', { uid: 'a' }, id)
    expect(r.map(x => x.uid)).toEqual(['b'])
  })
  it('DELETED miss → unchanged', () => {
    const r = applyWatchEvent(list, 'DELETED', { uid: 'zzz' }, id)
    expect(r.map(x => x.uid)).toEqual(['a', 'b'])
  })
  it('null item → unchanged', () => {
    expect(applyWatchEvent(list, 'ADDED', null, id)).toBe(list)
  })
  it('null list → [] or [item]', () => {
    expect(applyWatchEvent(null, 'ADDED', { uid: 'x' }, id).map(x => x.uid)).toEqual(['x'])
    expect(applyWatchEvent(null, 'DELETED', { uid: 'x' }, id)).toEqual([])
  })
  it('does not mutate original (immutability for functional setQueryData)', () => {
    const before = [...list]
    applyWatchEvent(list, 'MODIFIED', { uid: 'a', v: 99 }, id)
    applyWatchEvent(list, 'DELETED', { uid: 'b' }, id)
    expect(list).toEqual(before)
  })
})
