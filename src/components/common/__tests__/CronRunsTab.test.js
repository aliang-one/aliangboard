// CronRunsTab:CronJob 详情页运行记录 tab(2026-10-04)。
// 钉住:createdAt 降序、行点击 open(row)、空态(empty+emptyHint)、运行中 vs 已完成的时长。
import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'
import CronRunsTab from '../CronRunsTab.vue'

const t = i18n.global.t
const mountTab = (props = {}) => mount(CronRunsTab, { global: { plugins: [createPinia(), i18n] }, props })

const iso = (ms) => new Date(ms).toISOString()
const base = Date.now()

const fixtures = [
  { name: 'backup-older', type: 'Job', status: 'Succeeded', createdAt: iso(base - 3600e3), startTime: iso(base - 3600e3), completionTime: iso(base - 3600e3 + 133e3) },
  { name: 'backup-newest', type: 'Job', status: 'Failed', createdAt: iso(base - 60e3), startTime: iso(base - 60e3), completionTime: iso(base - 60e3 + 302e3) },
  { name: 'backup-middle', type: 'Job', status: 'Running', createdAt: iso(base - 600e3), startTime: iso(base - 90e3) },
]

describe('CronRunsTab', () => {
  test('按 createdAt 降序渲染(最新在前),列头齐备', () => {
    const w = mountTab({ rows: fixtures })
    const names = w.findAll('[data-testid="run-name"]').map(n => n.text())
    expect(names).toEqual(['backup-newest', 'backup-middle', 'backup-older'])
    for (const label of [t('workload.runs.thName'), t('workload.runs.thStatus'), t('workload.runs.thDuration'), t('workload.runs.thAge'), t('workload.runs.thCreated')]) {
      expect(w.text()).toContain(label)
    }
  })

  test('行点击 emit open(携带原始行)', async () => {
    const w = mountTab({ rows: fixtures })
    await w.findAll('[data-testid="run-name"]')[0].trigger('click')
    expect(w.emitted('open')).toBeTruthy()
    expect(w.emitted('open')[0][0]).toMatchObject({ name: 'backup-newest', status: 'Failed' })
  })

  test('空态:empty + emptyHint,无表行', () => {
    const w = mountTab({ rows: [] })
    expect(w.text()).toContain(t('workload.runs.empty'))
    expect(w.text()).toContain(t('workload.runs.emptyHint'))
    expect(w.findAll('[data-testid="run-name"]')).toHaveLength(0)
  })

  test('状态列渲染 StatusChip 词表(Running/Succeeded/Failed)', () => {
    const w = mountTab({ rows: fixtures })
    expect(w.text()).toContain('Running')
    expect(w.text()).toContain('Succeeded')
    expect(w.text()).toContain('Failed')
  })

  test('时长:已完成 = start→completion(2m);运行中 = start→now(1m);无 start = —', () => {
    const w = mountTab({ rows: fixtures })
    const durations = w.findAll('[data-testid="run-duration"]').map(d => d.text())
    expect(durations).toEqual(['5m', '1m', '2m'])   // newest(302s=5m) / running(90s=1m) / older(133s=2m)
    const none = mountTab({ rows: [{ name: 'x', type: 'Job', status: 'Pending', createdAt: iso(base - 5e3) }] })
    expect(none.find('[data-testid="run-duration"]').text()).toBe('—')
  })
})
