// server/credential-adapters/db-query.test.mjs
// 单元(driver 判定/参数拼装,驱动 mock)+ 集成开关(TEST_PG_URL/TEST_MYSQL_URL 存在才跑真库)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createDbQueryAdapter } from './db-query.mjs'

const FIELDS = { driver: 'postgres', host: 'h', port: '5432', user: 'u', password: 'p', database: 'd' }

test('driver 判定:缺省 postgres/未知 driver 拒/空 sql 拒/分号拒/结果逐单元格脱敏', async () => {
  // 注入缝:clients 映射 driver→连接工厂(单测桩)。Ruling 1:default 用例真走 connect,
  // 桩须同时提供 postgres/mysql 两个假工厂(缺 mysql 工厂时 mysql 用例误绿/default 用例误红)。
  const stubConn = { query: async () => ({ rows: [], fields: [] }), end: async () => {} }
  const a = createDbQueryAdapter({ clients: { postgres: async () => stubConn, mysql: async () => stubConn } })
  const def = await a.exec({ fields: { ...FIELDS, driver: undefined }, args: { sql: 'SELECT 1' } })
  assert.equal(def.driver, 'postgres')
  const bad = await a.exec({ fields: { ...FIELDS, driver: 'oracle' }, args: { sql: 'SELECT 1' } })
  assert.match(bad.error, /driver/)
  const empty = await a.exec({ fields: FIELDS, args: { sql: '  ' } })
  assert.match(empty.error, /sql/)
  const multi = await a.exec({ fields: FIELDS, args: { sql: 'SELECT 1; DROP TABLE t' } })
  assert.match(multi.error, /单条语句/)
  // 安全红线(spec §11):结果逐单元格 maskSensitiveText;先脱敏后按体积裁剪(修复②同序)
  const leaky = createDbQueryAdapter({ clients: { postgres: async () => ({
    query: async sql => sql.startsWith('SET') ? undefined : { rows: [{ id: 1, note: 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' }], fields: [{ name: 'id' }, { name: 'note' }] },
    end: async () => {},
  }) } })
  const out = await leaky.exec({ fields: FIELDS, args: { sql: 'SELECT * FROM t' } })
  assert.equal(out.rows[0].note, 'token=[redacted-jwt]', '单元格内 JWT 被打码(其余文本保留)')
})

test('postgres 路径:只读 SET 先行/rows 截断/列名透出(驱动桩)', async () => {
  const queries = []
  const a = createDbQueryAdapter({ clients: {
    postgres: async config => ({
      query: async sql => {
        queries.push(sql)
        if (sql.startsWith('SET')) return
        return { rows: Array.from({ length: 250 }, (_, i) => ({ id: i, name: `n${i}` })), fields: [{ name: 'id' }, { name: 'name' }] }
      },
      end: async () => {},
    }),
  } })
  const out = await a.exec({ fields: FIELDS, args: { sql: 'SELECT id,name FROM t' } })
  assert.match(queries[0], /default_transaction_read_only/, '连接级只读先行')
  assert.equal(queries[1], 'SELECT id,name FROM t')
  assert.equal(out.rowCount, 250)
  assert.equal(out.rows.length, 200); assert.equal(out.truncated, true)
  assert.deepEqual(out.columns, ['id', 'name'])
  assert.equal(out.driver, 'postgres')
})

test('mysql 路径:[rows,fields] 形状拆包/只读 SET/短连接 end(驱动桩)', async () => {
  const queries = []
  let ended = 0
  const a = createDbQueryAdapter({ clients: { mysql: async () => ({
    query: async sql => {
      queries.push(sql)
      if (sql.startsWith('SET')) return [[], []]
      return [[{ n: 1 }], [{ name: 'n' }]]
    },
    end: async () => { ended++ },
  }) } })
  const out = await a.exec({ fields: { ...FIELDS, driver: 'mysql' }, args: { sql: 'SELECT 1 AS n' } })
  assert.match(queries[0], /READ ONLY/, 'MySQL 连接级只读先行')
  assert.equal(out.rows[0].n, 1)
  assert.deepEqual(out.columns, ['n'])
  assert.equal(out.driver, 'mysql')
  assert.equal(ended, 1, '短连接:exec 后即 end')
})

test('连接失败不回显连接串/密码', async () => {
  const a = createDbQueryAdapter({ clients: { postgres: async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), { code: 'ECONNREFUSED' }) } } })
  const out = await a.exec({ fields: { ...FIELDS, password: 'p@ssw0rd' }, args: { sql: 'SELECT 1' } })
  assert.match(out.error, /连接失败/)
  assert.ok(!JSON.stringify(out).includes('p@ssw0rd'), '密码不进错误文本')
})

const PG_URL = process.env.TEST_PG_URL
;(PG_URL ? test : test.skip)('集成(TEST_PG_URL):真连接只读违例被拒', { timeout: 30000 }, async () => {
  const u = new URL(PG_URL)
  const a = createDbQueryAdapter({})
  const ok = await a.exec({ fields: { driver: 'postgres', host: u.hostname, port: u.port || '5432',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) },
    args: { sql: 'SELECT 1 AS n' } })
  assert.equal(ok.rows[0].n, 1)
  const ro = await a.exec({ fields: { driver: 'postgres', host: u.hostname, port: u.port || '5432',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) },
    args: { sql: "CREATE TABLE v2_probe(x int)" } })
  assert.match(String(ro.error), /read-only|只读/i, '写语句被连接级只读拒绝')
})

const MY_URL = process.env.TEST_MYSQL_URL
;(MY_URL ? test : test.skip)('集成(TEST_MYSQL_URL):真连接查询/只读', { timeout: 30000 }, async () => {
  const u = new URL(MY_URL)
  const a = createDbQueryAdapter({})
  const base = { driver: 'mysql', host: u.hostname, port: u.port || '3306',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) }
  const ok = await a.exec({ fields: base, args: { sql: 'SELECT 1 AS n' } })
  assert.equal(ok.rows[0].n, 1)
  const ro = await a.exec({ fields: base, args: { sql: 'CREATE TABLE v2_probe(x INT)' } })
  assert.match(String(ro.error), /read-only|只读|READ/i)
})
