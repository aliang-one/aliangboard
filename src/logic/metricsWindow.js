// 集群指标采样滚动窗口纯逻辑:不碰 localStorage/DOM(node 零依赖可测)。
// 读写持久化由 cluster store 侧做;本模块只管数据形状与窗口语义。
// Sample = { t: 毫秒时间戳, v: 数值 }
export const WINDOW_MS = 15 * 60 * 1000   // 15 分钟回看
export const MAX_SAMPLES = 180            // 条数上限(防异常时钟写爆)

function isValidSample(s) {
  return s && typeof s === 'object' && typeof s.t === 'number' && typeof s.v === 'number'
    && !isNaN(s.t) && !isNaN(s.v)
}

// 追加样本 → 按龄过滤(以 now 为准)→ 尾部截断 maxCount(保最新)。不可变。
export function pushSample(samples, sample, { maxAgeMs = WINDOW_MS, maxCount = MAX_SAMPLES, now = Date.now() } = {}) {
  const arr = Array.isArray(samples) ? samples.filter(isValidSample) : []
  if (!isValidSample(sample)) return arr.slice(-maxCount)
  const minT = now - maxAgeMs
  return [...arr, sample].filter(s => s.t >= minT).slice(-maxCount)
}

// 从 localStorage JSON 恢复:过滤非法与陈旧样本;任何入参异常都返回 [] 不抛。
export function restoreSamples(raw, { maxAgeMs = WINDOW_MS, now = Date.now() } = {}) {
  if (!Array.isArray(raw)) return []
  const minT = now - maxAgeMs
  return raw.filter(s => isValidSample(s) && s.t >= minT)
}

// 序列化形状(深拷贝,避免引用共享)
export function persistPayload(cpuSamples, memSamples) {
  const cp = (Array.isArray(cpuSamples) ? cpuSamples : []).filter(isValidSample)
  const mp = (Array.isArray(memSamples) ? memSamples : []).filter(isValidSample)
  return { cpu: cp.map(s => ({ t: s.t, v: s.v })), mem: mp.map(s => ({ t: s.t, v: s.v })) }
}
