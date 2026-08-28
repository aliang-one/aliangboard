// Task 5: 连接池测试。FakeClient 按 ssh2 README 文档形状构造:
//  - hostVerifier(key[, callback]):key 为原始 host key Buffer(hostHash 未设时)
//  - keyboard-interactive(name, instructions, instructionsLang, prompts, finish) 5 参数
//  - ready/error/close 事件;readyTimeout/keepaliveInterval/tryKeyboard 为 connect 配置项
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { classifyConnectError, buildConnectConfig, fingerprintHostKey, createSshPool } from './pool.mjs'
import { encryptField } from './crypt.mjs'

const ROW = { id: 's1', host: '10.0.0.5', port: 22, username: 'ops', authMethod: 'password', hostKeyFingerprint: '' }
const CREDS = { password: 'pw', privateKey: null, passphrase: null, sudoPassword: null }

// 伪 ssh2 Client:记录 connect 配置,按 behavior 注入文档化事件
function FakeClient(behavior = {}) {
  const c = new EventEmitter()
  c.connect = cfg => {
    c.cfg = cfg
    FakeClient.created.push(c)
    setImmediate(() => {
      if (behavior.error) return c.emit('error', behavior.error)
      // hostVerifier 阶段(文档:key 为 Buffer,返回 true 继续 / false 拒绝)
      if (cfg.hostVerifier) {
        const hostKey = Buffer.from(behavior.hostKeyBytes || 'hostkey-bytes')
        const ok = cfg.hostVerifier(hostKey)
        if (ok === false) return c.emit('error', new Error('Handshake failed: host key verification failed'))
      }
      if (behavior.keyboard) {
        // 文档形状:5 参数 (name, instructions, instructionsLang, prompts, finish)
        c.emit('keyboard-interactive', 'auth', '', 'en', [{ prompt: 'Password: ', echo: false }], answers => {
          FakeClient.kbAnswers.push(answers)
          if (behavior.kbThenFail) c.emit('error', { level: 'client-auth', message: 'All configured authentication methods failed' })
          else c.emit('ready')
        })
        return
      }
      c.emit('ready')
    })
  }
  c.end = () => { FakeClient.ended++; c.emit('close') }
  return c
}
FakeClient.created = []
FakeClient.kbAnswers = []
FakeClient.ended = 0
const reset = () => { FakeClient.created = []; FakeClient.kbAnswers = []; FakeClient.ended = 0 }

function fakeDb(row = ROW) {
  // materializeCreds 走真解密:行须带真密文(enc 字段)
  const KEY = Buffer.alloc(32)
  const encRow = { ...row }
  for (const [f, plain] of [['encPassword', 'pw'], ['encPrivateKey', null], ['encPassphrase', null], ['encSudoPassword', null]]) {
    if (plain != null) encRow[f] = encryptField(KEY, plain)
  }
  return { prepare: () => ({ run: () => ({ changes: 1 }), get: () => row == null ? null : encRow }) }
}

test('classifyConnectError: 五类映射', () => {
  assert.equal(classifyConnectError({ code: 'ECONNREFUSED' }), 'unreachable')
  assert.equal(classifyConnectError({ code: 'ENOTFOUND' }), 'unreachable')
  assert.equal(classifyConnectError({ code: 'ECONNRESET' }), 'unreachable')
  assert.equal(classifyConnectError({ code: 'ETIMEDOUT' }), 'timeout')
  assert.equal(classifyConnectError({ message: 'Timed out while waiting for handshake' }), 'timeout')
  assert.equal(classifyConnectError({ level: 'client-auth' }), 'auth')
  assert.equal(classifyConnectError({ message: 'All configured authentication methods failed' }), 'auth')
  assert.equal(classifyConnectError({ message: 'host key mismatch' }), 'hostkey')
  assert.equal(classifyConnectError({ message: 'weird' }), 'unknown')
})

test('buildConnectConfig: password 认证带 tryKeyboard;privateKey 带 key+passphrase;端口默认 22;hostVerifier 透传', () => {
  const c1 = buildConnectConfig(ROW, CREDS, {})
  assert.equal(c1.host, '10.0.0.5')
  assert.equal(c1.port, 22)
  assert.equal(c1.username, 'ops')
  assert.equal(c1.password, 'pw')
  assert.equal(c1.tryKeyboard, true)
  assert.equal(c1.keepaliveInterval, 15000)
  assert.equal(c1.readyTimeout, 15000)
  assert.equal(c1.hostVerifier, undefined)
  const verifier = () => true
  const c1b = buildConnectConfig(ROW, CREDS, { hostVerifier: verifier })
  assert.equal(c1b.hostVerifier, verifier)
  const c2 = buildConnectConfig({ ...ROW, authMethod: 'privateKey' },
    { password: null, privateKey: '---KEY---', passphrase: 'pp' }, {})
  assert.deepEqual(c2.privateKey, '---KEY---')
  assert.equal(c2.passphrase, 'pp')
  assert.equal(c2.password, undefined)
  const c3 = buildConnectConfig({ ...ROW, port: null }, CREDS, {})
  assert.equal(c3.port, 22)
})

test('fingerprintHostKey: Buffer → SHA256:b64(无填充);指纹字符串原样归一', () => {
  const fp = fingerprintHostKey(Buffer.from('abc'))
  assert.ok(fp.startsWith('SHA256:'))
  assert.ok(!fp.includes('='))
  assert.equal(fingerprintHostKey('SHA256:xyz'), 'SHA256:xyz')
})

test('acquire: 首连 ready 后复用同连接(同 server);release 引用计数归零进空闲;首连记录指纹', async () => {
  reset()
  let recorded = null
  const known = {}
  const pool = createSshPool({
    db: fakeDb(), key: Buffer.alloc(32), SshClient: FakeClient,
    onFingerprint: (id, fp) => { recorded = [id, fp] },
    knownFp: id => known[id] || '',
  })
  const a = await pool.acquire('s1', 'u1')
  assert.equal(FakeClient.created.length, 1)
  assert.ok(recorded, '首连记录指纹')
  assert.equal(recorded[0], 's1')
  assert.ok(recorded[1].startsWith('SHA256:'))
  const b = await pool.acquire('s1', 'u1')
  assert.equal(FakeClient.created.length, 1, '同 server 复用')
  a.release()
  const c = await pool.acquire('s1', 'u2')
  assert.equal(FakeClient.created.length, 1, '同 server 不同 user 复用底层连接(设计裁决:池按 server,user 只引用计数)')
  b.release(); c.release()
})

test('acquire: host key 不符 → errorKind=hostkey 且不落指纹;认证失败 → errorKind=auth', async () => {
  reset()
  const pool = createSshPool({ db: fakeDb(), key: Buffer.alloc(32), SshClient: FakeClient,
    onFingerprint: () => {}, knownFp: () => 'SHA256:mismatch' })
  await assert.rejects(() => pool.acquire('s1', 'u1'), e => e.errorKind === 'hostkey')
  reset()
  const pool3 = createSshPool({ db: fakeDb(), key: Buffer.alloc(32),
    SshClient: behaviorClient({ error: { level: 'client-auth', message: 'All configured authentication methods failed' } }),
    onFingerprint: () => {}, knownFp: () => '' })
  await assert.rejects(() => pool3.acquire('s1', 'u1'), e => e.errorKind === 'auth')
})

function behaviorClient(behavior) { return () => FakeClient(behavior) }

test('acquire: 不存在的 server → errorKind=unreachable', async () => {
  reset()
  const db = fakeDb(null)
  const pool = createSshPool({ db, key: Buffer.alloc(32), SshClient: FakeClient, onFingerprint: () => {}, knownFp: () => '' })
  await assert.rejects(() => pool.acquire('nope', 'u1'), e => e.errorKind === 'unreachable')
})

test('keyboard-interactive: 回灌 password(5 参数文档形状)', async () => {
  reset()
  const pool = createSshPool({ db: fakeDb(), key: Buffer.alloc(32),
    SshClient: behaviorClient({ keyboard: true }), onFingerprint: () => {}, knownFp: () => '' })
  const h = await pool.acquire('s1', 'u1')
  assert.deepEqual(FakeClient.kbAnswers, [['pw']])
  h.release()
})

test('reapIdle: 空闲超时回收;持有中不回收;destroyAll 全清', async () => {
  reset()
  let t = 1000
  const pool = createSshPool({ db: fakeDb(), key: Buffer.alloc(32), SshClient: FakeClient,
    onFingerprint: () => {}, knownFp: () => '', maxIdleMs: 5000, now: () => t })
  const h = await pool.acquire('s1', 'u1')
  h.release()                       // refs → 0, idleAt=1000
  t = 5000
  pool.reapIdle()                   // 空闲 4000 < 5000,不回收
  assert.equal(FakeClient.ended, 0)
  const h2 = await pool.acquire('s1', 'u1')
  t = 20000
  pool.reapIdle()                   // 持有中不回收
  assert.equal(FakeClient.ended, 0)
  h2.release()
  t = 30000
  pool.reapIdle()                   // 空闲 10000 > 5000,回收
  assert.equal(FakeClient.ended, 1)
  const h3 = await pool.acquire('s1', 'u1')   // 回收后再取 → 新建
  assert.equal(FakeClient.created.length, 2)
  pool.destroyAll()
  assert.equal(FakeClient.ended, 2)
  h3.release()
})

test('testConnection: 未保存表单(row=null, credsOverride)归一为表单行 → ok:true;失败返回 errorKind', async () => {
  reset()
  const pool = createSshPool({ db: fakeDb(), key: Buffer.alloc(32), SshClient: FakeClient, onFingerprint: () => {}, knownFp: () => '' })
  const form = { host: '10.0.0.5', port: 22, username: 'ops', authMethod: 'password', password: 'pw', privateKey: null, passphrase: null }
  const out = await pool.testConnection(null, form)
  assert.deepEqual(out, { ok: true })
  const out2 = await pool.testConnection(ROW, CREDS)
  assert.deepEqual(out2, { ok: true })
  reset()
  const pool2 = createSshPool({ db: fakeDb(), key: Buffer.alloc(32),
    SshClient: behaviorClient({ error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' } }),
    onFingerprint: () => {}, knownFp: () => '' })
  const out3 = await pool2.testConnection(null, form)
  assert.equal(out3.ok, false)
  assert.equal(out3.errorKind, 'unreachable')
})
