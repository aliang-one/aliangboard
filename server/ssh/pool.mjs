// SSH 连接池:key=serverId。连接按 server 复用(同机同凭据,终端/AI exec 共享);userId
// 只参与引用计数与审计归属(spec 裁决 10 的隔离语义由引用计数+审计按 user 记账承担)。
// 若需严格按 server+user 各自建连,把 Map key 改为 `${serverId}:${userId}` 即可(单行改动)。
//
// ssh2 README 事实核对(2026-08-28,Step 0):
//  - `handshake` 事件的 negotiated 对象只含算法协商(kex/srvHostKey/cs/sc),**不含 host key 本体**
//    → host key 指纹采集走 connect 配置项 `hostVerifier`:「Function with parameters
//    (key[, callback]) for verifying host keys, where key is either a hex string of the hash
//    of the key if hostHash was set, otherwise it is the raw host key in Buffer form. Return
//    true to continue with the handshake or false to reject and disconnect.」(未设 hostHash → Buffer)
//  - `keyboard-interactive` 事件为 5 参数:「(name, instructions, instructionsLang, prompts,
//    finish) … The answers for all prompts must be provided as an array of strings and passed
//    to finish」。`tryKeyboard`:「Try keyboard-interactive user authentication if primary user
//    authentication method fails. If you set this to true, you need to handle the
//    keyboard-interactive event. Default: false.」
//  - `keepaliveInterval`:「How often (in milliseconds) to send SSH-level keepalive packets…
//    Set to 0 to disable. Default: 0」;`readyTimeout`:「How long (in milliseconds) to wait for
//    the SSH handshake to complete. Default: 20000」。
import { createHash } from 'node:crypto'
import { Client as Ssh2Client } from 'ssh2'
import { materializeCreds, recordHostKey } from './store.mjs'
import { OS_PROBE_COMMAND, parseOsRelease, normalizeOsId } from './os-probe.mjs'

export function classifyConnectError(err) {
  const msg = String(err?.message || err)
  // 先判传输层 code(带 code 的 socket 错误不会被 auth/hostkey 文案污染),再判 auth/hostkey 文案
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(err?.code)) return 'unreachable'
  if (err?.code === 'ETIMEDOUT' || /timed?\s?out/i.test(msg)) return 'timeout'
  if (err?.level === 'client-auth' || /authentication|all configured auth/i.test(msg)) return 'auth'
  if (/host key mismatch|hostkey|host key verification/i.test(msg)) return 'hostkey'
  return 'unknown'
}

export function fingerprintHostKey(hk) {
  if (Buffer.isBuffer(hk)) {
    // OpenSSH 风格:SHA256,base64 去填充
    return 'SHA256:' + createHash('sha256').update(hk).digest('base64').replace(/=+$/, '')
  }
  return String(hk) // 已是指纹形态(hex/hostHash 形态或预格式化指纹),原样归一
}

export function buildConnectConfig(row, creds, { hostVerifier, keepaliveMs = 15000 } = {}) {
  const cfg = {
    host: row.host,
    port: row.port ?? 22,
    username: row.username,
    tryKeyboard: true, // README:需自处理 keyboard-interactive 事件
    keepaliveInterval: keepaliveMs,
    readyTimeout: 15000,
  }
  if (row.authMethod === 'password') {
    if (creds.password != null) cfg.password = creds.password
  } else {
    cfg.privateKey = creds.privateKey
    if (creds.passphrase) cfg.passphrase = creds.passphrase
  }
  if (hostVerifier) cfg.hostVerifier = hostVerifier
  return cfg
}

// 一次性 exec 收集 stdout(8KB 封顶):OS 探测等轻量读取用。超时/错误均以单次 settle 兜底。
function execCollect(client, command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let done = false
    let stream = null
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg) }
    const timer = setTimeout(() => { try { stream?.close?.() } catch { /* noop */ }; finish(reject, new Error('exec timeout')) }, timeoutMs)
    client.exec(command, (err, s) => {
      if (done) return
      if (err) return finish(reject, err)
      stream = s
      const chunks = []
      s.on('data', d => { if (chunks.length < 8) chunks.push(d) })
      s.on('close', () => finish(resolve, Buffer.concat(chunks).toString('utf8')))
      s.on('error', e => finish(reject, e))
    })
  })
}

// 统一的连接流程:键盘交互回灌密码、host key 校验(首连记录/不符拒连)、错误归类。
// 返回 Promise<client>;reject 的 Error 带 errorKind。凭据只存在于本闭包与 ssh2 配置内。
// onDead(client):ready 之后连接死亡( error/close)时的池清理钩子 —— error 监听器必须
// 常驻(ssh2 长连接生命周期内随时 emit 'error',无监听器 = uncaught exception = 网关崩),
// settled 后只转发 onDead,不再 reject。
function connectWith(SshClient, row, creds, { keepaliveMs, getKnownFp, recordFp, onDead }) {
  return new Promise((resolve, reject) => {
    // 兼容构造器(class/function)与工厂(箭头函数,测试注入)
    const client = SshClient.prototype ? new SshClient() : SshClient()
    let settled = false
    let hostKeyRejected = false
    const fail = err => {
      if (settled) { try { onDead?.(client) } catch { /* 钩子异常不外泄 */ } return }
      settled = true
      // 首次失败落全栈(服务端日志):界面只见 errorKind/message,排障靠这里(2026-08-28 真机 'prototype' 排查教训)
      console.error(`[ssh] connect ${row.host}:${row.port} failed:`, err?.stack || err?.message || err)
      try { client.end() } catch { /* 已断 */ }
      const e = new Error(err?.message || String(err))
      e.errorKind = hostKeyRejected ? 'hostkey' : classifyConnectError(err)
      reject(e)
    }
    // README 5 参数形状;所有 prompt 统一回灌凭据秘密(password 优先,其次 passphrase)
    const kbSecret = creds.password || creds.passphrase || ''
    client.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
      finish(prompts.map(() => kbSecret))
    })
    client.on('error', fail) // 常驻:settled 前归类 reject,settled 后仅触发池清理(绝不摘除)
    client.on('close', () => {
      fail(new Error(hostKeyRejected ? 'host key mismatch' : 'connection closed'))
    })
    client.on('ready', () => {
      if (settled) return
      settled = true
      resolve(client)
    })
    const hostVerifier = key => {
      try {
        const fp = fingerprintHostKey(key)
        const known = getKnownFp(row.id)
        if (known && known !== fp) { hostKeyRejected = true; return false } // README:return false → 拒绝握手并断开
        if (!known) recordFp(row.id, fp)
        return true
      } catch {
        hostKeyRejected = false
        return false
      }
    }
    client.connect(buildConnectConfig(row, creds, { hostVerifier, keepaliveMs }))
  })
}

export function createSshPool({
  db, key, SshClient = Ssh2Client, keepaliveMs = 15000, maxIdleMs = 300000, now = Date.now,
  onFingerprint = null, knownFp = null,
} = {}) {
  // knownFp(serverId) → 已记录指纹|''(默认查库);onFingerprint(serverId, fp) 首连记录(默认 UPDATE)
  const getKnownFp = knownFp || (id => {
    try { return materializeCreds(db, key, id)?.row?.hostKeyFingerprint || '' } catch { return '' }
  })
  const recordFp = onFingerprint || ((id, fp) => {
    try { recordHostKey(db, id, fp) } catch { /* 只读场景容忍 */ }
  })

  const conns = new Map() // serverId → { client, refs, idleAt }
  const pending = new Map() // serverId → Promise<entry>:并发首连去重(否则后建者覆盖先建者 → 先建连接变孤儿)
  const evict = (serverId, client) => {
    const c = conns.get(serverId)
    if (c?.client === client) conns.delete(serverId)
  }

  // 统一的 release 闭包:refs 归零即进入空闲(reapIdle 的回收窗口从这里起算)
  const handle = entry => ({
    client: entry.client,
    release: () => { entry.refs--; if (entry.refs <= 0) entry.idleAt = now() },
  })

  async function acquire(serverId, userId) {
    void userId // 仅审计归属用(Task 7/11 记账);池按 server 复用(见文件头注释)
    const entry = conns.get(serverId)
    if (entry) {
      entry.refs++
      entry.idleAt = 0
      return handle(entry)
    }
    // 并发首连:第二个调用者 await 同一建连 Promise,拿到同一条连接(refs++),
    // 也顺带消除了 host key TOFU 竞态(只有一个 connectWith 会读 known/recordFp)。
    const inflight = pending.get(serverId)
    if (inflight) {
      const shared = await inflight
      shared.refs++
      shared.idleAt = 0
      return handle(shared)
    }
    const creating = (async () => {
      const credsRow = materializeCreds(db, key, serverId)
      if (!credsRow) {
        const e = new Error('ssh server not found')
        e.errorKind = 'unreachable'
        throw e
      }
      const { row, ...creds } = credsRow
      const client = await connectWith(SshClient, row, creds, {
        keepaliveMs, getKnownFp, recordFp,
        onDead: dead => evict(serverId, dead), // ready 后 error/close 都逐出死连接
      })
      const fresh = { client, refs: 1, idleAt: 0 }
      conns.set(serverId, fresh)
      client.on('close', () => evict(serverId, client))
      return fresh
    })()
    pending.set(serverId, creating)
    try {
      return handle(await creating)
    } finally {
      pending.delete(serverId) // 失败也清位,后续重试可重建
    }
  }

  async function testConnection(row, credsOverride = null) {
    // 两种形态:已保存行(row 来自 store,creds 缺省时解密)或未保存表单(row=null,
    // credsOverride 即表单字段)——后者归一为「表单即行」形状(表单自带 host/port/username/authMethod)。
    let effRow = row
    let creds = credsOverride
    if (!effRow) {
      if (!credsOverride) {
        return { ok: false, errorKind: 'unknown', message: 'no connection target' }
      }
      effRow = credsOverride
    } else if (!creds) {
      try {
        creds = await Promise.resolve(materializeCreds(db, key, row.id))
      } catch {
        // 解密失败≠认证失败:区分开,前端可提示「凭据密钥不可用,请重录」
        return { ok: false, errorKind: 'unknown', message: 'credential decrypt failed' }
      }
      if (!creds) return { ok: false, errorKind: 'unreachable', message: 'ssh server not found' }
      const { row: _r, ...c } = creds; creds = c
    }
    try {
      const client = await connectWith(SshClient, effRow, creds, { keepaliveMs, getKnownFp, recordFp })
      // OS 探测(2026-08-29 列展示迭代):就绪连接上读 /etc/os-release;探测失败不影响连接结论
      let probe = null
      try {
        const out = await execCollect(client, OS_PROBE_COMMAND, 5000)
        probe = parseOsRelease(out)
      } catch { /* 探测失败容忍:osId/osName 留空 */ }
      try { client.end() } catch { /* 已断 */ }
      return { ok: true, osId: probe ? normalizeOsId(probe.osId, probe.osName) : null, osName: probe?.osName || null }
    } catch (e) {
      return { ok: false, errorKind: e.errorKind || classifyConnectError(e), message: e.message }
    }
  }

  function reapIdle() {
    for (const [id, entry] of conns) {
      if (entry.refs <= 0 && entry.idleAt && now() - entry.idleAt > maxIdleMs) {
        try { entry.client.end() } catch { /* 已断 */ }
        conns.delete(id)
      }
    }
  }

  function destroyAll() {
    for (const [, e] of conns) { try { e.client.end() } catch { /* 已断 */ } }
    conns.clear()
  }

  // 按 serverId 逐出(凭据/host/port 轮换、服务器删除时由路由调用):杀连接+清位
  function evictServer(serverId) {
    const e = conns.get(serverId)
    if (e) { try { e.client.end() } catch { /* 已断 */ }; conns.delete(serverId) }
    pending.delete(serverId)
  }
  return { acquire, testConnection, reapIdle, destroyAll, evictServer }
}
