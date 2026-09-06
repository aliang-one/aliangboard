// 两段式渲染契约(2026-09-06 证书可观测):banner 各态 / days 分级 pill / 过滤 chips /
// forbidden 降级提示。数据经 useK8sQuery mock 注入(view 只吃报告形状)。
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const h = await vi.hoisted(async () => {
  const { ref: r } = await import('vue')
  return { certsData: r(null), certsError: r(null) }
})
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: h.certsData, error: h.certsError, isLoading: ref(false), isFetching: ref(false), refetch: vi.fn(async () => { }) }),
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', fetchClusterCerts: vi.fn(async () => null) }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: vi.fn() }) }))
import ClusterCerts from '../ClusterCerts.vue'

const REPORT = {
  connection: { apiServer: 'https://a', trust: 'ca-mismatch', reachable: true, reasonCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', reason: 'unable to verify', peerChain: [{ subject: 'CN=api', issuer: 'CN=ca', validFrom: 1, validTo: 2e12, daysLeft: 15, sans: ['DNS:a'], fingerprint256: 'F1', isCA: false }] },
  caAnchors: [{ subject: 'CN=ca', issuer: 'CN=ca', validFrom: 1, validTo: 3e12, daysLeft: 40, sans: [], fingerprint256: 'F2', isCA: true }],
  secrets: {
    items: [
      { name: 'tls-web', namespace: 'api', cn: 'CN=web', issuer: 'CN=letsencrypt', sans: ['DNS:web'], expires: 2e12, daysLeft: 12, fingerprint256: 'A', chainCount: 2, managedBy: 'cert-manager', certManager: { ready: true, renewalTime: '2026-10-01T00:00:00Z' } },
      { name: 'tls-old', namespace: 'default', cn: 'CN=old', issuer: 'CN=self', sans: [], expires: 1e12, daysLeft: -5, fingerprint256: 'B', chainCount: 1, managedBy: null, certManager: null },
      { name: 'tls-far', namespace: 'default', cn: 'CN=far', issuer: 'CN=self', sans: [], expires: 9e12, daysLeft: 300, fingerprint256: 'C', chainCount: 1, managedBy: null, certManager: null },
    ],
    error: null,
  },
  certManagerInstalled: true,
  fetchedAt: 1,
}

function mountView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(ClusterCerts, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
}

describe('ClusterCerts', () => {
  it('ca-mismatch:banner 文案在场;A 段卡与 CA 锚渲染;B 段数据行可见', async () => {
    h.certsData.value = REPORT
    const w = mountView(); await flushPromises()
    expect(w.find('[data-testid="certs-banner"]').exists()).toBe(true)
    expect(w.find('[data-testid="certs-banner"]').text()).toContain(i18n.global.t('certs.bannerCaMismatch'))
    expect(w.find('[data-testid="certs-apiserver-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="certs-ca-anchors"]').exists()).toBe(true)
    expect(w.text()).toContain('tls-web')
    w.unmount()
  })

  it('days 分级 pill:12d→tertiary(warn);-5d→error(expired);过期文案', async () => {
    h.certsData.value = REPORT
    const w = mountView(); await flushPromises()
    const cls = w.findAll('[data-testid="cert-days"]').map(p => p.classes().join(' '))
    expect(cls.some(c => c.includes('text-tertiary-container'))).toBe(true)
    expect(cls.some(c => c.includes('text-error'))).toBe(true)
    expect(w.text()).toContain(i18n.global.t('certs.expiredDays', { n: 5 }))
    w.unmount()
  })

  it('过滤 chips:默认全部 3 行;30 天内不含 far;已过期只剩 old', async () => {
    h.certsData.value = REPORT
    const w = mountView(); await flushPromises()
    expect(w.text()).toContain('tls-far')
    await w.find('[data-testid="certs-filter-expiring"]').trigger('click'); await flushPromises()
    expect(w.text()).not.toContain('tls-far')
    expect(w.text()).toContain('tls-web')
    expect(w.text()).toContain('tls-old') // 已过期也属于「30 天内」语义(daysLeft<0 ≤30)
    await w.find('[data-testid="certs-filter-expired"]').trigger('click'); await flushPromises()
    expect(w.text()).toContain('tls-old')
    expect(w.text()).not.toContain('tls-web')
    w.unmount()
  })

  it('forbidden:B 段提示条,A 段照常', async () => {
    h.certsData.value = { ...REPORT, secrets: { items: [], error: 'forbidden' } }
    const w = mountView(); await flushPromises()
    expect(w.find('[data-testid="certs-secrets-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="certs-apiserver-card"]').exists()).toBe(true)
    w.unmount()
  })

  it('trusted:无 banner、trusted 徽标在场;unverified:提示文案', async () => {
    h.certsData.value = { ...REPORT, connection: { ...REPORT.connection, trust: 'trusted' } }
    const w = mountView(); await flushPromises()
    expect(w.find('[data-testid="certs-banner"]').exists()).toBe(false)
    expect(w.find('[data-testid="certs-trusted"]').text()).toContain(i18n.global.t('certs.trusted'))
    w.unmount()
    h.certsData.value = { ...REPORT, connection: { ...REPORT.connection, trust: 'unverified' } }
    const w2 = mountView(); await flushPromises()
    expect(w2.find('[data-testid="certs-banner"]').text()).toContain(i18n.global.t('certs.insecureHint'))
    w2.unmount()
  })

  it('取数失败(ns 门 403/上游 5xx):error 态横幅,不再静默空白页', async () => {
    h.certsError.value = new Error('403 Forbidden')
    const w = mountView(); await flushPromises()
    expect(w.find('[data-testid="certs-load-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="certs-apiserver-card"]').exists()).toBe(false)
    w.unmount()
  })
})
