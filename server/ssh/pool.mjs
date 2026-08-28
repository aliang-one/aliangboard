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
import { materializeCreds, recordHostKey } from './store.mjs'

export function classifyConnectError(err) {
  const msg = String(err?.message || err)
  if (err?.level === 'client-auth' || /authentication|all configured auth/i.test(msg)) return 'auth'
  if (/host key mismatch|hostkey|host key verification/i.test(msg)) return 'hostkey'
  if (err?.code === 'ETIMEDOUT' || /timed?\s?out/i.test(msg)) return 'timeout'
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(err?.code)) return 'unreachable'
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

// 统一的连接流程:键盘交互回灌密码、host key 校验(首连记录/不符拒连)、错误归类。
// 返回 Promise<client>;reject 的 Error 带 errorKind。凭据只存在于本闭包与 ssh2 配置内。
function connectWith(SshClient, row, creds, { keepaliveMs, getKnownFp, recordFp }) {
  return new Promise((resolve, reject) => {
    // 兼容构造器(class/function)与工厂(箭头函数,测试注入)
    const client = SshClient.prototype ? new SshClient() : SshClient()
    let settled = false
    let hostKeyRejected = false
    const fail = err => {
      if (settled) return
      settled = true
      try { client.removeAllListeners('close'); client.end() } catch { /* 已断 */ }
      const e = new Error(err?.message || String(err))
      e.errorKind = hostKeyRejected ? 'hostkey' : classifyConnectError(err)
      reject(e)
    }
    // README 5 参数形状;所有 prompt 统一回灌凭据秘密(password 优先,其次 passphrase)
    const kbSecret = creds.password || creds.passphrase || ''
    client.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
      finish(prompts.map(() => kbSecret))
    })
    client.on('error', fail)
    client.on('close', () => {
      const err = new Error(hostKeyRejected ? 'host key mismatch' : 'connection closed')
      fail(err)
    })
    client.on('ready', () => {
      if (settled) return
      settled = true
      client.removeAllListeners('error') // 池内长连:错误后续由 close 兜底清理
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
  db, key, SshClient, keepaliveMs = 15000, maxIdleMs = 300000, now = Date.now,
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
  const evict = (serverId, client) => {
    const c = conns.get(serverId)
    if (c?.client === client) conns.delete(serverId)
  }

  async function acquire(serverId, userId) {
    void userId // 仅审计归属用(Task 7/11 记账);池按 server 复用(见文件头注释)
    const entry = conns.get(serverId)
    if (entry) {
      entry.refs++
      entry.idleAt = 0
      return {
        client: entry.client,
        release: () => { entry.refs--; if (entry.refs <= 0) entry.idleAt = now() },
      }
    }
    const credsRow = materializeCreds(db, key, serverId)
    if (!credsRow) {
      const e = new Error('ssh server not found')
      e.errorKind = 'unreachable'
      throw e
    }
    const { row, ...creds } = credsRow
    const client = await connectWith(SshClient, row, creds, { keepaliveMs, getKnownFp, recordFp })
    const fresh = { client, refs: 1, idleAt: 0 }
    conns.set(serverId, fresh)
    client.on('close', () => evict(serverId, client))
    return {
      client,
      release: () => { fresh.refs--; if (fresh.refs <= 0) fresh.idleAt = now() },
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
        return { ok: false, errorKind: 'auth', message: 'credential decrypt failed' }
      }
      if (!creds) return { ok: false, errorKind: 'unreachable', message: 'ssh server not found' }
      const { row: _r, ...c } = creds; creds = c
    }
    try {
      const client = await connectWith(SshClient, effRow, creds, { keepaliveMs, getKnownFp, recordFp })
      try { client.end() } catch { /* 已断 */ }
      return { ok: true }
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

  return { acquire, testConnection, reapIdle, destroyAll }
}
