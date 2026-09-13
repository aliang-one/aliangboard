// db_query 适配器(2026-09-12-v2 spec §8):PG+MySQL 双驱动,连接级只读,短连接无池化。
// 密码只作为驱动客户端参数(password 字段经桥解密注入本闭包),永不进 SQL 文本/日志/返回。
// 结果先脱敏(maskSensitiveText)后裁剪(rows 200/64KB);集成真库用例走 TEST_PG_URL/TEST_MYSQL_URL 开关。
import { maskSensitiveText } from '../secret-mask.mjs'

const ROWS_MAX = 200, BYTES_MAX = 65536, TIMEOUT_MS = 15000
const POSTGRES_READONLY = 'SET default_transaction_read_only = on'
const MYSQL_READONLY = 'SET SESSION TRANSACTION READ ONLY'

export function createDbQueryAdapter({ clients = null } = {}) {
  const manifest = {
    name: 'db_query',
    title: '数据库查询',
    needs: { driver: 'text', host: 'text', port: 'text', user: 'text', database: 'text', password: 'password' },
    readonlyMethods: null,   // 无 method 概念:恒只读(桥判定 !readonlyMethods → readonly)
  }
  async function connect(driver, f) {
    if (clients) return clients[driver](f)                     // 测试桩缝
    if (driver === 'postgres') {
      const { Client } = await import('pg')                    // 懒加载:不触发时网关零开销
      const c = new Client({ host: f.host, port: Number(f.port) || 5432, user: f.user, password: f.password, database: f.database, statement_timeout: TIMEOUT_MS, connectionTimeoutMillis: TIMEOUT_MS })
      await c.connect(); return { query: async sql => c.query(sql), end: async () => c.end() }
    }
    const mysql = await import('mysql2/promise.js')
    const c = await mysql.createConnection({ host: f.host, port: Number(f.port) || 3306, user: f.user, password: f.password, database: f.database, connectTimeout: TIMEOUT_MS, multipleStatements: false })
    return { query: async sql => c.query(sql), end: async () => c.end() }
  }
  async function exec({ fields, args }) {
    const driver = String(fields.driver || 'postgres').toLowerCase()
    if (!['postgres', 'mysql'].includes(driver)) return { error: `不支持的 driver: ${driver}(postgres|mysql)` }
    const sql = String(args?.sql ?? '').trim()
    if (!sql) return { error: 'sql 为空' }
    if (/;/.test(sql.slice(0, -1))) return { error: '仅接受单条语句' }
    let conn
    try { conn = await connect(driver, fields) }
    catch (e) { return { error: `连接失败(${e?.code || e?.errno || 'network'})` } }   // 不回显连接串/密码
    try {
      await conn.query(driver === 'postgres' ? POSTGRES_READONLY : MYSQL_READONLY)
      const r = await conn.query(sql)
      const rows = (driver === 'postgres' ? r.rows : r[0]) || []
      const columns = (driver === 'postgres' ? r.fields || [] : r[1] || []).map(x => x.name).filter(Boolean)
      const truncated = rows.length > ROWS_MAX
      // 先逐单元格脱敏,后按体积裁剪(spec §11.2 与 http_request 修复②同序:
      // 先裁后 mask 会把跨边界 JWT/PEM 切成半截,mask 正则不再命中,半截秘密直达 LLM)
      let out = rows.slice(0, ROWS_MAX).map(row => {
        const o = {}
        for (const [k, v] of Object.entries(row)) o[k] = v == null || typeof v !== 'string' ? v : maskSensitiveText(v)
        return o
      })
      let s = JSON.stringify(out)
      if (s.length > BYTES_MAX) { out = out.slice(0, Math.max(1, Math.floor(out.length * BYTES_MAX / s.length))); s = JSON.stringify(out) }
      return { columns, rows: out, rowCount: rows.length, driver, ...(truncated ? { truncated: true } : {}) }
    } catch (e) { return { error: String(e?.message || e).slice(0, 300) } }   // PG/MySQL 生成的错误文本,无秘密
    finally { try { await conn.end() } catch { /* 短连接尽力关 */ } }
  }
  return { manifest, exec }
}
