// 断连归因徽标(2026-09-06 证书可观测):仅 Disconnected + 有归因值时渲染;
// unknown-insecure/error 无行动价值不出;Healthy 行不受影响。
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ cluster: null, currentCluster: 'x', switchCluster: vi.fn(async () => {}) }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
import ClusterCard from '../ClusterCard.vue'

const mountCard = (cluster) => mount(ClusterCard, { props: { cluster, active: false, showRemove: false }, global: { plugins: [i18n] } })
const C = (over = {}) => ({ id: 'c1', name: 'prod', apiServer: 'https://x', version: 'v1.30', status: 'Disconnected', ...over })
const chipText = (w) => { const el = w.find('.bg-error-container\\/30.text-error'); return el.exists() ? el.text() : null }

describe('ClusterCard 断连归因徽标', () => {
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
