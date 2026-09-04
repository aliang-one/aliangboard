// src/logic/classDefault.test.mjs —— 集群默认类单源语义零依赖用例(node --test,进 test:server 链)
// spec §3.1:两域 mapper 字段名不同(IC=isDefault / SC=default)→ key 参数化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findDefaultClass, canUseClusterDefault, resolveClusterDefaultName } from './classDefault.js'

test('findDefaultClass: IC 字段 isDefault', () => {
  const classes = [{ name: 'traefik' }, { name: 'nginx', isDefault: true }]
  assert.equal(findDefaultClass(classes)?.name, 'nginx')
})

test('findDefaultClass: SC 字段 default(key 参数)', () => {
  const classes = [{ name: 'slow' }, { name: 'fast', default: true }]
  assert.equal(findDefaultClass(classes, 'default')?.name, 'fast')
})

test('canUseClusterDefault: 无默认 → false(空列表/undefined 同)', () => {
  assert.equal(canUseClusterDefault([{ name: 'a' }]), false)
  assert.equal(canUseClusterDefault([], 'default'), false)
  assert.equal(canUseClusterDefault(undefined), false)
})

test('resolveClusterDefaultName: 有默认 → 显式名;无默认 → 空串', () => {
  assert.equal(resolveClusterDefaultName([{ name: 'x' }, { name: 'nginx', isDefault: true }]), 'nginx')
  assert.equal(resolveClusterDefaultName([{ name: 'x' }]), '')
  assert.equal(resolveClusterDefaultName(null, 'default'), '')
})
