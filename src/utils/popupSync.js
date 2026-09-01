// 弹窗标签页 ↔ opener 页状态信令(2026-09-01 终端状态管理修复)。
// 背景:opener 此前仅靠内存 popupWins Map + 2s win.closed 轮询感知弹窗标签页,opener 一刷新
// 这条线即断——「关了还提示开着」「再点击在本页复活浮窗」两个症状同源于此。现在弹窗页持续
// 发「存活信标」、关闭/刷新(pagehide)发「墓碑」,opener 借 storage 事件即时对账:
//   - storage 事件只在「其他」标签页触发,弹窗页写、opener 页收,天然免自环;
//   - 墓碑先降级最小化(即刻视觉反馈),GONE_GRACE_MS 后才收尾移除——刷新也会发 pagehide,
//     弹窗复活信标在宽限期内到达即取消收尾,「关了=关了」与「F5 续跑」两不误。
export const POPUP_ALIVE_KEY = 'aliangboard.termPopupAlive'
export const POPUP_CLOSED_KEY = 'aliangboard.termPopupClosed'
export const GONE_GRACE_MS = 5000

function writeSignal(key, payload) {
  try {
    // n 随写随变:storage 事件只在新旧值不同时触发,同 sid 连续两次关闭也要能通知到
    localStorage.setItem(key, JSON.stringify({ ...payload, at: Date.now(), n: Math.random().toString(36).slice(2) }))
  } catch { /* 存储不可用(隐私模式等):opener 降级回轮询感知,不炸 */ }
}

// 弹窗页:宣告自己活着(meta 供 opener 在记录缺失时重建)
export function announcePopupAlive(kind, sid, meta = {}) { writeSignal(POPUP_ALIVE_KEY, { kind, sid, meta }) }

// 弹窗页:宣告自己没了(关闭/刷新,pagehide 统一走这里)
export function writePopupTombstone(kind, sid) { writeSignal(POPUP_CLOSED_KEY, { kind, sid }) }

// 弹窗页调用:mount 立即发信标 + 心跳续约(opener 刷新后靠下一次心跳重新对齐状态);
// pagehide 发墓碑。返回停止函数(组件卸载调用)。空 sid(手输 URL)直接 no-op。
export function startPopupHeartbeat(kind, sid, meta = {}, intervalMs = 20000) {
  if (!sid) return () => {}
  announcePopupAlive(kind, sid, meta)
  const onHide = () => writePopupTombstone(kind, sid)
  window.addEventListener('pagehide', onHide)
  const timer = setInterval(() => announcePopupAlive(kind, sid, meta), intervalMs)
  return () => { clearInterval(timer); window.removeEventListener('pagehide', onHide) }
}

const syncTargets = new Set()
let installed = false

// opener 侧订阅。handler 收 { type:'alive'|'closed', kind, sid, meta }。
export function onPopupSync(fn) {
  syncTargets.add(fn)
  if (!installed && typeof window !== 'undefined') {
    installed = true
    window.addEventListener('storage', e => {
      if (e.key !== POPUP_ALIVE_KEY && e.key !== POPUP_CLOSED_KEY) return
      try {
        const v = e.newValue ? JSON.parse(e.newValue) : null
        if (v?.kind && v?.sid) {
          const sig = { type: e.key === POPUP_ALIVE_KEY ? 'alive' : 'closed', kind: v.kind, sid: v.sid, meta: v.meta || {} }
          for (const fn of syncTargets) fn(sig)
        }
      } catch { /* 损坏信令忽略 */ }
    })
  }
  return () => syncTargets.delete(fn)
}
