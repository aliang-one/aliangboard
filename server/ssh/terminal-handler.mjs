// SSH 终端 WS handler(2026-09-05 方案 P1:Task5 自 index.mjs move-only 抽取;Task6 收敛到
// TerminalService——生命周期/计数/资源全部走 service,handler 只做协议与接线)。
// `sid` query 参数名沿用(P1 契约:字段名旧,语义新 = terminalId)。
import { markAlive, createCloseSentinel, attachSocketToSession } from './terminal-wire.mjs'

export function createSshTerminalHandler(deps) {
  const { service, sshPool, writeAudit, wsSend, lookupServer, CH } = deps
  const { ERROR: CH_ERROR, STDIN: CH_STDIN, RESIZE: CH_RESIZE, REPLAY: CH_REPLAY, STDOUT: CH_STDOUT } = CH

  const handler = async (ws, ps, url) => {
    markAlive(ws)   // WS 存活探测打标(半开 TCP 不发 close,靠 ping/pong 发现死连接)
    ws.terminalId = url.searchParams.get('sid') || 'ssh:?'   // liveness terminate 日志的盖章
    // 入口关闭哨兵:建连链路的 await 窗口内浏览器断开时,close 先于接线发生会被
    // EventEmitter 丢失 → 计数卡死泄漏。每个 await 后 bail 并释放已取得资源。
    const sentinel = createCloseSentinel(ws)
    const serverId = url.searchParams.get('serverId')
    const tid = url.searchParams.get('sid')
    const cols = Math.min(Math.max(parseInt(url.searchParams.get('cols')) || 80, 20), 500)
    const rows = Math.min(Math.max(parseInt(url.searchParams.get('rows')) || 24, 5), 300)
    if (!serverId || !tid) { wsSend(ws, CH_ERROR, 'missing serverId or sid'); return ws.close() }
    try {
      const row = lookupServer(serverId)
      if (!row) { wsSend(ws, CH_ERROR, 'SSH 服务器不存在或已被删除'); return ws.close() }

      let session = service.get(tid)
      let isOwner = false
      let created = false
      if (!session) {
        const { client, release } = await sshPool.acquire(serverId, ps.userId)
        if (sentinel.gone) { try { release() } catch { /* noop */ } return }   // 窗口内已断:还池句柄
        // 创建单飞由 service.getOrCreate 结构性保证;第二连接走 existing(等待者排队)
        const got = service.getOrCreate(tid, () =>
          service.newTerminal({ id: tid, owner: ps.username, serverId, backend: 'ephemeral' }))
        session = got.terminal
        created = !got.existing
        isOwner = created
        if (isOwner) service.bindRelease(tid, release)   // 池句柄挂到终端(LOST/CLOSED 时释放)
        else { try { release() } catch { /* noop */ } }  // 非属主:多余句柄立即归还

        // isOwner 门控(2026-09-05 审计#4,v1.0.24 的 2026-08-28 守卫在重写中丢失):
        // get 判空到 getOrCreate 之间隔着整个 await acquire(最长 15s 握手)——两个冷连接同
        // 挤进本分支时,只有属主开 shell;非属主的多余句柄已还,落到底部 attach 排队等 ready。
        // 无此门:第二条 shell 覆盖 bindChannel、其 close 事件 markLost 误杀活会话。
        if (isOwner) {
          client.shell({ cols, rows, term: 'xterm-256color' }, (err, channel) => {
            if (err) return service.markBackendFailed(tid, err)
            // 迟到回调守卫(2026-09-05 评审#2):shell 建链窗口(真实 SSH 可达秒级)内终端
            // 已被 force-kill(CLOSED/LOST/CLOSING)时,releaseBackend 已跑、无人再关这条
            // 新通道——直接关掉它,绝不把活通道绑上残尸(身份守卫挡不住:同对象)。
            const tNow = service.get(tid)
            if (!tNow || tNow.status === 'CLOSED' || tNow.status === 'LOST' || tNow.status === 'CLOSING' || tNow.closing) {
              try { channel.close() } catch { /* noop */ }
              return
            }
            service.bindChannel(tid, channel)
            channel.on('data', d => { service.touch(tid); service.markOutput(tid, d); service.broadcast(tid, CH_STDOUT, d, wsSend) })
            channel.stderr?.on?.('data', d => { service.touch(tid); service.markOutput(tid, d); service.broadcast(tid, CH_STDOUT, d, wsSend) })
            channel.on('close', () => {
              // 复审三 P1:channel close 事件可能晚到——期间同 tid 已被重连者重建新会话时,
              // 旧回调不得动新会话(身份守卫),资源由 service.markLost 统一释放。
              if (service.get(tid) !== session) return
              service.broadcast(tid, CH_ERROR, 'channel closed', wsSend)
              service.markLost(tid, 'channel-closed')
            })
            session.resolveReady({ status: session.status })
          })
        }
      } else if (session.status === 'CREATING') {
        // 创建窗口期的第二连接:attach 会排队等 ready(无需额外处理)
      }

      // 属主校验(他人会话不可附)
      if (session.owner !== ps.username) {
        wsSend(ws, CH_ERROR, 'session 不属于当前用户')
        try { ws.close() } catch { /* noop */ }
        return
      }
      // attach:CREATING→排队等 ready;LOST/CLOSED/CLOSING→拒绝;其余→登记 attachment
      const att = await service.attach(tid, ws, ws)
      if (!att.ok) {
        wsSend(ws, CH_ERROR, att.reason || 'ssh terminal failed')
        try { ws.close() } catch { /* noop */ }
        return
      }
      if (sentinel.gone) { service.detach(tid, ws, 'client-gone-after-attach'); return }
      if (isOwner) {
        writeAudit({ owner: ps.username, verb: 'open', tool: 'ssh_terminal', result: 'ok', requestSummary: `server=${serverId} tid=${tid}`, source: 'platform' })
      }

      // 回放前先把共享 pty 调到本客户端尺寸:SIGWINCH 让 TUI 立即按新尺寸重绘
      try { session.channel?.setWindow?.(rows, cols) } catch { /* channel 未就绪 */ }
      attachSocketToSession(ws, session, {
        send: wsSend,
        connId: ws,
        touch: () => service.touch(tid),
        onDetach: () => service.detach(tid, ws, 'ws-close'),
        replayMaxBytes: deps.replayMaxBytes || 0,
        types: { stdin: CH_STDIN, resize: CH_RESIZE, replay: CH_REPLAY },
      })
      sentinel.dispose()   // 此后 close/error 由 attachSocketToSession 的 drop 全权负责
    } catch (e) {
      wsSend(ws, CH_ERROR, e?.message || 'ssh terminal failed')
      try { ws.close() } catch { /* noop */ }
    }
  }
  return handler
}
