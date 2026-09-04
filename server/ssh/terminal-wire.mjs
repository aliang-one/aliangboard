// 终端 WS 接线辅助(自 index.mjs 抽出,使广播语义可脱离真 shell 单测):
//  - attachSocketToSession: 回放快照 → 注册进 session.extra.sockets → 上行分帧(STDIN 写 channel / RESIZE setWindow+touch)
//  - broadcastToSockets: channel data/close 事件广播到该会话当前附加的所有浏览器 socket
// 约定:session.extra.sockets 为 Set<ws>;session.ring 为环形缓冲(snapshot() → Buffer);
//       session.extra.primary 为尺寸仲裁者(2026-09-04):多浏览器窗口尺寸不齐时,共享 pty
//       只听最新附着者的(语义对齐 tmux latest)——否则「最后 resize 的人赢」,TUI 被反复压扁。

// channel 侧事件广播:任何附加中的浏览器都收到同一份直播帧(Critical #1——
// 不能把回调闭包死绑在首个 ws 上,否则重连者只有回放没有直播)。
export function broadcastToSockets(session, send, type, payload) {
  for (const ws of session.extra.sockets || []) send(ws, type, payload)
}

// 把一个浏览器 ws 接到已就绪的终端会话:先发快照(重连续跑),再进直播;断开即摘除。
export function attachSocketToSession(ws, session, { send, touch = () => {}, onDetach = () => {},
  types = { stdin: 1, resize: 2, replay: 6 } } = {}) {
  const snap = session.ring.snapshot()
  if (snap.length) send(ws, types.replay, snap)
  ;(session.extra.sockets ||= new Set()).add(ws)
  session.extra.primary = ws   // 最新附着者成为尺寸仲裁者;离开时顺延给剩余附着者

  // 上行帧:首字节 = 流标识,payload 为其余字节
  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buf.length < 1) return
    const type = buf[0], payload = buf.subarray(1)
    if (type === types.stdin) {
      touch()
      try { session.extra.channel?.write?.(payload) } catch {}
    } else if (type === types.resize) {
      if (session.extra.primary !== ws) return   // 非 primary 的 resize 忽略:pty 只听一人的
      touch()   // 调整窗口也是活跃行为:不续期会被 idle sweep 误回收
      try {
        const { cols: c, rows: r } = JSON.parse(payload.toString('utf8'))
        session.extra.channel?.setWindow?.(r, c, 0, 0)   // ssh2 语义 setWindow(rows, cols, height, width)
      } catch {}
    }
  })

  // drop 幂等守卫:ws 库异常断开时 'error' 后必随 'close',不设防会对同一 socket 调两次
  // onDetach → browserCount 双减,多浏览器会话被提前打到 0 → idle 清道夫误杀活会话。
  let dropped = false
  const drop = () => {
    if (dropped) return
    dropped = true
    session.extra.sockets?.delete(ws)
    if (session.extra.primary === ws) session.extra.primary = [...(session.extra.sockets || [])][0] || null
    onDetach()
  }
  ws.on('close', drop)
  ws.on('error', drop)
}
