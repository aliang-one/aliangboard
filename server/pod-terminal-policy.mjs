// Pod 终端(tmux)空闲回收策略(2026-09-05「终端与会话」配置页):设置 > env > 默认。
// 键 pod.terminal.idleReapMin(分钟,整数 0~10080,0=禁用);env IDLE_TTL_MS(毫秒)只兜底正数,
// 取整为 0 的亚分钟值按 1 分钟处理(误读成「禁用」比放宽到 1min 更糟)。
// 镜像 ssh/reap-policy resolvePolicy 风格:非法落库值 warn 按缺省,绝不抛(sweep 里抛=清道夫死);
// getFn 抛异常(库不可用)同论。
import { isValidMinutes } from './ssh/reap-policy.mjs'

export const POD_TERMINAL_POLICY_DEFAULT = { idleReapMin: 30 }

export function resolvePodTerminalPolicy(getFn, env = {}) {
  let raw = null
  try { raw = getFn?.('pod.terminal.idleReapMin') ?? null } catch { raw = null }
  // 空串/空白 = 无值(落 env/默认),与显式 '0'=禁用是两回事——Number('')===0 会把它们混淆
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw)
    if (isValidMinutes(n)) return { idleReapMin: n }
    console.warn(`[terminal] 非法 pod 终端空闲回收值 pod.terminal.idleReapMin=${raw},按缺省处理`)
  }
  const envMs = Number(env.IDLE_TTL_MS)
  if (Number.isFinite(envMs) && envMs > 0) return { idleReapMin: Math.max(1, Math.floor(envMs / 60000)) }
  return { ...POD_TERMINAL_POLICY_DEFAULT }
}
