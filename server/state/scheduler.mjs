// server/state/scheduler.mjs
// 统一清扫驱动(spec §6):收编 index.mjs 各自为政的 setInterval。节奏逐个不变,只统一
// 注册与失败日志——一个 sweep 失败只记 lastError + console.error,不殃及其他(行为改进③的
// 载体:sessionSweeper 吞错改由这里可见)。timer unref,不阻止进程退出(与现状一致)。
const sweeps = new Map() // name -> rec

export function registerSweep({ name, cadenceMs, fn, now = Date.now }) {
  if (sweeps.has(name)) throw new Error(`scheduler: 重名 sweep ${name}`)
  const rec = { name, cadenceMs: Math.max(1, Number(cadenceMs) || 60000), fn, lastRunAt: 0, lastError: null, runs: 0, timer: null }
  rec.timer = setInterval(async () => {
    try { await rec.fn(); rec.lastError = null }
    catch (e) {
      rec.lastError = String(e?.message || e)
      console.error(`[sweep:${rec.name}] failed:`, rec.lastError)
    }
    finally { rec.lastRunAt = now(); rec.runs++ }
  }, rec.cadenceMs)
  rec.timer.unref?.()
  sweeps.set(name, rec)
  return rec
}

export function sweepsSnapshot() {
  return [...sweeps.values()].map(({ name, cadenceMs, lastRunAt, lastError, runs }) =>
    ({ name, cadenceMs, lastRunAt, lastError, runs }))
}

export function _clearSchedulerForTest() {
  for (const s of sweeps.values()) clearInterval(s.timer)
  sweeps.clear()
}
