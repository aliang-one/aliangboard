// 存储用量统计测试:dirSize 递归/computeStorageInfo 明细分层(db 仓库→集群台账→项目 repo)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirSize, computeStorageInfo } from './storage-info.mjs'

test('dirSize: 递归累计文件大小与数量;不存在目录返 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'si-'))
  try {
    await mkdir(join(dir, 'a/b'), { recursive: true })
    await writeFile(join(dir, 'x.txt'), '12345')            // 5
    await writeFile(join(dir, 'a/y.txt'), '1234567890')     // 10
    await writeFile(join(dir, 'a/b/z.txt'), '123')          // 3
    const r = dirSize(dir)
    assert.equal(r.size, 18)
    assert.equal(r.files, 3)
    assert.deepEqual(dirSize(join(dir, 'nope')), { size: 0, files: 0 })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('computeStorageInfo: 库/工作台/data 总量 + 集群(台账+项目)分层明细与排序', async () => {
  const root = await mkdtemp(join(tmpdir(), 'si2-'))
  try {
    // data/ 结构:db 文件 + workbench/<cid>/{cluster-context,projects/<pid>}
    const dataDir = join(root, 'data')
    const wb = join(dataDir, 'workbench')
    await mkdir(join(wb, 'c1', 'cluster-context'), { recursive: true })
    await mkdir(join(wb, 'c1', 'projects', 'p1'), { recursive: true })
    await mkdir(join(wb, 'c2', 'cluster-context'), { recursive: true })
    await writeFile(join(dataDir, 'aliangboard.db'), 'x'.repeat(100))
    await writeFile(join(wb, 'c1', 'cluster-context', 'INDEX.md'), 'x'.repeat(10))
    await writeFile(join(wb, 'c1', 'projects', 'p1', 'm.yaml'), 'x'.repeat(30))
    await writeFile(join(wb, 'c2', 'cluster-context', 'INDEX.md'), 'x'.repeat(5))
    const fakeDb = { prepare: (sql) => ({ get: (id) => {
      if (sql.includes('FROM clusters')) return id === 'c1' ? { name: 'main' } : { name: 'dev' }
      if (sql.includes('workbench_projects')) return { name: id === 'p1' ? 'test-proj' : null }
      return null
    } }) }
    const r = await computeStorageInfo({ dbPath: join(dataDir, 'aliangboard.db'), workbenchDir: wb, db: fakeDb })
    assert.equal(r.dbSize, 100)
    assert.equal(r.workbenchSize, 45)
    assert.equal(r.dataTotalSize, 145) // db + workbench
    assert.equal(r.dataTotalFiles, 4)
    // 集群排序:c1(40) > c2(5)
    assert.equal(r.clusters[0].clusterName, 'main')
    assert.equal(r.clusters[0].ledgerSize, 10)
    assert.equal(r.clusters[0].projects[0].projectName, 'test-proj')
    assert.equal(r.clusters[0].projects[0].size, 30)
    assert.equal(r.clusters[1].clusterName, 'dev')
    // 磁盘字段:真环境有值或 null(不抛)
    assert.ok(r.diskTotal === null || r.diskTotal > 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
