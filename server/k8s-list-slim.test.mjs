import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slimListBody } from './k8s-slim.mjs'

const item = () => ({
  metadata: {
    name: 'nginx', namespace: 'default',
    managedFields: [{ manager: 'kubectl', fieldsV1: {} }],
    annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"big":"blob"}', 'app.kubernetes.io/name': 'nginx' },
  },
  spec: { replicas: 2 },
  status: { readyReplicas: 2 },
})

test('list body: 剥 managedFields 与 last-applied-configuration,保留 spec/status/其余注解', () => {
  const body = { metadata: { resourceVersion: '100' }, items: [item()] }
  const out = slimListBody(body)
  const m = out.items[0].metadata
  assert.equal(m.managedFields, undefined)
  assert.equal(m.annotations['kubectl.kubernetes.io/last-applied-configuration'], undefined)
  assert.equal(m.annotations['app.kubernetes.io/name'], 'nginx')
  assert.deepEqual(out.items[0].spec, { replicas: 2 })
  assert.deepEqual(out.items[0].status, { readyReplicas: 2 })
  assert.equal(out.metadata.resourceVersion, '100')  // RV 必须保留(watch 续接依赖)
})

test('非 list body(无 items/单对象)原样返回;annotations 缺失不炸', () => {
  const single = { metadata: { name: 'x', managedFields: [{}] }, spec: {} }
  assert.equal(slimListBody(single), single)
  assert.equal(slimListBody(null), null)
  const noAnn = slimListBody({ items: [{ metadata: { name: 'y' }, spec: {} }] })
  assert.equal(noAnn.items[0].metadata.name, 'y')
})
