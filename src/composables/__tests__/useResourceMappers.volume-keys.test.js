// src/composables/__tests__/useResourceMappers.volume-keys.test.js
// 卷挂载键全集:mapper 必须透传 binaryData 键(selectedKeys/校验 ctx 的 data∪binaryData 并集依赖它)
import { test, expect } from 'vitest'
import { mapConfigMap, mapSecret } from '@/composables/useResourceMappers'

test('mapConfigMap/mapSecret 透传 binaryKeys(data∪binaryData 的键)', () => {
  const cm = mapConfigMap({ metadata: { name: 'cm1', namespace: 'ns' }, data: { a: '1' }, binaryData: { 'bin.crt': 'eHg=' } })
  expect(cm.binaryKeys).toEqual(['bin.crt'])
  expect(cm.keys).toBe(1) // 既有 keys 字段语义不变(只数 data)

  const sec = mapSecret({ metadata: { name: 's1', namespace: 'ns' }, data: { k: 'dg==' }, binaryData: { jks: 'eHg=' } })
  expect(sec.binaryKeys).toEqual(['jks'])
})

test('无 binaryData 时 binaryKeys 为空数组', () => {
  expect(mapConfigMap({ metadata: { name: 'cm2' }, data: { a: '1' } }).binaryKeys).toEqual([])
  expect(mapSecret({ metadata: { name: 's2' }, data: {} }).binaryKeys).toEqual([])
})
