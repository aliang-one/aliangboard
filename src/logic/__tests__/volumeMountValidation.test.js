// 向导 step2 门禁纯函数:卷必须映射到容器(来源/mountPath/target 三查),堵静默丢弃洞。
import { test, expect } from 'vitest'
import { firstVolumeMountError, volumeItemsIncomplete } from '@/logic/volumeMountValidation'

const OK = ['main', 'init:0', 'sidecar:0']
const base = { name: 'vol-1', target: 'main', type: 'pvc', mountPath: '/data', subPath: '', readOnly: false, pvcName: 'my-pvc', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] }

test('全部合法 → null', () => {
  expect(firstVolumeMountError([{ ...base }], OK)).toBe(null)
  expect(firstVolumeMountError([{ ...base, type: 'emptyDir', mountPath: '/scratch' }], OK)).toBe(null)
})

test('来源缺失:按类型查字段,返回首坏序号', () => {
  expect(firstVolumeMountError([{ ...base, pvcName: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, type: 'hostPath', hostPath: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, type: 'nfs', server: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, type: 'configMap', cmName: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, type: 'secret', secretName: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base }, { ...base, name: 'vol-2', pvcName: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 2 })
})

test('mountPath:空或非斜杠开头 → deploy.volumeMountRequired', () => {
  expect(firstVolumeMountError([{ ...base, mountPath: '' }], OK)).toEqual({ key: 'deploy.volumeMountRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, mountPath: 'data' }], OK)).toEqual({ key: 'deploy.volumeMountRequired', n: 1 })
})

test('target 悬空(容器已删/无镜像)→ deploy.volumeTargetInvalid', () => {
  expect(firstVolumeMountError([{ ...base, target: 'sidecar:9' }], OK)).toEqual({ key: 'deploy.volumeTargetInvalid', n: 1 })
})

test('items 半填:key-only/path-only → volumeItemsIncomplete;全空行忽略', () => {
  const it = (key, path) => ({ key, path })
  expect(volumeItemsIncomplete({ items: [it('k', '')] })).toBe(true)
  expect(volumeItemsIncomplete({ items: [it('', 'p')] })).toBe(true)
  expect(volumeItemsIncomplete({ items: [it('', ''), it('k', 'p')] })).toBe(false)
  expect(volumeItemsIncomplete({})).toBe(false)
  expect(firstVolumeMountError([{ ...base, items: [{ key: 'k', path: '' }] }], OK)).toEqual({ key: 'deploy.volumeItemsIncomplete', n: 1 })
  expect(firstVolumeMountError([{ ...base, items: [{ key: '', path: '' }] }], OK)).toBe(null)
})
