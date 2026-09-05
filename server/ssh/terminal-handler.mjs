// SSH 终端 WS handler(2026-09-05 方案 P1 Task5:自 index.mjs move-only 抽取,逻辑零改动;
// 后续任务在此文件收敛到 TerminalService)。deps 注入清单见 createSshTerminalHandler。
import { markAlive, createCloseSentinel, attachSocketToSession, broadcastToSockets, teardownOnOwnerGone } from './terminal-wire.mjs'

export function createSshTerminalHandler(deps) {
  const { sshPool, registry, writeAudit, wsSend, lookupServer, CH } = deps
  const { ERROR: CH_ERROR, STDIN: CH_STDIN, RESIZE: CH_RESIZE, REPLAY: CH_REPLAY, STDOUT: CH_STDOUT } = CH
  const handler = async (ws, ps, url) => {
  markAlive(ws)   // WS 存活探测打标(半开 TCP 不发 close,靠 ping/pong 发现死连接)
  // 入口关闭哨兵(2026-09-04 复审 F1):建连链路的 await 窗口内浏览器断开时,close 先于
  // 接线发生会被 EventEmitter 丢失 → 计数卡死泄漏。每个 await 后 bail 并释放已取得资源。
  const sentinel = createCloseSentinel(ws)
  const serverId = url.searchParams.get('serverId')
  // sid 必传(2026-08-29 审计):此前缺失时 crypto.randomUUID() 补位 → 客户端永远无从知道
  // sid,会话成任务栏/对账盲区(「不可见活会话」的出生通道)。契约硬化:缺即拒。
  const sid = url.searchParams.get('sid')
  const cols = Math.min(Math.max(parseInt(url.searchParams.get('cols')) || 80, 20), 500)
  const rows = Math.min(Math.max(parseInt(url.searchParams.get('rows')) || 24, 5), 300)
  if (!serverId || !sid) { wsSend(ws, CH_ERROR, 'missing serverId or sid'); return ws.close() }
  try {
    const row = lookupServer(serverId)
    if (!row) { wsSend(ws, CH_ERROR, 'SSH 服务器不存在或已被删除'); return ws.close() }
  } catch { /* 查库失败不阻断(与旧网关兼容) */ }
  try {
    // 已有会话(刷新重连):复用 channel,只回放+接线
    let session = registry.get(sid)
    if (!session) {
      const { client, release } = await sshPool.acquire(serverId, ps.userId)
      if (sentinel.gone) { try { release() } catch { /* noop */ } return }   // 窗口内已断:还池句柄,不留痕
      let shellOk, shellFail
      const ready = new Promise((res, rej) => { shellOk = res; shellFail = rej })
      // 先 ensure 再开 shell:打开窗口期进来的第二个连接走重连分支,await extra.ready 等同一结果
      session = registry.ensure(sid, { serverId, userId: ps.username },
        () => ({ ready, sockets: new Set() }))
      // 竞态守卫:get 判空到 ensure 之间隔着整个 await acquire(最长 15s 握手)。若 ensure
      // 返回的是并发首连方 factory 产出的会话(extra.ready !== 自己的 ready),本连接非属主:
      // 立即归还自己多余的池句柄(不覆盖 extra.release,否则首连方引用永不归零),转走
      // 「等首连 ready」路径——同一 sid 永远只有一条 shell 通道、一个有效 release(2026-08-28 修复)。
      if (session.extra.ready !== ready) {
        try { release() } catch { /* noop */ }
        session.extra.waiters = (session.extra.waiters || 0) + 1   // 登记等待:属主断开时不得拆会话(复审二 P1)
        try {
          try { await session.extra.ready } catch (e) {
            wsSend(ws, CH_ERROR, e?.message || 'ssh terminal failed')
            try { ws.close() } catch {}
            return
          }
          if (sentinel.gone) return   // 已断:句柄已归还、尚未 attach,无资源需清理
        } finally { session.extra.waiters = Math.max(0, (session.extra.waiters || 1) - 1) }
      } else {
      session.extra.release = release
      client.shell({ cols, rows, term: 'xterm-256color' }, (err, channel) => {
        if (err) return shellFail(err)
        session.extra.channel = channel
        // 直播帧广播到该会话所有附加浏览器(不能闭包死绑首个 ws——否则重连者无直播)
        channel.on('data', d => { registry.markOutput(sid); session.ring.push(d); broadcastToSockets(session, wsSend, CH_STDOUT, d) })
        channel.stderr?.on?.('data', d => { registry.markOutput(sid); session.ring.push(d); broadcastToSockets(session, wsSend, CH_STDOUT, d) })
        channel.on('close', () => {
          // 复审三 P1:channel close 事件可能晚到——期间同 sid 已被重连者重建新会话时,
          // 旧回调按 sid 裸删会误删新会话。身份不符(或已撤)则与新会话无涉,直接返回。
          if (registry.get(sid) !== session) return
          broadcastToSockets(session, wsSend, CH_ERROR, 'channel closed')
          for (const s of session.extra.sockets) { try { s.close() } catch {} }
          session.extra.sockets.clear()
          // shell 已死:撤登记+还池句柄;重连同 sid 走全新会话(否则会接到死 channel 挂死)
          registry.close(sid, s => s.extra.release?.())
        })
        shellOk()
      })
      try { await ready } catch (shellErr) {
        // 首连失败清理:ensure 已登记、release 已挂,须撤登记+还池句柄,防泄漏
        // (窗口期进来的第二个连接 await 同一个 ready 被拒,自然收 ERROR,不动已删会话)
        registry.closeIf(sid, session, s => s.extra.release?.())
        throw shellErr
      }
      if (sentinel.gone) {
        // 属主建连窗口内已断。复审二 P1:有等待 extra.ready 的重连者(快速 F5)必须交棒——
        // 拆会话会让等待者收到「session 不属于当前用户」;channel+会话原样留给等待者接管。
        if (!teardownOnOwnerGone(session.extra.waiters)) {
          writeAudit({ owner: ps.username, verb: 'open', tool: 'ssh_terminal', result: 'ok', requestSummary: `server=${serverId} sid=${sid}`, source: 'platform' })
          return
        }
        try { session.extra.channel?.close?.() } catch { /* noop */ }
        registry.closeIf(sid, session, s2 => s2.extra.release?.())
        writeAudit({ owner: ps.username, verb: 'open', tool: 'ssh_terminal', result: 'ok', requestSummary: `server=${serverId} sid=${sid}`, source: 'platform' })
        writeAudit({ owner: ps.username, verb: 'close', tool: 'ssh_terminal', result: 'ok', reason: 'client-gone-during-setup', requestSummary: `server=${serverId} sid=${sid}`, source: 'platform' })
        return
      }
      writeAudit({ owner: ps.username, verb: 'open', tool: 'ssh_terminal', result: 'ok', requestSummary: `server=${serverId} sid=${sid}`, source: 'platform' })
      }
    } else if (!session.extra.channel) {
      // 首连 shell 打开窗口期进来的连接:等首连方开 shell 的结果;失败则本 ws 收 ERROR,会话归首连方收尾
      session.extra.waiters = (session.extra.waiters || 0) + 1
      try {
        try { await session.extra.ready } catch (e) {
          wsSend(ws, CH_ERROR, e?.message || 'ssh terminal failed')
          try { ws.close() } catch {}
          return
        }
        if (sentinel.gone) return   // 已断:尚未 attach,无资源需清理
      } finally { session.extra.waiters = Math.max(0, (session.extra.waiters || 1) - 1) }
    }
    if (!registry.attach(sid, ps.username)) {   // sid 属主校验:他人会话不可附
      wsSend(ws, CH_ERROR, 'session 不属于当前用户')
      try { ws.close() } catch {}
      return
    }
    // 回放前先把共享 pty 调到本客户端尺寸(2026-09-04 resize 仲裁):SIGWINCH 让 TUI 立即按
    // 新尺寸重绘,旧尺寸的历史快照紧随其后,避免错位重排;本 ws 随即成为 primary(尺寸唯一话事人)
    try { session.extra.channel?.setWindow?.(rows, cols) } catch { /* channel 未就绪 */ }
    // 回放 → 直播:snapshot 先发、再注册进 sockets——单线程内顺序成立,无竞态
    attachSocketToSession(ws, session, {
      send: wsSend,
      touch: () => registry.touch(sid),
      onDetach: () => registry.detachBrowser(sid),
      types: { stdin: CH_STDIN, resize: CH_RESIZE, replay: CH_REPLAY },
    })
    sentinel.dispose()   // 此后 close/error 由 attachSocketToSession 的 drop 全权负责
  } catch (e) {
    wsSend(ws, CH_ERROR, e?.message || 'ssh terminal failed')
    try { ws.close() } catch {}
  }
  }
    return handler
}
