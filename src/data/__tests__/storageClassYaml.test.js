import { test, expect } from 'vitest'
import { load as yamlLoad } from 'js-yaml'
import { buildStorageClassYaml } from '../storageClassYaml.js'

// 系统审计(2026-09-29):StorageClass parameters 裸插值 + 提交侧逗号折叠。
// - parameters 值裸插进 YAML:数字形态参数值(Longhorn/Ceph 预设的 '3'/'30'/'2')
//   被网关 js-yaml 解析成 int → apiserver 拒收 map[string]string → 预设根本建不出来。
// - Storage.vue 提交把 rows 折叠成 'k=v,k=v' 再被 normalize 重拆:值含逗号被截断,
//   且字符串路径会 trim 值两端空格;预览(rows 路径)与实际提交(字符串路径)分叉。
test('buildStorageClassYaml: 数字形态参数值经 YAML 解析仍是字符串(预设可创建)', () => {
  const y = buildStorageClassYaml({
    name: 'longhorn', provisioner: 'driver.longhorn.io',
    parameters: [{ key: 'numberOfReplicas', value: '3' }, { key: 'staleReplicaTimeout', value: '30' }],
    reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
  })
  const o = yamlLoad(y)
  expect(o.parameters).toEqual({ numberOfReplicas: '3', staleReplicaTimeout: '30' })
  expect(typeof o.parameters.numberOfReplicas).toBe('string')
})

test('buildStorageClassYaml: 含逗号参数值完整保留(rows 直传不经逗号折叠)', () => {
  const y = buildStorageClassYaml({
    name: 'sc1', provisioner: 'p',
    parameters: [{ key: 'mountOptions', value: 'noatime,compress=zstd' }],
  })
  expect(yamlLoad(y).parameters.mountOptions).toBe('noatime,compress=zstd')
})

test('buildStorageClassYaml: 普通参数值保持裸值(输出形态不变)', () => {
  const y = buildStorageClassYaml({
    name: 'sc2', provisioner: 'rancher.io/local-path',
    parameters: [{ key: 'path', value: '/var/lib/storage' }],
  })
  expect(y).toContain('path: /var/lib/storage')
})
