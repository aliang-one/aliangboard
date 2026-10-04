// cron 表达式工具(零依赖自研):解析 / 结构描述 / 人性化文案 / 下次运行时间。
// CronJob 详情页调度卡片消费;K8s CronJob schedule = 标准 5 字段 vixie cron + @快捷。
import { describe, test, expect } from 'vitest'
import { parseCron, describeStructure, formatCronSchedule, nextRuns } from './cron'
import { i18n } from '@/i18n'

const t = i18n.global.t
const at = s => new Date(s)

describe('parseCron', () => {
  test('标准 5 字段解析为值集', () => {
    const s = parseCron('*/5 8-10 1,15 * mon-fri')
    expect(s).toBeTruthy()
    expect([...s.minutes].sort((a, b) => a - b)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    expect([...s.hours]).toEqual([8, 9, 10])
    expect([...s.months]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect([...s.doms]).toEqual([1, 15])
    expect([...s.dows]).toEqual([1, 2, 3, 4, 5])
  })

  test('通配字段 doms/dows 为 null(未限制),区分满集——vixie OR 语义前提', () => {
    const s = parseCron('0 0 * * *')
    expect(s.doms).toBeNull()
    expect(s.dows).toBeNull()
    expect(s.minutes.has(0)).toBe(true)
    // dom 受限 + dow 通配
    const s2 = parseCron('0 0 1 * *')
    expect(s2.doms).toEqual(new Set([1]))
    expect(s2.dows).toBeNull()
  })

  test('dow:名字、7≡0、回绕区间(fri-mon → 5,6,0,1)', () => {
    expect([...parseCron('0 0 * * SUN').dows]).toEqual([0])
    expect([...parseCron('0 0 * * 7').dows]).toEqual([0])
    expect([...parseCron('0 0 * * fri-mon').dows]).toEqual([5, 6, 0, 1])
  })

  test('大小写不敏感(@/名字)', () => {
    expect(parseCron('@DAILY')).toEqual(parseCron('0 0 * * *'))
    expect([...parseCron('0 0 * * Mon').dows]).toEqual([1])
  })

  test('@快捷方式归一', () => {
    expect(parseCron('@hourly')).toEqual(parseCron('0 * * * *'))
    expect(parseCron('@weekly')).toEqual(parseCron('0 0 * * 0'))
    expect(parseCron('@monthly')).toEqual(parseCron('0 0 1 * *'))
    expect(parseCron('@yearly')).toEqual(parseCron('0 0 1 1 *'))
    expect(parseCron('@annually')).toEqual(parseCron('0 0 1 1 *'))
    expect(parseCron('@midnight')).toEqual(parseCron('0 0 * * *'))
  })

  test('a-b/n 与 a/n(vixie a..max/n)', () => {
    expect([...parseCron('5-55/10 * * * *').minutes]).toEqual([5, 15, 25, 35, 45, 55])
    expect([...parseCron('20/15 * * * *').minutes]).toEqual([20, 35, 50])
  })

  test('非法输入一律 null', () => {
    for (const bad of ['garbage', '61 * * * *', '* * * *', '* * * * * *', '@nope', '0 0 31 13 *', 'a * * * *', '0 0 0 * *', '*/0 * * * *', '']) {
      expect(parseCron(bad)).toBeNull()
    }
  })
})

describe('describeStructure', () => {
  const kindOf = expr => { const d = describeStructure(expr); return d && d.kind }

  test('基础分类表', () => {
    expect(kindOf('* * * * *')).toBe('everyMinute')
    expect(kindOf('*/5 * * * *')).toBe('minuteStep')
    expect(kindOf('5-55/5 * * * *')).toBe('minuteStep')   // a-b/n 全覆盖与 */n 同归
    expect(kindOf('30 * * * *')).toBe('hourlyAt')
    expect(kindOf('15 */6 * * *')).toBe('hourStep')
    expect(kindOf('30 8 * * *')).toBe('daily')
    expect(kindOf('30 8 * * 1')).toBe('weekly')
    expect(kindOf('30 8 * * mon-fri')).toBe('weeklyDays')
    expect(kindOf('30 8 1 * *')).toBe('monthly')
    expect(kindOf('0 0 29 2 *')).toBe('yearly')
  })

  test('描述符参数', () => {
    expect(describeStructure('*/5 * * * *')).toEqual({ kind: 'minuteStep', n: 5 })
    expect(describeStructure('30 * * * *')).toEqual({ kind: 'hourlyAt', mm: 30 })
    expect(describeStructure('15 */6 * * *')).toEqual({ kind: 'hourStep', n: 6, mm: 15 })
    expect(describeStructure('30 8 * * *')).toEqual({ kind: 'daily', time: '08:30' })
    expect(describeStructure('30 8 * * 1')).toEqual({ kind: 'weekly', day: 1, time: '08:30' })
    expect(describeStructure('30 8 * * 1,3')).toEqual({ kind: 'weeklyDays', days: [1, 3], time: '08:30' })
    expect(describeStructure('30 8 1 * *')).toEqual({ kind: 'monthly', dom: 1, time: '08:30' })
    expect(describeStructure('0 0 29 2 *')).toEqual({ kind: 'yearly', mon: 2, dom: 29, time: '00:00' })
    expect(describeStructure('30 8 * * 7')).toEqual({ kind: 'weekly', day: 0, time: '08:30' })   // 7≡周日
  })

  test('复杂形态归 complex', () => {
    for (const c of ['0,30 8 * * *', '0 0 13 * 1', '5-10/5 * * * *', '0 8 1,15 * *', '0 8 * 2 *']) {
      expect(kindOf(c)).toBe('complex')
    }
  })

  test('列表形态若构成等差且覆盖到区间尾则归步长(0 8,20 = 每 12 小时,跨日等差)', () => {
    expect(describeStructure('0 8,20 * * *')).toEqual({ kind: 'hourStep', n: 12, mm: 0 })
  })

  test('@快捷方式描述符', () => {
    expect(describeStructure('@daily')).toEqual({ kind: 'daily', time: '00:00' })
    expect(describeStructure('@hourly')).toEqual({ kind: 'hourlyAt', mm: 0 })
    expect(describeStructure('@weekly')).toEqual({ kind: 'weekly', day: 0, time: '00:00' })
    expect(describeStructure('@yearly')).toEqual({ kind: 'yearly', mon: 1, dom: 1, time: '00:00' })
  })

  test('不可解析返回 null', () => {
    expect(describeStructure('not a cron')).toBeNull()
    expect(describeStructure('')).toBeNull()
  })
})

describe('formatCronSchedule', () => {
  test('zh 真文案(默认 locale)', () => {
    expect(formatCronSchedule(describeStructure('*/5 * * * *'), t)).toBe('每 5 分钟执行一次')
    expect(formatCronSchedule(describeStructure('30 8 * * *'), t)).toBe('每天 08:30 执行')
    expect(formatCronSchedule(describeStructure('30 8 * * 1'), t)).toBe('每周一 08:30 执行')
    expect(formatCronSchedule(describeStructure('30 8 * * mon-fri'), t)).toBe('每周一、二、三、四、五 08:30 执行')
    expect(formatCronSchedule(describeStructure('30 8 1 * *'), t)).toBe('每月 1 号 08:30 执行')
    expect(formatCronSchedule(describeStructure('0 0 29 2 *'), t)).toBe('每年 2 月 29 日 00:00 执行')
    expect(formatCronSchedule(describeStructure('* * * * *'), t)).toBe('每分钟执行一次')
    expect(formatCronSchedule(describeStructure('15 */6 * * *'), t)).toBe('每 6 小时执行一次(第 15 分)')
    expect(formatCronSchedule(describeStructure('30 * * * *'), t)).toBe('每小时第 30 分执行')
  })

  test('complex 返回空串(宿主展示原文 + complexHint)', () => {
    expect(formatCronSchedule(describeStructure('0,30 8 * * *'), t)).toBe('')
    expect(formatCronSchedule(null, t)).toBe('')
  })

  test('键/参数契约(假 t,防 i18n 键漂移)', () => {
    const fake = (k, p) => k + (p ? '|' + JSON.stringify(p) : '')
    expect(formatCronSchedule({ kind: 'minuteStep', n: 5 }, fake)).toBe('workload.cron.minuteStep|{"n":5}')
    expect(formatCronSchedule({ kind: 'daily', time: '08:30' }, fake)).toBe('workload.cron.daily|{"time":"08:30"}')
    expect(formatCronSchedule({ kind: 'weekly', day: 1, time: '08:30' }, fake)).toBe('workload.cron.weekly|{"day":"workload.cron.day1","time":"08:30"}')
    expect(formatCronSchedule({ kind: 'weeklyDays', days: [1, 3], time: '08:30' }, fake))
      .toBe('workload.cron.weeklyDays|{"days":"workload.cron.day1workload.cron.dayJoinworkload.cron.day3","time":"08:30"}')
  })
})

describe('nextRuns', () => {
  test('*/5:严格大于 from,间隔 5 分钟', () => {
    const runs = nextRuns('*/5 * * * *', { from: at('2026-10-04T10:07:30Z'), count: 3 })
    expect(runs.map(d => d.toISOString())).toEqual([
      '2026-10-04T10:10:00.000Z', '2026-10-04T10:15:00.000Z', '2026-10-04T10:20:00.000Z',
    ])
  })

  test('每日 03:00 跨日', () => {
    const runs = nextRuns('0 3 * * *', { from: at('2026-10-04T10:00:00Z'), count: 1 })
    expect(runs[0].toISOString()).toBe('2026-10-05T03:00:00.000Z')
  })

  test('dow-only:下一个周一', () => {
    const runs = nextRuns('0 3 * * 1', { from: at('2026-10-04T10:00:00Z'), count: 1 })   // 10-04 是周日
    expect(runs[0].toISOString()).toBe('2026-10-05T03:00:00.000Z')
  })

  test('vixie dom/dow OR:两者都受限时命中并集(周一序列 ∪ 每月 1 号)', () => {
    const runs = nextRuns('0 0 1 * 1', { from: at('2026-10-04T00:00:00Z'), count: 6 })
    expect(runs.map(d => d.toISOString().slice(0, 10))).toEqual([
      '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26',   // 周一
      '2026-11-01',                                            // 1 号(OR 命中,非周一)
      '2026-11-02',
    ])
  })

  test('时区投影:同一表达式 Asia/Shanghai 与 UTC 相差 8 小时', () => {
    const utc = nextRuns('0 9 * * *', { from: at('2026-10-04T00:00:00Z'), count: 1, timeZone: 'UTC' })
    const cst = nextRuns('0 9 * * *', { from: at('2026-10-04T00:00:00Z'), count: 1, timeZone: 'Asia/Shanghai' })
    expect(utc[0].toISOString()).toBe('2026-10-04T09:00:00.000Z')
    expect(cst[0].toISOString()).toBe('2026-10-04T01:00:00.000Z')   // 墙钟 09:00 CST = 01:00Z
  })

  test('非法时区回退 UTC(不抛)', () => {
    const runs = nextRuns('0 9 * * *', { from: at('2026-10-04T00:00:00Z'), count: 1, timeZone: 'Not/AZone' })
    expect(runs[0].toISOString()).toBe('2026-10-04T09:00:00.000Z')
  })

  test('地平线:下一个 2/29 超 368 天 → 空', () => {
    expect(nextRuns('0 0 29 2 *', { from: at('2026-03-01T00:00:00Z'), count: 1 })).toEqual([])   // 下次 2028-02-29
  })

  test('永不匹配 → 空', () => {
    expect(nextRuns('0 0 31 4 *', { from: at('2026-10-04T00:00:00Z'), count: 3 })).toEqual([])
  })

  test('DST 空洞:春令时不存在的墙钟时刻被跳过(不产出错误时刻)', () => {
    // 2026-03-08 02:30 America/New_York 不存在(2:00→3:00);下一次合法出现(2027-03-08)超地平线
    const runs = nextRuns('30 2 8 3 *', { from: at('2026-01-01T00:00:00Z'), count: 2, timeZone: 'America/New_York' })
    expect(runs).toEqual([])
  })

  test('不可解析 → 空', () => {
    expect(nextRuns('garbage', { from: at('2026-10-04T00:00:00Z') })).toEqual([])
  })

  test('@daily 快捷方式', () => {
    const runs = nextRuns('@daily', { from: at('2026-10-04T10:00:00Z'), count: 1 })
    expect(runs[0].toISOString()).toBe('2026-10-05T00:00:00.000Z')
  })
})
