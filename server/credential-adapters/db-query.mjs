// db_query 适配器(2026-09-12-v2 spec §8):PG+MySQL 双驱动,连接级只读,短连接无池化。
// 密码只作为驱动客户端参数(password 字段经桥解密注入本闭包),永不进 SQL 文本/日志/返回。
// 结果先脱敏(maskSensitiveText)后裁剪(rows 200/64KB);集成真库用例走 TEST_PG_URL/TEST_MYSQL_URL 开关。
import { maskSensitiveText } from '../secret-mask.mjs'

const ROWS_MAX = 200, BYTES_MAX = 65536, TIMEOUT_MS = 15000
const POSTGRES_READONLY = 'SET default_transaction_read_only = on'
const MYSQL_READONLY = 'SET SESSION TRANSACTION READ ONLY'

export function createDbQueryAdapter({ clients = null, timeoutMs = TIMEOUT_MS } = {}) {
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
      await c.connect()
      return { query: async sql => c.query(sql), end: async () => c.end(), destroy: () => c.destroy() }
    }
    const mysql = await import('mysql2/promise.js')
    const c = await mysql.createConnection({ host: f.host, port: Number(f.port) || 3306, user: f.user, password: f.password, database: f.database, connectTimeout: TIMEOUT_MS, multipleStatements: false })
    return { query: async sql => c.query(sql), end: async () => c.end(), destroy: () => c.destroy() }
  }
  // 审查修复 D(查询阶段超时,spec §8):connectTimeout 只管握手,SELECT SLEEP(99999) 会永挂——
  // Promise.race 外挂超时,超时分支 destroy 连接(pg Client/mysql2 connection 均有 destroy;
  // pg 侧另有 statement_timeout 双保险,不受影响)。错误文案固定,不回显任何连接信息。
  function queryWithTimeout(conn, sql) {
    let timer
    const timeoutP = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { conn.destroy?.() } catch { /* 尽力断流 */ }
        reject(new Error(`查询超时(${Math.round(timeoutMs / 1000)}s)`))
      }, timeoutMs)
    })
    return Promise.race([conn.query(sql), timeoutP]).finally(() => clearTimeout(timer))
  }
  // 审查修复 C(非字符串单元格脱敏,spec §11.2):逐单元格 mask 原先只处理 string——
  // PG jsonb/json 返回对象(JWT 嵌套明文直达模型)、bytea 返回 Buffer(数字数组可重构),均直通。
  // 对象 → stringify→mask→parse 往返(保对象形状);Buffer/Uint8Array → 字符串占位(杜绝重构);
  // number/boolean/null/bigint/Date 等无自由文本形态,原样。
  // T8 复审残端:Buffer 嵌套在数组/对象内(pg bytea[]/jsonb 复合字段)走通用对象分支,
  // JSON.stringify 产出 {"type":"Buffer","data":[...]} 数字数组可重构——stringify 前递归
  // 占位(数组元素/对象属性值同游),Date 留给 stringify 原生 ISO 形态。
  const binaryPlaceholder = v => v instanceof Uint8Array ? `[binary ${v.length} bytes]`
    : Array.isArray(v) ? v.map(binaryPlaceholder)
    : (v !== null && typeof v === 'object' && !(v instanceof Date))
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, binaryPlaceholder(x)]))
      : v
  function maskCell(v) {
    if (v == null || typeof v !== 'object') return typeof v === 'string' ? maskSensitiveText(v) : v
    if (v instanceof Date) return v
    if (v instanceof Uint8Array) return `[binary ${v.length} bytes]`   // Buffer 是 Uint8Array 子类(pg bytea/mysql BLOB)
    try { return JSON.parse(maskSensitiveText(JSON.stringify(binaryPlaceholder(v)))) } catch { return String(v) }
  }
  async function exec({ fields, args }) {
    // 审查修复 B(字段键归一,与 http_request T2/T3 同型债):桥按存储原键传 fields(表单可自由输键,
    // matchAdapter 大小写不敏感放行),exec 一律按 manifest needs 键做大小写不敏感索引——
    // 防 f.host=undefined → pg 静默连 localhost:5432/当前 OS 用户(非声明目标)。
    const f = {}
    for (const k of Object.keys(manifest.needs)) {
      const stored = Object.keys(fields).find(x => x.toLowerCase() === k)
      f[k] = fields[stored] ?? ''
    }
    const driver = String(f.driver || 'postgres').toLowerCase()
    if (!['postgres', 'mysql'].includes(driver)) return { error: `不支持的 driver: ${driver}(postgres|mysql)` }
    const sql = String(args?.sql ?? '').trim()
    if (!sql) return { error: 'sql 为空' }
    if (/;/.test(sql.slice(0, -1))) return { error: '仅接受单条语句' }
    let conn
    try { conn = await connect(driver, f) }
    catch (e) { return { error: `连接失败(${e?.code || e?.errno || 'network'})` } }   // 不回显连接串/密码
    try {
      await queryWithTimeout(conn, driver === 'postgres' ? POSTGRES_READONLY : MYSQL_READONLY)
      const r = await queryWithTimeout(conn, sql)
      const rows = (driver === 'postgres' ? r.rows : r[0]) || []
      const columns = (driver === 'postgres' ? r.fields || [] : r[1] || []).map(x => x.name).filter(Boolean)
      const truncated = rows.length > ROWS_MAX
      // 先逐单元格脱敏,后按体积裁剪(spec §11.2 与 http_request 修复②同序:
      // 先裁后 mask 会把跨边界 JWT/PEM 切成半截,mask 正则不再命中,半截秘密直达 LLM)
      let out = rows.slice(0, ROWS_MAX).map(row => {
        const o = {}
        for (const [k, v] of Object.entries(row)) o[k] = maskCell(v)
        return o
      })
      let s = JSON.stringify(out)
      if (s.length > BYTES_MAX) { out = out.slice(0, Math.max(1, Math.floor(out.length * BYTES_MAX / s.length))); s = JSON.stringify(out) }
      // 审查修复 E(64KB 契约硬顶):单大行击穿比例裁剪(300KB 单 cell 比例缩行后仍 300KB)——
      // 此时硬 slice 到 BYTES_MAX:截断发生在 mask 之后,slice 的是脱敏产物,不复活半截秘密。
      // 形状降级:数组 → 已截断的 JSON 文本(契约优先;下游本就有 clamp,LLM 容忍文本尾损)。
      let payload = out, sizeTrunc = false
      if (s.length > BYTES_MAX) { s = s.slice(0, BYTES_MAX); payload = s; sizeTrunc = true }
      return { columns, rows: payload, rowCount: rows.length, driver, ...((truncated || sizeTrunc) ? { truncated: true } : {}) }
    } catch (e) { return { error: String(e?.message || e).slice(0, 300) } }   // PG/MySQL 生成的错误文本,无秘密
    finally { try { await conn.end() } catch { /* 短连接尽力关 */ } }
  }
  return { manifest, exec }
}
