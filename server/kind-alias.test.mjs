// kind 归一化:LLM 传单数/Kind 名/缩写不再被「不支持的 kind」拒(2026-08-26 wb_get_resource 报障)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKind } from './kindAlias.mjs'

test('规范复数直通', () => {
  for (const k of ['pods', 'services', 'configmaps', 'secrets', 'namespaces', 'deployments', 'statefulsets', 'daemonsets', 'ingresses', 'nodes', 'persistentvolumes', 'persistentvolumeclaims', 'storageclasses', 'networkpolicies', 'serviceaccounts']) {
    assert.equal(normalizeKind(k), k)
  }
})

test('单数名归一(报障场景:service)', () => {
  assert.equal(normalizeKind('service'), 'services')
  assert.equal(normalizeKind('pod'), 'pods')
  assert.equal(normalizeKind('ingress'), 'ingresses')
  assert.equal(normalizeKind('networkpolicy'), 'networkpolicies')
  assert.equal(normalizeKind('persistentvolumeclaim'), 'persistentvolumeclaims')
  assert.equal(normalizeKind('storageclass'), 'storageclasses')
  assert.equal(normalizeKind('serviceaccount'), 'serviceaccounts')
})

test('Kind 大写名与空白容忍', () => {
  assert.equal(normalizeKind('Service'), 'services')
  assert.equal(normalizeKind('Deployment'), 'deployments')
  assert.equal(normalizeKind('  PersistentVolume  '), 'persistentvolumes')
})

test('kubectl 缩写归一', () => {
  assert.equal(normalizeKind('svc'), 'services')
  assert.equal(normalizeKind('po'), 'pods')
  assert.equal(normalizeKind('cm'), 'configmaps')
  assert.equal(normalizeKind('ns'), 'namespaces')
  assert.equal(normalizeKind('deploy'), 'deployments')
  assert.equal(normalizeKind('sts'), 'statefulsets')
  assert.equal(normalizeKind('ds'), 'daemonsets')
  assert.equal(normalizeKind('ing'), 'ingresses')
  assert.equal(normalizeKind('pv'), 'persistentvolumes')
  assert.equal(normalizeKind('pvc'), 'persistentvolumeclaims')
  assert.equal(normalizeKind('sc'), 'storageclasses')
  assert.equal(normalizeKind('netpol'), 'networkpolicies')
  assert.equal(normalizeKind('sa'), 'serviceaccounts')
})

test('未知名/空输入 → null', () => {
  assert.equal(normalizeKind('widget'), null)
  assert.equal(normalizeKind(''), null)
  assert.equal(normalizeKind(null), null)
  assert.equal(normalizeKind(undefined), null)
})
