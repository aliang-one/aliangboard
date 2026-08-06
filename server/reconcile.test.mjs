// reconcile 核心测试:空 manifests skip / 有 manifests apply + 存 last_reconcile(mock readManifests + applyYaml)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema, getLastReconcile } from './workbench-projects.mjs'
import { reconcileProject } from './reconcile.mjs'

function makeDb() { const db = new DatabaseSync(':memory:'); createWorkbenchSchema(db); return db }

test('reconcile:manifests 为空 → skipped,不调 apply', async () => {
  const db = makeDb()
  let applied = 0
  const r = await reconcileProject({ db, projectId: 'p1', readManifests: async () => '', applyYaml: async () => { applied++; return { applied: [], failed: [], total: 0 } } })
  assert.equal(r.skipped, true)
  assert.equal(applied, 0, '空 manifests 不 apply')
  const stored = getLastReconcile(db, 'p1')
  assert.equal(stored.result.skipped, true)
})

test('reconcile:有 manifests → applyYaml 被调,结果(含 failed)存 last_reconcile', async () => {
  const db = makeDb()
  const calls = []
  const r = await reconcileProject({
    db, projectId: 'p1',
    readManifests: async () => 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm',
    applyYaml: async (yaml) => { calls.push(yaml); return { applied: [{ kind: 'ConfigMap', name: 'cm' }], failed: [{ kind: 'Deployment', name: 'd', error: 'rbac 拒' }], total: 2 } },
  })
  assert.equal(r.skipped, undefined)
  assert.equal(r.applied.length, 1)
  assert.equal(r.failed.length, 1)
  assert.equal(r.total, 2)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('ConfigMap'), 'applyYaml 收到 manifests yaml')
  const stored = getLastReconcile(db, 'p1')
  assert.equal(stored.result.total, 2)
  assert.equal(stored.result.failed[0].error, 'rbac 拒')
  assert.ok(stored.ts > 0)
})

test('reconcile:applyYaml 抛错 → 不吞,向上抛(端点 catch 返 500)', async () => {
  const db = makeDb()
  await assert.rejects(
    reconcileProject({ db, projectId: 'p1', readManifests: async () => 'yaml', applyYaml: async () => { throw new Error('集群不可达') } }),
    /集群不可达/,
  )
})
