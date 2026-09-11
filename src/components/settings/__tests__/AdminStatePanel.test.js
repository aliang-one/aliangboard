import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AdminStatePanel from '../AdminStatePanel.vue'

const mockGet = vi.fn()
vi.mock('@/api/client', () => ({ adminApi: { state: { get: (...a) => mockGet(...a) } } }))
// i18n 直通(组件用 useI18n;测试环境无插件,局部 stub)
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))

describe('AdminStatePanel', () => {
  beforeEach(() => { mockGet.mockReset() })

  it('挂载即拉取并按域分组渲染 store 与 sweep', async () => {
    mockGet.mockResolvedValue({
      ts: 1,
      stores: [
        { name: 'mfaTickets', domain: 'auth', primitive: 'ttl', entries: 2 },
        { name: 'sshTerminals', domain: 'ssh', primitive: 'registered', meta_entries: 1 },
      ],
      sweeps: [{ name: 'terminalSweep', cadenceMs: 60000, lastRunAt: 5, lastError: null, runs: 9 }],
    })
    const w = mount(AdminStatePanel)
    await flushPromises()
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('mfaTickets')
    expect(w.text()).toContain('sshTerminals')
    expect(w.text()).toContain('terminalSweep')
  })

  it('sweep 有 lastError 时渲染错误徽标', async () => {
    mockGet.mockResolvedValue({ ts: 1, stores: [], sweeps: [{ name: 'x', cadenceMs: 1, lastRunAt: 0, lastError: 'boom', runs: 1 }] })
    const w = mount(AdminStatePanel)
    await flushPromises()
    expect(w.text()).toContain('boom')
  })
})
