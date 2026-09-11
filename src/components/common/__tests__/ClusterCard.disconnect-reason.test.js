// 断连归因徽标(2026-09-06 证书可观测):仅 Disconnected + 有归因值时渲染;
// unknown-insecure/error 无行动价值不出;Healthy 行不受影响。
// 2026-09-10 issue#8 追加:卡片点击换连接失败(open catch)留原地不推 /cluster。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { pushMock, switchMock } = vi.hoisted(() => ({ pushMock: vi.fn(), switchMock: vi.fn(async () => {}) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ cluster: null, currentCluster: 'x', switchCluster: switchMock }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))
import ClusterCard from '../ClusterCard.vue'

const mountCard = (cluster) => mount(ClusterCard, { props: { cluster, active: false, showRemove: false }, global: { plugins: [i18n] } })
const C = (over = {}) => ({ id: 'c1', name: 'prod', apiServer: 'https://x', version: 'v1.30', status: 'Disconnected', ...over })
const chipText = (w) => { const el = w.find('.bg-error-container\\/30.text-error'); return el.exists() ? el.text() : null }

describe('ClusterCard 断连归因徽标', () => {
  beforeEach(() => { pushMock.mockClear(); switchMock.mockClear() })
  it('Disconnected + ca-mismatch → 徽标显示翻译文案', () => {
    const w = mountCard(C({ disconnectReason: 'ca-mismatch' }))
    expect(chipText(w)).toContain(i18n.global.t('component.clusterCard.reasonCaMismatch'))
    w.unmount()
  })
  it('其余归因值各自映射;unknown-insecure/error/缺字段不出徽标', () => {
    for (const [reason, key] of [['cert-expired', 'reasonCertExpired'], ['hostname-mismatch', 'reasonHostnameMismatch'], ['unreachable', 'reasonUnreachable'], ['tls-ok', 'reasonTlsOk']]) {
      const w = mountCard(C({ disconnectReason: reason }))
      expect(chipText(w), reason).toContain(i18n.global.t(`component.clusterCard.${key}`))
      w.unmount()
    }
    for (const over of [{ disconnectReason: 'unknown-insecure' }, { disconnectReason: 'error' }, {}]) {
      const w = mountCard(C(over))
      expect(chipText(w), JSON.stringify(over)).toBeNull()
      w.unmount()
    }
  })
  it('Healthy 行即使带归因字段也不出徽标', () => {
    const w = mountCard(C({ status: 'Healthy', disconnectReason: 'ca-mismatch' }))
    expect(chipText(w)).toBeNull()
    w.unmount()
  })
})

describe('ClusterCard 换连接失败留原地(2026-09-10 issue#8)', () => {
  beforeEach(() => { pushMock.mockClear(); switchMock.mockReset(); switchMock.mockImplementation(async () => {}) })
  it('switchCluster 拒绝:open 吞掉异常,不 router.push(无未捕获拒绝)', async () => {
    switchMock.mockRejectedValueOnce(new Error('switch failed'))
    // store.cluster=null → store.cluster?.apiServer=undefined ≠ 卡片 apiServer → 走切换分支
    const w = mountCard(C({ apiServer: 'https://other', status: 'Healthy' }))
    await w.find('[data-test="cluster-card"]').trigger('click')
    await flushPromises()
    expect(switchMock).toHaveBeenCalledWith('c1')
    expect(pushMock).not.toHaveBeenCalled()   // 失败留原地
    w.unmount()
  })
})
