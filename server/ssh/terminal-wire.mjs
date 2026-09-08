// 终端 WS 接线辅助(自 index.mjs 抽出,使广播语义可脱离真 shell 单测):
//  - attachSocketToSession: 回放快照 → 上行分帧(STDIN 写 channel / RESIZE setWindow+touch)→ drop 回调 onDetach
//  - broadcastToSockets: channel data/close 事件广播到该会话当前附加的所有浏览器 socket
// 所有权收敛(2026-09-07):connIds/primary 的登记与摘除唯一写入者是 TerminalService
// (service.attach 的 doAttach / service.detach)——此前 wire 直写两处,close 事件丢失时
// 状态机漏迁移的「双写根因」即此(sweep 状态修复是兜底,这里是收口)。wire 只读迭代 connIds。
// 约定:session.connIds 为 Map<connId,{socket}>(TerminalService 持有);session.ring 为环形缓冲
//       (snapshot() → Buffer);session.primary 为尺寸仲裁者(2026-09-04):多浏览器窗口尺寸不齐时,
//       共享 pty 只听最新附着者的(语义对齐 tmux latest)——否则「最后 resize 的人赢」,TUI 被反复压扁。

// channel 侧事件广播:任何附加中的浏览器都收到同一份直播帧(Critical #1——
// 不能把回调闭包死绑在首个 ws 上,否则重连者只有回放没有直播)。
// sockets 真值在 TerminalService(connIds: Map<connId,{socket}>),wire 只读迭代。
export function broadcastToSockets(session, send, type, payload) {
  for (const a of session.connIds.values()) send(a.socket, type, payload)
}

// 回放快照尾部裁剪(2026-09-08 线上事故:满 4MB ring × 慢下行客户端 = 重连即灌 4MB,ping/pong
// 排队 60-90s 到不了 → liveness 两轮无 pong 误杀 → 再重连再 4MB 的死亡螺旋)。只回放尾部
// maxBytes,行首对齐(丢弃首个不完整行)+ UTF-8 续字节回退,杜绝从 ANSI/多字节序列中间起刀。
// maxBytes<=0 / 非法值 / 快照未超限 = 原样返回(调用方可据此判断是否发生了截断)。
export function clampReplay(snap, maxBytes) {
  if (!Buffer.isBuffer(snap) || !Number.isFinite(maxBytes) || maxBytes <= 0 || snap.length <= maxBytes) return snap
  let start = snap.length - maxBytes
  const nl = snap.indexOf(10, start)                    // 对齐到下一行首;尾部无换行则按字节硬裁
  if (nl >= 0 && nl + 1 < snap.length) start = nl + 1
  while (start > 0 && (snap[start] & 0xC0) === 0x80) start--   // 0b10xxxxxx = 续字节,回退到前导字节
  // 回退可能使结果超限 ≤2 字节:向前跳过整个多字节字符,UTF-8 完整性与硬上限兼得
  while (snap.length - start > maxBytes && start < snap.length) {
    start++
    while (start < snap.length && (snap[start] & 0xC0) === 0x80) start++
  }
  return snap.subarray(start)
}

// 把一个浏览器 ws 接到已就绪的终端会话:先发快照(重连续跑),再进直播;断开即摘除。
// replayMaxBytes>0 时快照按尾部裁剪(截断时前置一行黄色提示,提示字节计入预算);缺省 0 = 全量。
export function attachSocketToSession(ws, session, { connId = ws, send, touch = () => {}, onDetach = () => {},
  replayMaxBytes = 0, types = { stdin: 1, resize: 2, replay: 6 } } = {}) {
  const full = session.ring.snapshot()
  if (replayMaxBytes > 0 && full.length > replayMaxBytes) {
    const NOTICE_RESERVE = 96   // 提示行字节数上界(全角文案+转义序列实测 ≤53,留裕量)
    const clamped = clampReplay(full, Math.max(1, replayMaxBytes - NOTICE_RESERVE))
    const notice = Buffer.from(`\r\n\x1b[33m[回放已截断:仅显示尾部 ${Math.round(clamped.length / 1024)}KB]\x1b[0m\r\n`)
    send(ws, types.replay, Buffer.concat([notice, clamped]))
  } else if (full.length) {
    send(ws, types.replay, full)
  }
  // 登记(primary 置位)由调用链上游的 service.attach(doAttach)完成;wire 不写 connIds/primary。

  // 上行帧:首字节 = 流标识,payload 为其余字节
  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buf.length < 1) return
    const type = buf[0], payload = buf.subarray(1)
    if (type === types.stdin) {
      touch()
      try { session.channel?.write?.(payload) } catch {}
    } else if (type === types.resize) {
      if (session.connIds.get(connId)?.socket !== ws) return
      if (session.primary !== ws) return   // 非 primary 的 resize 忽略:pty 只听一人的
      touch()   // 调整窗口也是活跃行为:不续期会被 idle sweep 误回收
      try {
        const { cols: c, rows: r } = JSON.parse(payload.toString('utf8'))
        session.channel?.setWindow?.(r, c, 0, 0)   // ssh2 语义 setWindow(rows, cols, height, width)
      } catch {}
    }
  })

  // drop 幂等守卫:ws 库异常断开时 'error' 后必随 'close',不设防会对同一 socket 调两次
  // onDetach → browserCount 双减,多浏览器会话被提前打到 0 → idle 清道夫误杀活会话。
  // connIds/primary 的清理在 onDetach(=service.detach:摘键+primary 顺延+空则转 DETACHED)
  // 内完成,wire 不再直写。
  // 关闭原因一行日志(2026-09-08 排查盲区:连接被杀时网关侧零日志,谁关的/为何关分不清)。
  // error 先到则记 error 为第一因,随后到达的 close 静默(幂等守卫自然吞掉)。
  let dropped = false
  const drop = detail => {
    if (dropped) return
    dropped = true
    console.log(`[ssh] terminal ${session.id || 'unknown'} ws ${detail}`)
    onDetach()
  }
  ws.on('close', (code, reason) => drop(`close code=${code} reason=${Buffer.from(reason || []).toString('utf8').slice(0, 80)}`))
  ws.on('error', err => drop(`error ${String(err?.message || err).slice(0, 80)}`))
}

// —— WS 存活探测(2026-09-04 事故①;复审 F2 改真双振)——
// ws 库不感知半开 TCP:合盖/休眠/代理断链不发 close → drop 不触发 → browserCount 卡 ≥1,
// detached-idle 回收永不生效(shell+ring+池句柄永久泄漏)。标准方案:周期 ping,
// 连续 maxMissed(默认 2)次实际 ping 均未获 pong 即 onDead(漏答轮重发 ping 复验)(网关侧传 ws.terminate() → 触发 'close'
// → drop → 计数归零)——单次未应答给一个周期的宽限,慢速链路不被误杀。
// 浏览器 WebSocket 在协议层自动回 pong,前端零改动。
export function markAlive(ws) {
  ws.isAlive = true
  ws.missedPongs = 0
  ws.on('pong', () => { ws.isAlive = true })
}

export function attachWsLiveness(wsServer, { intervalMs = 30000, maxMissed = 2, onDead = ws => ws.terminate() } = {}) {
  const sweep = () => {
    for (const ws of wsServer.clients) {
      if (ws.isAlive === false) {
        ws.missedPongs = (ws.missedPongs || 0) + 1
        if (ws.missedPongs >= maxMissed) { try { onDead(ws) } catch { /* noop */ } continue }
        try { ws.ping() } catch { /* noop */ }   // 未达双振:重发 ping,口径即「连续两次实际 ping 均未获 pong」
        continue
      }
      ws.missedPongs = 0
      ws.isAlive = false
      try { ws.ping() } catch { /* noop */ }
    }
  }
  const timer = setInterval(sweep, intervalMs)
  timer.unref?.()
  return { sweep, stop: () => clearInterval(timer) }
}

// 入口关闭哨兵(2026-09-04 复审 F1):建连链路里有长 await(池握手最长 15s/shell 建立/
// tmux 探测链),真正的 close/error → drop 监听要到最后接线才注册——窗口内的关闭事件
// 直接丢失(EventEmitter 不重放),handler 继续走完 ensure/attach → browserCount/attached
// 计数卡死 → 会话泄漏。哨兵在 handler 入口同步注册幂等 close/error,任何一处置位 gone;
// handler 在每个 await 后 bail 并释放已取得的资源。接线(drop)接管后调 dispose 拆哨兵。
// 属主建连断开时的处置(复审二 P1):等待首连 ready 的重连者(快速 F5)正在 await 同一
// session.extra.ready——属主此时拆会话会让重连者收到「session 不属于当前用户」。
// 有等待者 → 交棒(保留 channel+会话);无人等待 → 拆(关 channel+撤登记+还池句柄)。
export function teardownOnOwnerGone(waiters) {
  return (waiters || 0) === 0
}

export function createCloseSentinel(ws) {
  const state = { gone: false }
  const mark = () => { state.gone = true }
  ws.on('close', mark)     // mark 幂等(布尔置位),无需 once——dispose 需按原引用摘除
  ws.on('error', mark)
  return {
    get gone() { return state.gone },
    dispose() {
      try { ws.off?.('close', mark) } catch { /* noop */ }
      try { ws.off?.('error', mark) } catch { /* noop */ }
    },
  }
}
