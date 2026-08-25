// src/utils/__tests__/batchDelete.test.js
import { test, expect } from 'vitest'
import { summarizeResults } from '@/utils/batchDelete'

const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]

test('全成功', () => {
  const r = summarizeResults([
    { status: 'fulfilled', value: null },
    { status: 'fulfilled', value: null },
    { status: 'fulfilled', value: null },
  ], items)
  expect(r).toEqual({ okNames: ['a', 'b', 'c'], failedNames: [] })
})

test('部分失败按索引对齐,全败为空 ok', () => {
  const r = summarizeResults([
    { status: 'fulfilled', value: null },
    { status: 'rejected', reason: new Error('404') },
    { status: 'rejected', reason: new Error('403') },
  ], items)
  expect(r).toEqual({ okNames: ['a'], failedNames: ['b', 'c'] })
})

test('nameOf 可定制(如取 pod.name)', () => {
  const r = summarizeResults([{ status: 'rejected', reason: new Error('x') }], [{ pod: { name: 'p1' } }], it => it.pod.name)
  expect(r).toEqual({ okNames: [], failedNames: ['p1'] })
})
