import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RESOURCE_CATALOG, FALLBACK_SPEC, getPath, getCardSpec } from '../resourceCatalog.js'

// --- getPath: scalar ---
test('getPath scalar: metadata.name', () => {
  const obj = { metadata: { name: 'nginx' } }
  assert.equal(getPath(obj, { path: 'metadata.name' }), 'nginx')
})

test('getPath scalar: deep dot notation', () => {
  const obj = { spec: { template: { spec: { containers: [{ image: 'x' }] } } } }
  // No extract → returns array as-is
  assert.ok(Array.isArray(getPath(obj, { path: 'spec.template.spec.containers' })))
})

// --- getPath: array + extract ---
test('getPath array extract: spec.containers → images', () => {
  const obj = { spec: { containers: [{ image: 'nginx:1.21' }, { image: 'redis:7' }] } }
  assert.deepEqual(getPath(obj, { path: 'spec.containers', extract: 'image' }), ['nginx:1.21', 'redis:7'])
})

test('getPath array extract single element', () => {
  const obj = { spec: { containers: [{ image: 'nginx:1.21' }] } }
  assert.deepEqual(getPath(obj, { path: 'spec.containers', extract: 'image' }), ['nginx:1.21'])
})

// --- getPath: reduce='sum' ---
test('getPath sum: restartCount 1+2+0=3', () => {
  const obj = { status: { containerStatuses: [{ restartCount: 1 }, { restartCount: 2 }, { restartCount: 0 }] } }
  assert.equal(getPath(obj, { path: 'status.containerStatuses', extract: 'restartCount', reduce: 'sum' }), 3)
})

test('getPath sum: empty array → 0', () => {
  const obj = { status: { containerStatuses: [] } }
  assert.equal(getPath(obj, { path: 'status.containerStatuses', extract: 'restartCount', reduce: 'sum' }), 0)
})

// --- getPath: extract='key' (Object.keys) ---
test('getPath object keys: ConfigMap data', () => {
  const obj = { data: { 'config.yaml': 'xxx', env: 'FOO=bar' } }
  assert.deepEqual(getPath(obj, { path: 'data', extract: 'key' }), ['config.yaml', 'env'])
})

// --- getPath: missing ---
test('getPath missing: a.b.c on {} → undefined', () => {
  assert.equal(getPath({}, { path: 'a.b.c' }), undefined)
})

test('getPath missing nested: metadata.name on null → undefined', () => {
  assert.equal(getPath(null, { path: 'metadata.name' }), undefined)
})

test('getPath missing mid-path: spec.foo on {spec:{}} → undefined', () => {
  assert.equal(getPath({ spec: {} }, { path: 'spec.foo' }), undefined)
})

test('getPath with no attr.path → undefined', () => {
  assert.equal(getPath({}, {}), undefined)
})

// --- getCardSpec ---
test('getCardSpec: Pod returns RESOURCE_CATALOG.Pod', () => {
  assert.equal(getCardSpec('Pod'), RESOURCE_CATALOG.Pod)
})

test('getCardSpec: Deployment returns RESOURCE_CATALOG.Deployment', () => {
  assert.equal(getCardSpec('Deployment'), RESOURCE_CATALOG.Deployment)
})

test('getCardSpec: UnknownKind returns FALLBACK_SPEC', () => {
  assert.equal(getCardSpec('UnknownKind'), FALLBACK_SPEC)
})

test('getCardSpec: undefined kind returns FALLBACK_SPEC', () => {
  assert.equal(getCardSpec(undefined), FALLBACK_SPEC)
})

// --- Catalog structure sanity ---
test('RESOURCE_CATALOG has 6 kinds', () => {
  const kinds = Object.keys(RESOURCE_CATALOG)
  assert.equal(kinds.length, 6)
  assert.ok(kinds.includes('Pod'))
  assert.ok(kinds.includes('Deployment'))
  assert.ok(kinds.includes('Service'))
  assert.ok(kinds.includes('Namespace'))
  assert.ok(kinds.includes('Ingress'))
  assert.ok(kinds.includes('ConfigMap'))
})

test('FALLBACK_SPEC has icon + attributes', () => {
  assert.ok(FALLBACK_SPEC.icon)
  assert.ok(Array.isArray(FALLBACK_SPEC.attributes))
  assert.ok(FALLBACK_SPEC.attributes.length > 0)
})
