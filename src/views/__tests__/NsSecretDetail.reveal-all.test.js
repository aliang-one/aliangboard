import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

// 一键显示/隐藏全部密文：Data 卡片头部按钮，一键把所有掩码行(••••)全部解码显示，再点全部隐藏。
// 回归点：部分显示时按钮恒为「显示全部」(allRevealed 仅在全部已显示时为真)，空 data 不渲染按钮。

// 可变数据源：mock 是模块级单例，用 holder 让用例能换 secret 形态
const holder = {
  secret: {
    name: 'demo', namespace: 'default', type: 'Opaque', keys: 3, age: '1d',
    annotations: {}, labels: {},
    data: {
      username: btoa('alice'),
      password: btoa('s3cr3t'),
      token: btoa('tok-xyz'),
    },
  },
}

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c',
    setNamespace: vi.fn(),
    fetchSecret: vi.fn(() => Promise.resolve(holder.secret)),
    fetchWorkloads: vi.fn(() => Promise.resolve([])),
    findResourceReferences: vi.fn(() => []),
    generateYAML: vi.fn(() => 'apiVersion: v1\nkind: Secret'),
    decodeBase64: (v) => atob(v),
    updateSecret: vi.fn(),
    deleteSecret: vi.fn(() => Promise.resolve()),
  }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceDetail: () => ({ data: { value: holder.secret } }),
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('@/composables/useResourceApply', () => ({ useResourceApply: () => ({ applyYaml: vi.fn() }) }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'default', name: 'demo' } }),
  useRouter: () => ({ push: vi.fn() }),
}))
// 保留 vue-i18n 真实导出(useSecretTemplates→detectSecretTemplate 顶层链)，只覆写 useI18n
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useI18n: () => ({ t: (k) => k }) }
})

import NsSecretDetail from '../NsSecretDetail.vue'

function mountView() {
  return mount(NsSecretDetail, {
    global: {
      mocks: { $t: (k) => k },
      stubs: { Breadcrumbs: true, YamlEditor: true, Modal: true, ResourceReferences: true },
    },
  })
}

const MASK = '••••••••••••••••'
const findBtn = (w, key) => w.findAll('button').find(b => b.text().includes(key))

describe('NsSecretDetail 一键显示/隐藏全部密文', () => {
  beforeEach(() => {
    holder.secret = {
      name: 'demo', namespace: 'default', type: 'Opaque', keys: 3, age: '1d',
      annotations: {}, labels: {},
      data: { username: btoa('alice'), password: btoa('s3cr3t'), token: btoa('tok-xyz') },
    }
  })

  it('初始全部掩码；点「显示全部」后逐键解码可见，按钮翻为「隐藏全部」；再点全部回到掩码', async () => {
    const w = mountView()
    const revealAllBtn = findBtn(w, 'ns.secretDetail.revealAll')
    expect(revealAllBtn, '应有一键显示全部按钮').toBeTruthy()

    // 初始:三行值全部掩码
    expect(w.text()).toContain(MASK)
    expect(w.text()).not.toContain('alice')
    expect(w.text()).not.toContain('s3cr3t')

    await revealAllBtn.trigger('click')
    expect(w.text()).toContain('alice')
    expect(w.text()).toContain('s3cr3t')
    expect(w.text()).toContain('tok-xyz')
    expect(w.text()).not.toContain(MASK)
    // 按钮翻转为隐藏全部
    const hideAllBtn = findBtn(w, 'ns.secretDetail.hideAll')
    expect(hideAllBtn, '全显后按钮应为「隐藏全部」').toBeTruthy()

    await hideAllBtn.trigger('click')
    expect(w.text()).toContain(MASK)
    expect(w.text()).not.toContain('s3cr3t')
    w.unmount()
  })

  it('部分显示时按钮仍为「显示全部」，点击补齐而非清空', async () => {
    const w = mountView()
    // 先单独显示 username(per-row visibility 按钮，title 绑定 i18n key)
    const rowReveal = w.find('button[title="ns.secretDetail.reveal"]')
    expect(rowReveal.exists()).toBe(true)
    await rowReveal.trigger('click')
    expect(w.text()).toContain('alice')
    expect(w.text()).toContain(MASK) // 其余仍掩码

    const revealAllBtn = findBtn(w, 'ns.secretDetail.revealAll')
    expect(revealAllBtn, '部分显示时按钮应为「显示全部」').toBeTruthy()
    await revealAllBtn.trigger('click')
    // 补齐:全部可见,既有 alice 也在
    expect(w.text()).toContain('alice')
    expect(w.text()).toContain('s3cr3t')
    expect(w.text()).not.toContain(MASK)
    w.unmount()
  })

  it('空 data(无键)时不渲染一键按钮', async () => {
    holder.secret = { ...holder.secret, data: {}, keys: 0 }
    const w = mountView()
    expect(findBtn(w, 'ns.secretDetail.revealAll')).toBeUndefined()
    expect(findBtn(w, 'ns.secretDetail.hideAll')).toBeUndefined()
    w.unmount()
  })
})
