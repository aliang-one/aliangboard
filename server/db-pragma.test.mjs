// 2026-09-08 性能批:WAL 开启语义回归。
// 锁定:① journal_mode 切到 wal;② synchronous=NORMAL 生效;③ 写入数据对后续新连接可见
// (WAL 下Durability 契约——别的进程/只读探针读同一文件必须能读到已提交数据)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { enableFastJournal } from './db-pragma.mjs'

test('enableFastJournal: journal_mode 切 wal + synchronous=NORMAL,数据对新连接可见', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-pragma-'))
  try {
    const db = new DatabaseSync(join(dir, 't.db'))
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete', '前置:新库默认 delete 模式')
    const applied = enableFastJournal(db)
    assert.equal(applied, 'wal', '返回切换后的模式')
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1, 'synchronous=NORMAL(=1)')

    db.exec('CREATE TABLE t(a)')
    db.prepare('INSERT INTO t VALUES(?)').run(42)
    db.close()

    // 新连接(只读探针同款形态)必须能读到已提交数据 —— WAL 不改变可读性契约
    const ro = new DatabaseSync(join(dir, 't.db'), { readOnly: true })
    assert.equal(ro.prepare('SELECT a FROM t').get().a, 42, 'WAL 下数据对新连接可见')
    ro.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
