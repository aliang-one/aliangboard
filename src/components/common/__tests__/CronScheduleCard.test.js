// CronScheduleCard:CronJob 详情页概览的调度卡片(2026-10-04)。
// 钉住:人性化描述、暂停态隐藏预测、不可解析回退、时区/并发 chip、空时间兜底。
import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import CronScheduleCard from '../CronScheduleCard.vue'

const NOW = new Date('2026-10-04T08:00:00Z')
const t = i18n.global.t
const mountCard = (props = {}) => mount(CronScheduleCard, { global: { plugins: [i18n] }, props })

describe('CronScheduleCard', () => {
  test('*/5:人性化描述 + 接下来 3 次运行', () => {
    const w = mountCard({ schedule: '*/5 * * * *', now: NOW })
    expect(w.text()).toContain('每 5 分钟执行一次')
    expect(w.text()).toContain(t('workload.cron.nextRuns', { n: 3 }))
    expect(w.findAll('[data-testid="cron-next-run"]')).toHaveLength(3)
    expect(w.text()).not.toContain(t('workload.cron.noUpcoming'))
  })

  test('暂停态:已暂停徽标 + 整块隐藏下次运行预测(节奏描述保留)', () => {
    const w = mountCard({ schedule: '*/5 * * * *', suspended: true, now: NOW })
    expect(w.text()).toContain(t('workload.suspendedChip'))
    expect(w.text()).toContain('每 5 分钟执行一次')
    expect(w.text()).not.toContain(t('workload.cron.nextRuns', { n: 3 }))
    expect(w.findAll('[data-testid="cron-next-run"]')).toHaveLength(0)
  })

  test('不可解析表达式:原文 + unparsable 提示,不炸不预测', () => {
    const w = mountCard({ schedule: 'not a cron', now: NOW })
    expect(w.text()).toContain('not a cron')
    expect(w.text()).toContain(t('workload.cron.unparsable'))
    expect(w.findAll('[data-testid="cron-next-run"]')).toHaveLength(0)
  })

  test('complex 表达式:原文 + complexHint 次行', () => {
    const w = mountCard({ schedule: '0 0 13 1,3 *', now: NOW })
    expect(w.text()).toContain(t('workload.cron.complexHint'))
  })

  test('空 lastSchedule/lastSuccess → 从未;时区 chip 与按该时区格式化的运行时刻', () => {
    const w = mountCard({ schedule: '*/5 * * * *', timeZone: 'Asia/Shanghai', now: NOW })
    expect(w.text()).toContain(t('workload.cron.never'))   // 两条「从未」(调度+成功)
    expect(w.text()).toContain('Asia/Shanghai')
    // 08:05Z → 墙钟 16:05 CST(格式化走 props.timeZone,确定性)
    expect(w.text()).toContain('16:05')
    expect(w.text()).toContain('16:10')
  })

  test('上次调度/上次成功渲染相对年龄(ageOf 桶)', () => {
    const w = mountCard({
      schedule: '*/5 * * * *', now: NOW,
      lastScheduleTime: new Date(Date.now() - 190 * 1000).toISOString(),
      lastSuccessfulTime: new Date(Date.now() - 190 * 1000).toISOString(),
    })
    expect(w.text()).toContain('3m')
    expect(w.text()).not.toContain(t('workload.cron.never'))
  })

  test('并发策略 chip:Replace 文案 + 原文 title', () => {
    const w = mountCard({ schedule: '*/5 * * * *', concurrencyPolicy: 'Replace', now: NOW })
    expect(w.text()).toContain(t('workload.cron.concurrencyReplace'))
    const chip = w.findAll('span').find(s => s.text() === t('workload.cron.concurrencyReplace'))
    expect(chip.attributes('title')).toContain('Replace')
  })
})
