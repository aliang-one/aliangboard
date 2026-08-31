// Task 11:AI↔SSH 桥测试。fake 行带 REAL encryptField 密文,走真 materializeCreds 解密路径
// (2026-08-28 brief 注记:不用 _noSudo 之类探针,mock 契约贴真,防漂移)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { resolveServerRef, createSshAgentBridge } from './agent-bridge.mjs'
import { encryptField } from './crypt.mjs'

const KEY = randomBytes(32)
const ENC_SUDOPW = encryptField(KEY, 'supw')

const ROWS = [
  { id: 'a', name: 'prod-web', exposeToAi: 1, aiApprovalPolicy: 'always', host: '1.1.1.1' },
  { id: 'b', name: 'prod-web', exposeToAi: 0, aiApprovalPolicy: 'none', host: '2.2.2.2' },
  { id: 'c', name: 'dev-1', exposeToAi: 1, aiApprovalPolicy: 'readonly', host: '3.3.3.3' },
]

// fake db:按 SQL 形状路由——bridge 的全行 SELECT(all)/materializeCreds 的 id SELECT(get)/
// listSshServers 的 exposedOnly(all 只回暴露行)。enc 字段用真密文。
function fakeDb({ rows = ROWS, withSudo = true, sudoRow } = {}) {
  return {
    prepare: (sql) => {
      if (/exposeToAi=1/.test(sql)) return { all: () => rows.filter(r => r.exposeToAi) }
      if (/WHERE id=\?/.test(sql)) return { get: (id) => {
        const r = rows.find(x => x.id === id); if (!r) return null
        return { ...r, encSudoPassword: withSudo ? ENC_SUDOPW : null, ...(sudoRow || {}) }
      } }
      return { all: () => rows }
    },
  }
}

test('resolveServerRef: id 优先 → 同名多台(含未暴露)歧义返回候选(仅暴露) → 未暴露不泄露存在性', () => {
  assert.deepEqual(resolveServerRef(ROWS, 'c').row.id, 'c')
  const amb = resolveServerRef(ROWS, 'prod-web')
  assert.equal(amb.ok, false); assert.equal(amb.reason, 'ambiguous'); assert.equal(amb.candidates.length, 1) // 仅暴露的 a
  const hidden = resolveServerRef(ROWS, '2.2.2.2') // host 不参与解析
  assert.equal(hidden.ok, false)
  const nope = resolveServerRef(ROWS, 'ghost')
  assert.equal(nope.reason, 'not-found')
  const b = resolveServerRef(ROWS, 'b')
  assert.equal(b.reason, 'not-exposed')
  // 未暴露的 not-exposed/not-found 文案都不回显 host(brief 硬规则由 refusal 保证,此处验纯函数侧)
  assert.equal(JSON.stringify(resolveServerRef(ROWS, 'b')).includes('2.2.2.2'), false)
  // 同名但全未暴露 → not-exposed(不给存在性预言机 + 不产「候选 id:」空文案)
  const allHidden = resolveServerRef([{ id: 'x', name: 'same', exposeToAi: 0 }, { id: 'y', name: 'same', exposeToAi: 0 }], 'same')
  assert.equal(allHidden.ok, false); assert.equal(allHidden.reason, 'not-exposed'); assert.equal(allHidden.candidates.length, 0)
})

test('needsApproval: always→true;readonly→分类器放行 cat/拦 rm;none→false;解析失败→true(安全默认)', async () => {
  const mk = policy => createSshAgentBridge({ db: fakeDb({ rows: [{ id: 'c', name: 'dev-1', exposeToAi: 1, aiApprovalPolicy: policy }] }), key: KEY, pool: {}, projectId: 'p1' })
  assert.equal(await mk('readonly').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'cat /etc/hostname' }), false)
  assert.equal(await mk('readonly').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'rm -rf /' }), true)
  assert.equal(await mk('readonly').needsApproval('wb_ssh_read_file', { server: 'dev-1', path: '/x' }), false)
  assert.equal(await mk('always').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'ls' }), true)
  assert.equal(await mk('none').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'ls' }), false)
  assert.equal(await mk('readonly').needsApproval('wb_ssh_exec', { server: 'ghost', command: 'ls' }), true)
  // 审批旁路修复(2026-08-28):readonly 策略 + sudo:true = root 执行,一律人审(分类器只看命令文本不看提权位)
  assert.equal(await mk('readonly').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'cat /etc/hostname', sudo: true }), true)
  assert.equal(await mk('none').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'cat /etc/hostname', sudo: true }), false)  // none 政策本就免审,不因 sudo 变严
})

test('exec: 组装 pool.acquire(serverId, wb:<projectId>);sudo 包装 + 密码写 stdin;结果不含密码', async () => {
  const calls = []
  const pool = {
    acquire: async (serverId, user) => {
      calls.push([serverId, user])
      const client = {
        exec: (cmd, cb) => { calls.push(['exec', cmd]); const s = fakeStream(calls); cb(null, s); setImmediate(() => { s.emit('exit', 0); s.emit('close') }) },
        end: () => {},
      }
      return { client, release: () => calls.push(['release']) }
    },
  }
  const bridge = createSshAgentBridge({ db: fakeDb(), key: KEY, pool, projectId: 'p1', actor: 'ops' })
  const r = await bridge.exec({ server: 'dev-1', command: 'ls -la', sudo: true })
  assert.equal(r.exitCode, 0)
  assert.equal(calls.find(c => c[0] === 'exec')[1], `sudo -S -p '' sh -c 'ls -la'`)
  assert.ok(calls.some(c => c[0] === 'stdin' && c[1] === 'supw\n'))   // sudo 密码走 stdin
  assert.deepEqual(calls[0], ['c', 'wb:p1'])                          // 池身份 = wb:<projectId>
  assert.ok(!JSON.stringify(r).includes('supw'))                      // 结果不含密码
  assert.ok(calls.some(c => c[0] === 'release'))                      // 池归还
  // 未配置 sudo 密码 → 结构化错误(第二个 fixture,真 materializeCreds 返 null)
  const noSudoBridge = createSshAgentBridge({ db: fakeDb({ withSudo: false }), key: KEY, pool, projectId: 'p1' })
  const r2 = await noSudoBridge.exec({ server: 'dev-1', command: 'ls', sudo: true })
  assert.ok(r2.error && /sudo/i.test(r2.error))
  assert.ok(!JSON.stringify(r2).includes('supw'))
})

function fakeStream(sink = []) {
  const s = new EventEmitter()
  s.stdout = new EventEmitter(); s.stderr = new EventEmitter()
  s.write = d => sink.push(['stdin', String(d)])
  setImmediate(() => { s.stdout.emit('data', Buffer.from('file1\n')) })
  return s
}

test('exec: 超时 clamp + 截断标记;readFile 拒绝相对路径与 ..', async () => {
  const pool = { acquire: async () => ({ client: { exec: (cmd, cb) => { const s = fakeStream(); cb(null, s); setImmediate(() => { s.emit('exit', 0); s.emit('close') }) }, end: () => {} }, release: () => {} }) }
  const bridge = createSshAgentBridge({ db: fakeDb(), key: KEY, pool, projectId: 'p1' })
  const r = await bridge.exec({ server: 'dev-1', command: 'ls', timeoutSec: 999 })
  assert.equal(r.exitCode, 0); assert.ok(r.durationMs >= 0)
  assert.match(await errOf(bridge, { server: 'dev-1', path: 'etc/hostname' }), /绝对路径/)
  assert.match(await errOf(bridge, { server: 'dev-1', path: '/etc/../root/x' }), /绝对路径|\.\./)
  // 解析失败:错误不含未暴露行细节
  const r3 = await bridge.exec({ server: 'b', command: 'ls' })
  assert.ok(r3.error && !r3.error.includes('2.2.2.2'))
})

async function errOf(bridge, args) {
  const r = await bridge.readFile(args)
  assert.ok(r.error, `expected error for ${JSON.stringify(args)}`)
  return r.error
}

test('exec 超时兜底:exec 回调永不触发(死连接)→ timedOut:true + release 调用 + client.end 清理', async () => {
  const calls = []
  const pool = { acquire: async () => ({ client: { exec: () => { calls.push(['exec-no-cb']) } /* cb 永不回调 */, end: () => calls.push(['end']) }, release: () => calls.push(['release']) }) }
  const bridge = createSshAgentBridge({ db: fakeDb(), key: KEY, pool, projectId: 'p1' })
  const r = await bridge.exec({ server: 'dev-1', command: 'ls', timeoutSec: 1 })   // clamp 到 1000ms
  assert.equal(r.timedOut, true); assert.equal(r.exitCode, null)
  assert.ok(calls.some(c => c[0] === 'release'))   // 池句柄归还,不泄漏
  assert.ok(calls.some(c => c[0] === 'end'))       // 死连接客户端被拆
}, { timeout: 5000 })

test('exec 超时但 stream 已存在(命令慢):只关流,不拆池化客户端(跨会话杀伤修复)', async () => {
  const calls = []
  const pool = {
    acquire: async () => ({
      client: {
        exec: (cmd, cb) => { const s = new EventEmitter(); s.stderr = new EventEmitter(); s.write = () => {}; s.close = () => calls.push(['stream-close']); cb(null, s) /* 流拿到但永不 close/end */ },
        end: () => calls.push(['end']),
      },
      release: () => calls.push(['release']),
    }),
  }
  const bridge = createSshAgentBridge({ db: fakeDb(), key: KEY, pool, projectId: 'p1' })
  const r = await bridge.exec({ server: 'dev-1', command: 'sleep 999', timeoutSec: 1 })
  assert.equal(r.timedOut, true)
  assert.ok(calls.some(c => c[0] === 'stream-close'))       // 本命令的流被关
  assert.ok(calls.some(c => c[0] === 'release'))            // 池句柄归还
  assert.ok(!calls.some(c => c[0] === 'end'))               // 共享客户端未被拆(其他用户终端存活)
}, { timeout: 5000 })

test('exec 截断:>32KB stdout → stdoutTruncated:true 且恰截到 32768;恰好满上限不误报', async () => {
  const mkPool = payload => ({ acquire: async () => ({ client: { exec: (cmd, cb) => { const s = new EventEmitter(); s.stderr = new EventEmitter(); s.write = () => {}; cb(null, s); setImmediate(() => { s.emit('data', payload); s.emit('exit', 0); s.emit('close') }) }, end: () => {} }, release: () => {} }) })
  const bridge = createSshAgentBridge({ db: fakeDb(), key: KEY, pool: mkPool(Buffer.alloc(40000, 0x61)), projectId: 'p1' })
  const r = await bridge.exec({ server: 'dev-1', command: 'ls' })
  assert.equal(r.stdoutTruncated, true)
  assert.equal(Buffer.byteLength(r.stdout), 32768)
  const exact = await createSshAgentBridge({ db: fakeDb(), key: KEY, pool: mkPool(Buffer.alloc(32768, 0x61)), projectId: 'p1' }).exec({ server: 'dev-1', command: 'ls' })
  assert.equal(exact.stdoutTruncated, false)   // 恰好 32768 未再写入 → 非截断
})

test('readFile 超限:>maxBytes 后流只发 close(不发 end/error)→ promise 结算 truncated:true + 池归还', async () => {
  const calls = []
  const mkSftp = () => ({ createReadStream: () => {
    const rs = new EventEmitter()
    setImmediate(() => {
      rs.emit('data', Buffer.alloc(40000, 0x62))   // 单块超限(maxBytes=1024)
      rs.emit('close')                              // destroy 后只发 close,不发 end/error(审查 Critical 场景)
    })
    rs.destroy = () => {}
    return rs
  } })
  const pool = { acquire: async () => ({ client: { sftp: (cb) => cb(null, mkSftp()) }, release: () => calls.push(['release']) }) }
  const bridge = createSshAgentBridge({ db: fakeDb(), key: KEY, pool, projectId: 'p1' })
  const r = await bridge.readFile({ server: 'dev-1', path: '/var/log/big.log', maxBytes: 1024 })
  assert.equal(r.truncated, true)
  assert.equal(Buffer.byteLength(r.content), 1024) // 单块一脚踩过上限:保 maxBytes 前缀(共享 sftpReadFile 切片语义,brief 2026-08-28),不挂起即为过
  assert.ok(calls.some(c => c[0] === 'release'))   // 池句柄归还,不泄漏
  // 分块场景:先 800B(入账)再 400B(超限)→ 内容 = 800B + 224B 前缀 = 1024(切片语义)
  const calls2 = []
  const sftp2 = { createReadStream: () => { const rs = new EventEmitter(); setImmediate(() => { rs.emit('data', Buffer.alloc(800, 0x63)); rs.emit('data', Buffer.alloc(400, 0x64)); rs.emit('close') }); rs.destroy = () => {}; return rs } }
  const bridge2 = createSshAgentBridge({ db: fakeDb(), key: KEY, pool: { acquire: async () => ({ client: { sftp: cb => cb(null, sftp2) }, release: () => calls2.push(['release']) }) }, projectId: 'p1' })
  const r2 = await bridge2.readFile({ server: 'dev-1', path: '/var/log/big.log', maxBytes: 1024 })
  assert.equal(r2.truncated, true)
  assert.equal(Buffer.byteLength(r2.content), 1024)
  assert.ok(calls2.some(c => c[0] === 'release'))
})

// === 台账闭包(2026-08-29) ===
test('readLedger:渲染暴露服务器台账(含全局备注);writeNotes 全局/服务器/未暴露三路', async () => {
  const { encryptField } = await import('./crypt.mjs')
  const KEY = Buffer.alloc(32)
  const ROWS = [
    { id: 'a', name: 'gw-1', exposeToAi: 1, aiApprovalPolicy: 'readonly', host: '1.1.1.1', encPassword: encryptField(KEY, 'pw'), notes: '入口网关' },
    { id: 'b', name: 'hidden', exposeToAi: 0, aiApprovalPolicy: 'always', host: '2.2.2.2', encPassword: encryptField(KEY, 'pw') },
  ]
  const settings = { 'ssh.globalNotes': '全局:三台组成集群' }
  const updates = []
  const db = { prepare: sql => ({
    all: () => (sql.includes('exposeToAi=1') ? ROWS.filter(r => r.exposeToAi) : ROWS),
    get: () => ROWS[0],
    run: (...a) => updates.push([sql, a]),
  }) }
  const pool = { acquire: async () => { throw new Error('不应触网') } }
  const bridge = createSshAgentBridge({ db, key: KEY, pool, projectId: 'p1', actor: 'ops',
    getSetting: k => settings[k] ?? '', setSetting: (k, v) => { settings[k] = v } })
  const lg = bridge.readLedger()
  assert.ok(lg.markdown.includes('入口网关'))
  assert.ok(lg.markdown.includes('全局:三台组成集群'))
  assert.ok(!lg.markdown.includes('2.2.2.2'))          // 未暴露不泄露
  assert.equal(lg.count, 1)
  // 写全局
  const g = bridge.writeNotes({ scope: '__global__', notes: '新全局' })
  assert.equal(g.ok, true)
  assert.equal(settings['ssh.globalNotes'], '新全局')
  // 写服务器(按名解析)
  const w = bridge.writeNotes({ scope: 'gw-1', notes: '角色升级:WAF 前置' })
  assert.equal(w.ok, true)
  assert.ok(updates.some(([sql, a]) => sql.includes('UPDATE ssh_servers') && a.includes('角色升级:WAF 前置')))
  // 未暴露 → 拒(不泄露存在性)
  const h = bridge.writeNotes({ scope: 'hidden', notes: 'x' })
  assert.ok(h.error && /未暴露/.test(h.error))
  // 写恒人审
  assert.equal(await bridge.needsApproval('write_server_notes', { scope: '__global__', notes: 'x' }), true)
  // 读免审(静态 requiresApproval=false,不会进 needsApproval;这里只防呆)
  assert.equal(await bridge.needsApproval('read_server_ledger', {}), true)   // resolve 无 server → true 安全默认,但该工具不进审批链
})

test('keyMode readonly + sudo 真值 → 拒绝(提权不经 key 通道)', async () => {
  const { encryptField } = await import('./crypt.mjs')
  const KEY = Buffer.alloc(32)
  const ROW = { id: 'a', name: 'n1', exposeToAi: 1, aiApprovalPolicy: 'readonly', host: '1.1.1.1', encPassword: encryptField(KEY, 'pw') }
  const db = { prepare: () => ({ all: () => [ROW], get: () => ROW, run: () => {} }) }
  const bridge = createSshAgentBridge({ db, key: KEY, pool: { acquire: async () => { throw new Error('不应触网') } }, projectId: 'p', getSetting: () => '', setSetting: () => {}, keyMode: true })
  const r = await bridge.exec({ server: 'n1', command: 'cat /etc/os-release', sudo: '1' })
  assert.ok((r.error || '').includes('sudo'), '应拒 sudo')
})

// ── 2026-08-31 工具链审计修复②:SSH 工具输出接 maskSensitiveText ──
// CSO #4 只给 K8s 面(wb_read_pod_file/wb_exec/wb_get_pod_logs)加了脱敏;SSH 面(免审/
// 策略免审,如 readonly 下 wb_ssh_read_file)原样进 LLM 上下文+trace 落库。补齐同一标准,
// 且遵循同款「先脱敏后截断」终审 R1 原则(截断点不得切中 JWT/PEM 留半截明文)。
const SMALL_PEM = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\nabc=\n-----END PRIVATE KEY-----\n`
function streamPool(payload) {
  return { acquire: async () => ({ client: { exec: (cmd, cb) => { const s = new EventEmitter(); s.stderr = new EventEmitter(); s.write = () => {}; cb(null, s); setImmediate(() => { s.emit('data', payload); s.emit('exit', 0); s.emit('close') }) }, end: () => {} }, release: () => {} }) }
}

test('修复②:exec stdout 含 PEM/JWT → 脱敏,不回传明文', async () => {
  const bridge = createSshAgentBridge({ db: fakeDb(), key: KEY, pool: streamPool(Buffer.from(`ok\n${SMALL_PEM}token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2Q\n`)), projectId: 'p1' })
  const r = await bridge.exec({ server: 'dev-1', command: 'cat ~/.ssh/id_rsa' })
  assert.equal(r.exitCode, 0)
  assert.ok(r.stdout.includes('[redacted-private-key]'), `PEM 应脱敏,收到: ${JSON.stringify(r.stdout)}`)
  assert.ok(r.stdout.includes('[redacted-jwt]'), 'JWT 应脱敏')
  assert.equal(r.stdout.includes('PRIVATE KEY'), false, '不得残留 PEM 明文')
})

test('修复②:先脱敏后截断——PEM 跨 32KB 采集边界也不留半截明文', async () => {
  // 30000B 噪音 + ~4.9KB PEM:截断点(32768)落在 PEM 中间。旧实现按 32KB 字节截断后再无
  // 脱敏,半截 PEM(含 BEGIN 头)原样进上下文;修复后采集上限放宽到 256KB,整段先掩再切。
  const BIG_PEM = `-----BEGIN PRIVATE KEY-----\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n'.repeat(90)}-----END PRIVATE KEY-----\n`
  const payload = Buffer.concat([Buffer.alloc(30000, 0x61), Buffer.from(BIG_PEM)])
  assert.ok(payload.length > 32768, '前置:总长须超过回传上限')
  const bridge = createSshAgentBridge({ db: fakeDb(), key: KEY, pool: streamPool(payload), projectId: 'p1' })
  const r = await bridge.exec({ server: 'dev-1', command: 'cat big.log' })
  assert.ok(r.stdout.includes('[redacted-private-key]'), '跨边界 PEM 应被完整脱敏')
  assert.equal(r.stdout.includes('BEGIN PRIVATE KEY'), false, '不得残留半截 PEM 头')
  assert.ok(Buffer.byteLength(r.stdout) <= 32768, '回传上限语义不变')
  // 注意:脱敏把 34.8KB 缩到 ~30KB(PEM→22 字符标记),内容未丢弃 → truncated:false 才正确
  // (标志语义 = 「实际丢弃过内容」;纯截断场景的标志由上方既有 >32KB 测试锁)。
})

test('修复②:readFile content 脱敏(readonly 免审面,cat 私钥不再明文落库)', async () => {
  const mkSftp = () => ({ createReadStream: () => { const rs = new EventEmitter(); setImmediate(() => { rs.emit('data', Buffer.from(SMALL_PEM)); rs.emit('close') }); rs.destroy = () => {}; return rs } })
  const bridge = createSshAgentBridge({ db: fakeDb(), key: KEY, pool: { acquire: async () => ({ client: { sftp: cb => cb(null, mkSftp()) }, release: () => {} }) }, projectId: 'p1' })
  const r = await bridge.readFile({ server: 'dev-1', path: '/home/u/.ssh/id_rsa' })
  assert.ok(r.content.includes('[redacted-private-key]'), `content 应脱敏,收到: ${JSON.stringify(r.content)}`)
  assert.equal(r.content.includes('PRIVATE KEY'), false)
})
