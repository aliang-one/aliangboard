// server/state/kernel.mjs
// 状态原语内核(spec §4)。三原语之一:ttlStore——KV+过期(+可选 FIFO cap/purgeFuse/getdel)。
// 值形状零破坏:值自带有限数值 exp 则沿用(现有票据/缓存值形状已带 exp,测试播种 past-exp、
// get 后突变 exp 全兼容);无 exp 按插入时戳+ttlMs 判(不入值对象,不污染调用方形状);
// ttlMs=null 永不过期。过期惰性判(get/has 读即删过期项)。
import { registerState } from './registry.mjs'

// 工厂内创建的 store 会随工厂多次调用重复登记(测试反复 createXxx)——首个实例持有登记,
// 后续静默跳过(观测面板只看生产单实例)。registry 本身的重名 throw 语义保留给手工登记面。
function registerQuietly(meta) {
  try { registerState(meta) } catch { /* 重名:首实例已登记 */ }
}

const ttlStores = new Set()   // 全部在册 ttlStore(purgeAllTtlStores 用;server/state/ 内,守卫豁免区)

export function createTtlStore({ name, domain, ttlMs = null, cap = null, purgeFuse = null, getdel = false, now = Date.now }) {
  const map = new Map() // key -> { v, stampedExp }
  const liveExp = (entry) => {
    const v = entry.v
    if (v && typeof v === 'object' && typeof v.exp === 'number' && Number.isFinite(v.exp)) return v.exp
    return entry.stampedExp
  }
  function peek(key, { consume = false } = {}) {
    const entry = map.get(key)
    if (entry === undefined) return undefined
    if (now() >= liveExp(entry)) { map.delete(key); return undefined }
    if (consume && getdel) map.delete(key)
    return entry.v
  }
  const store = {
    set(key, value) {
      map.set(key, { v: value, stampedExp: ttlMs == null ? Infinity : now() + ttlMs })
      if (cap != null && map.size > cap) map.delete(map.keys().next().value)   // FIFO 逐最旧(插入序)
      if (purgeFuse != null && map.size > purgeFuse) store.purgeExpired()      // 签发顺手清过期(保险丝)
      return value
    },
    get(key) { return peek(key, { consume: true }) },   // getdel=true 时读即删(Redis GETDEL 语义;has 只探不删)
    has(key) { return peek(key) !== undefined },
    delete(key) { return map.delete(key) },   // Map 兼容名(singleFlight 同款;brief 契约:set/get/has/delete/size)
    clear() { map.clear() },
    get size() { return map.size },
    purgeExpired() {
      let n = 0
      for (const [k, entry] of map) if (now() >= liveExp(entry)) { map.delete(k); n++ }
      return n
    },
    snapshot() {
      let expired = 0
      for (const entry of map.values()) if (now() >= liveExp(entry)) expired++
      return { entries: map.size, ttlMs, cap, purgeFuse, expired }
    },
  }
  registerQuietly({ name, domain, primitive: 'ttl', describe: () => store.snapshot() })
  ttlStores.add(store)
  return store
}

// scheduler 的 statePurge sweep 调(Task 14 接线;行为改进②:修未消费票据永久滞留)。
export function purgeAllTtlStores() {
  let n = 0
  for (const s of ttlStores) n += s.purgeExpired()
  return n
}

// 节流原语:窗口内首触 true(= Redis SET NX EX 语义)。key-usage-touch 的 lastTouch 语义单源化。
export function createThrottle({ name, domain, windowMs = 60_000, now = Date.now }) {
  const last = new Map() // key -> ts
  const t = {
    touch(key, at = now()) {
      const prev = last.get(key)
      if (prev != null && at - prev < windowMs) return false
      last.set(key, at)
      return true
    },
    clear() { last.clear() },
    get size() { return last.size },
    snapshot() { return { entries: last.size, windowMs } },
  }
  registerQuietly({ name, domain, primitive: 'throttle', describe: () => t.snapshot() })
  return t
}

// 单飞原语(Map 形在途去重):sa-binding _inflight / summarize inflight 语义单源化。
// 不自动清理——调用方 finally delete(与现状一致);注册进 registry 暴露 entries。
export function createSingleFlight({ name, domain }) {
  const map = new Map() // key -> Promise
  const sf = {
    has: (k) => map.has(k),
    get: (k) => map.get(k),
    set: (k, p) => { map.set(k, p); return p },
    delete: (k) => map.delete(k),
    clear() { map.clear() },
    get size() { return map.size },
    snapshot() { return { entries: map.size } },
  }
  registerQuietly({ name, domain, primitive: 'singleflight', describe: () => sf.snapshot() })
  return sf
}
