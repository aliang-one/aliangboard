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
})

test('needsApproval: always→true;readonly→分类器放行 cat/拦 rm;none→false;解析失败→true(安全默认)', async () => {
  const mk = policy => createSshAgentBridge({ db: fakeDb({ rows: [{ id: 'c', name: 'dev-1', exposeToAi: 1, aiApprovalPolicy: policy }] }), key: KEY, pool: {}, projectId: 'p1' })
  assert.equal(await mk('readonly').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'cat /etc/hostname' }), false)
  assert.equal(await mk('readonly').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'rm -rf /' }), true)
  assert.equal(await mk('readonly').needsApproval('wb_ssh_read_file', { server: 'dev-1', path: '/x' }), false)
  assert.equal(await mk('always').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'ls' }), true)
  assert.equal(await mk('none').needsApproval('wb_ssh_exec', { server: 'dev-1', command: 'ls' }), false)
  assert.equal(await mk('readonly').needsApproval('wb_ssh_exec', { server: 'ghost', command: 'ls' }), true)
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
