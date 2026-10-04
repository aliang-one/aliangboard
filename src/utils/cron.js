// cron 表达式工具(零依赖自研,K8s CronJob schedule = 标准 5 字段 vixie cron + @快捷)。
// 消费方:CronJob 详情页调度卡片(人性化文案 + 下次运行预估)。
// 约定:解析失败一律返回 null / [](调用方回退展示原始表达式),绝不抛错。
//
// vixie 语义要点:
// - dom 与 dow **都受限**时按 OR 合并(1 号 ∪ 周一),仅一方受限则按交集匹配;
//   「受限」= 字面 '*' 之外的任何写法(含 */1),doms/dows 用 null 表示未限制以区分满集。
// - dow 名 sun-sat、7≡0、区间可回绕(fri-mon = 5,6,0,1);a/n 是 a..max/n 的缩写。

const FIELD_DEFS = [
  { key: 'minutes', min: 0, max: 59 },
  { key: 'hours', min: 0, max: 23 },
  { key: 'doms', min: 1, max: 31 },
  { key: 'months', min: 1, max: 12 },
  { key: 'dows', min: 0, max: 7, dow: true },
]
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const SHORTCUTS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
}

const fullSet = (min, max) => { const s = new Set(); for (let v = min; v <= max; v++) s.add(v); return s }

// 单字段解析:'*' → { set: null }(未限制);坏语法/越界 → { ok: false }
function parseList(raw, def) {
  if (raw === '*') return { ok: true, set: null }
  const out = new Set()
  for (const term of raw.split(',')) {
    if (!term) return { ok: false }
    const slash = term.split('/')
    if (slash.length > 2) return { ok: false }
    let step = 1
    if (slash.length === 2) {
      step = Number(slash[1])
      if (!Number.isInteger(step) || step < 1) return { ok: false }
    }
    const rangePart = slash[0]
    let from, to
    if (rangePart === '*') { from = def.min; to = def.max }
    else if (rangePart.includes('-')) {
      const [aRaw, bRaw] = rangePart.split('-')
      const a = def.dow ? dowToken(aRaw) : numToken(aRaw)
      const b = def.dow ? dowToken(bRaw) : numToken(bRaw)
      if (a == null || b == null) return { ok: false }
      from = a; to = b
    } else {
      const v = def.dow ? dowToken(rangePart) : numToken(rangePart)
      if (v == null) return { ok: false }
      from = v
      to = slash.length === 2 ? def.max : v   // a/n = a..max/n(vixie)
    }
    if (from < def.min || from > def.max || to < def.min || to > def.max) return { ok: false }
    if (from <= to) { for (let v = from; v <= to; v += step) out.add(v) }
    else {   // 回绕区间(仅 dow):a..max ∪ min..b,两段各按 step
      for (let v = from; v <= def.max; v += step) out.add(v)
      for (let v = def.min; v <= to; v += step) out.add(v)
    }
  }
  if (def.dow && out.has(7)) { out.delete(7); out.add(0) }   // 7 ≡ 周日
  return { ok: true, set: out }
}

const numToken = tok => (/^\d+$/.test(tok) ? Number(tok) : null)
const dowToken = tok => (DOW_NAMES[tok] != null ? DOW_NAMES[tok] : /^\d+$/.test(tok) ? Number(tok) : null)

function parseFields(str) {
  const parts = str.split(/\s+/)
  if (parts.length !== 5) return null
  const lists = parts.map((p, i) => parseList(p, FIELD_DEFS[i]))
  if (lists.some(l => !l.ok)) return null
  return {
    minutes: lists[0].set ?? fullSet(0, 59),
    hours: lists[1].set ?? fullSet(0, 23),
    doms: lists[2].set,          // '*' → null(未限制,vixie OR 语义的前提)
    months: lists[3].set ?? fullSet(1, 12),
    dows: lists[4].set,          // 同上;7 已归一为 0
  }
}

export function parseCron(expr) {
  if (typeof expr !== 'string') return null
  const s = expr.trim().toLowerCase()
  if (!s || s.includes('@') && !(s in SHORTCUTS)) return null
  return parseFields(s in SHORTCUTS ? SHORTCUTS[s] : s)
}

// === 结构描述:解析结果 → 语义描述符(供 i18n 文案化的固定形状) ===
const pad2 = n => String(n).padStart(2, '0')
const isFullArr = (arr, min, max) => arr.length === max - min + 1
const singleOf = arr => (arr.length === 1 ? arr[0] : undefined)
// 等差数列步长,且须覆盖到区间尾(*/5 与 5-55/5 同归「每 5 分钟」;5-10/5 只到半程 → complex)
const stepOf = (arr, max) => {
  if (arr.length < 2) return undefined
  const n = arr[1] - arr[0]
  if (n < 2) return undefined
  for (let i = 1; i < arr.length; i++) if (arr[i] - arr[i - 1] !== n) return undefined
  if (arr[arr.length - 1] + n <= max) return undefined
  return n
}

export function describeStructure(expr) {
  const spec = parseCron(expr)
  if (!spec) return null
  const mins = [...spec.minutes].sort((a, b) => a - b)
  const hrs = [...spec.hours].sort((a, b) => a - b)
  const mos = [...spec.months].sort((a, b) => a - b)
  const minsFull = isFullArr(mins, 0, 59)
  const hrsFull = isFullArr(hrs, 0, 23)
  const mosFull = isFullArr(mos, 1, 12)
  const mm = singleOf(mins)
  const hh = singleOf(hrs)
  const time = mm != null && hh != null ? `${pad2(hh)}:${pad2(mm)}` : null
  const dowsArr = spec.dows ? [...spec.dows].sort((a, b) => a - b) : null
  const domSingle = spec.doms && spec.doms.size === 1 ? [...spec.doms][0] : undefined
  const monSingle = !mosFull && mos.length === 1 ? mos[0] : undefined

  if (spec.doms && spec.dows) return { kind: 'complex' }   // dom∧dow 同限 = vixie OR,不勉强文案化
  if (minsFull && hrsFull && mosFull) return { kind: 'everyMinute' }
  const mn = stepOf(mins, 59)
  if (mn && hrsFull && mosFull) return { kind: 'minuteStep', n: mn }
  if (mm != null && hrsFull && mosFull) return { kind: 'hourlyAt', mm }
  const hn = stepOf(hrs, 23)
  if (mm != null && hn && mosFull) return { kind: 'hourStep', n: hn, mm }
  if (mm != null && hh != null && mosFull && !spec.doms && !dowsArr) return { kind: 'daily', time }
  if (mm != null && hh != null && !spec.doms && dowsArr) {
    if (dowsArr.length === 1) return { kind: 'weekly', day: dowsArr[0], time }
    return { kind: 'weeklyDays', days: dowsArr, time }
  }
  if (mm != null && hh != null && mosFull && domSingle != null) return { kind: 'monthly', dom: domSingle, time }
  if (mm != null && hh != null && monSingle != null && domSingle != null) return { kind: 'yearly', mon: monSingle, dom: domSingle, time }
  return { kind: 'complex' }
}

// === 人性化文案:描述符 → 本地化句子。键全字面量(i18n-check 静扫对象里的点串)。 ===
const TEXT_KEYS = {
  everyMinute: 'workload.cron.everyMinute',
  minuteStep: 'workload.cron.minuteStep',
  hourlyAt: 'workload.cron.hourlyAt',
  hourStep: 'workload.cron.hourStep',
  daily: 'workload.cron.daily',
  weekly: 'workload.cron.weekly',
  weeklyDays: 'workload.cron.weeklyDays',
  monthly: 'workload.cron.monthly',
  yearly: 'workload.cron.yearly',
}
const DAY_KEYS = ['workload.cron.day0', 'workload.cron.day1', 'workload.cron.day2', 'workload.cron.day3', 'workload.cron.day4', 'workload.cron.day5', 'workload.cron.day6']
const DAY_JOIN_KEY = 'workload.cron.dayJoin'

export function formatCronSchedule(d, t) {
  if (!d || d.kind === 'complex') return ''
  switch (d.kind) {
    case 'everyMinute': return t(TEXT_KEYS.everyMinute)
    case 'minuteStep': return t(TEXT_KEYS.minuteStep, { n: d.n })
    case 'hourlyAt': return t(TEXT_KEYS.hourlyAt, { mm: d.mm })
    case 'hourStep': return t(TEXT_KEYS.hourStep, { n: d.n, mm: d.mm })
    case 'daily': return t(TEXT_KEYS.daily, { time: d.time })
    case 'weekly': return t(TEXT_KEYS.weekly, { day: t(DAY_KEYS[d.day]), time: d.time })
    case 'weeklyDays': return t(TEXT_KEYS.weeklyDays, { days: d.days.map(x => t(DAY_KEYS[x])).join(t(DAY_JOIN_KEY)), time: d.time })
    case 'monthly': return t(TEXT_KEYS.monthly, { dom: d.dom, time: d.time })
    case 'yearly': return t(TEXT_KEYS.yearly, { mon: d.mon, dom: d.dom, time: d.time })
    default: return ''
  }
}

// === 下次运行预估 ===
// 日优先迭代:日匹配用纯 UTC 格里高利数学(DST 安全),Intl 墙钟投影只发生在命中日,
// 最坏情况(永不匹配)也只是 368 次廉价日检查。墙钟→epoch 两遍偏移法处理 DST 边界,
// 回投校验不符(春令时空洞)则跳过该时刻。timeZone 缺失/非法按 UTC——K8s 未设 spec.timeZone
// 时用 controller-manager 本地时,浏览器侧不可知,UTC 是最常见默认(卡片上仍标注实际时区)。
const HORIZON_DAYS = 368
const WEEKDAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const fmtCache = new Map()

function formatters(tz) {
  if (fmtCache.has(tz)) return fmtCache.get(tz)
  let wall, offset
  try {
    wall = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
  } catch {
    wall = formatters('UTC').wall
    offset = formatters('UTC').offset
    fmtCache.set(tz, { wall, offset })
    return { wall, offset }
  }
  fmtCache.set(tz, { wall, offset })
  return { wall, offset }
}

function zoneParts(ms, fmt) {
  const p = { y: 0, mo: 0, d: 0, h: 0, mi: 0, wd: 0 }
  for (const part of fmt.formatToParts(ms)) {
    if (part.type === 'year') p.y = Number(part.value)
    else if (part.type === 'month') p.mo = Number(part.value)
    else if (part.type === 'day') p.d = Number(part.value)
    else if (part.type === 'hour') p.h = Number(part.value)
    else if (part.type === 'minute') p.mi = Number(part.value)
    else if (part.type === 'weekday') p.wd = WEEKDAY_IDX[part.value] ?? 0
  }
  return p
}

function zoneOffsetMs(ms, fmt) {
  const name = fmt.formatToParts(ms).find(x => x.type === 'timeZoneName')?.value || 'GMT'
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name)
  if (!m) return 0   // 'GMT' / 未识别 → 0 偏移
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60000
}

function dayMatches(spec, dom, wd) {
  const domOk = spec.doms === null ? true : spec.doms.has(dom)
  const dowOk = spec.dows === null ? true : spec.dows.has(wd)
  if (spec.doms !== null && spec.dows !== null) return domOk || dowOk   // vixie OR
  return domOk && dowOk
}

export function nextRuns(expr, { from = new Date(), count = 3, timeZone = '' } = {}) {
  const spec = parseCron(expr)
  if (!spec || !Number.isInteger(count) || count <= 0) return []
  const tz = timeZone || 'UTC'
  const { wall, offset } = formatters(tz)
  const fromMs = from.getTime()
  const horizonMs = fromMs + HORIZON_DAYS * 86400000
  const f = zoneParts(fromMs, wall)
  const minutes = [...spec.minutes].sort((a, b) => a - b)
  const hours = [...spec.hours].sort((a, b) => a - b)
  const out = []
  let y = f.y, mo = f.mo, d = f.d
  for (let day = 0; day <= HORIZON_DAYS + 1; day++) {
    const dayUtcMs = Date.UTC(y, mo - 1, d)
    if (dayUtcMs > horizonMs + 86400000) break
    const wd = new Date(dayUtcMs).getUTCDay()
    if (spec.months.has(mo) && dayMatches(spec, d, wd)) {
      for (const h of hours) {
        for (const mi of minutes) {
          if (day === 0 && h * 60 + mi <= f.h * 60 + f.mi) continue
          const naive = Date.UTC(y, mo - 1, d, h, mi)
          const o1 = zoneOffsetMs(naive, offset)
          const epoch = naive - zoneOffsetMs(naive - o1, offset)
          const back = zoneParts(epoch, wall)   // 回投校验:DST 空洞(不存在的墙钟)必不符
          if (back.y !== y || back.mo !== mo || back.d !== d || back.h !== h || back.mi !== mi) continue
          if (epoch <= fromMs) continue
          if (epoch > horizonMs) return out
          out.push(new Date(epoch))
          if (out.length >= count) return out
        }
      }
    }
    const next = new Date(dayUtcMs + 86400000)
    y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate()
  }
  return out
}
