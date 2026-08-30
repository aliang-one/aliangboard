// SSH 异步任务策略:设置>env>默认(每跳现读,改动即时生效)。规格 2026-08-30 §4。
const DEFAULTS = { ttlMin: 120, maxPerServer: 4 }
const clamp = (v, lo, hi, fb) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : fb }
const read = (getFn, env, key, envKey, lo, hi) =>
  clamp(getFn?.(key), lo, hi, clamp(env?.[envKey], lo, hi, DEFAULTS[key === 'ssh.job.ttlMin' ? 'ttlMin' : 'maxPerServer']))

export function resolveJobPolicy(getFn, env = {}) {
  return {
    ttlMin: read(getFn, env, 'ssh.job.ttlMin', 'SSH_JOB_TTL_MIN', 1, 10080),
    maxPerServer: read(getFn, env, 'ssh.job.maxPerServer', 'SSH_JOB_MAX_PER_SERVER', 1, 16),
  }
}
