// ns allowlist 编辑器:下拉为主(候选=集群 ns−已选−绑定 ns,选中即 chip 且复位)、手输兜底
// (未选集群/拉取失败自动落,可双向切回)、手输校验回归。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const nsMock = vi.fn()
vi.mock('@/api/client', () => ({ adminApi: { clusters: { namespaces: (...a) => nsMock(...a) } } }))

import NsAllowlistEditor from '@/components/common/NsAllowlistEditor.vue'

beforeEach(() => { nsMock.mockReset() })

const mountEd = (props = {}) => mount(NsAllowlistEditor, {
  props: { boundNs: 'ns-bound', modelValue: [], clusterId: 'c1', ...props },
  global: { plugins: [i18n] },
})

test('下拉候选 = 集群 ns − 绑定 ns − 已选 chip', async () => {
  nsMock.mockResolvedValue({ namespaces: ['ns-bound', 'ns-picked', 'default', 'kube-system'] })
  const w = mountEd({ modelValue: ['ns-picked'] })
  await flushPromises()
  const opts = w.find('[data-testid="ns-select"]').findAll('option').filter(o => o.attributes('value'))
  expect(opts.map(o => o.attributes('value'))).toEqual(['default', 'kube-system'])
})

test('下拉选中 → 加 chip + select 复位(可连续添加)', async () => {
  nsMock.mockResolvedValue({ namespaces: ['default', 'kube-system'] })
  const w = mountEd()
  await flushPromises()
  const sel = w.find('[data-testid="ns-select"]')
  await sel.setValue('default')
  expect(w.emitted('update:modelValue')[0]).toEqual([['default']])
  expect(sel.element.value).toBe('')          // 复位待连续添加
  await w.setProps({ modelValue: ['default'] })
  await sel.setValue('kube-system')
  expect(w.emitted('update:modelValue')[1]).toEqual([['default', 'kube-system']])
})

test('拉取失败 → 自动手输态 + 提示;可切回下拉(显示提示)', async () => {
  nsMock.mockRejectedValue(new Error('boom'))
  const w = mountEd()
  await flushPromises()
  expect(w.find('[data-testid="ns-manual-input"]').exists()).toBe(true)
  expect(w.text()).toContain('boom')
  await w.find('[data-testid="ns-mode-toggle"]').trigger('click')   // 切回下拉
  expect(w.find('[data-testid="ns-select"]').exists()).toBe(true)
  expect(w.text()).toContain('boom')                                // 提示仍在
})

test('clusterId 空(mint 未选集群)→ 手输态,不发请求', () => {
  const w = mountEd({ clusterId: '' })
  expect(w.find('[data-testid="ns-manual-input"]').exists()).toBe(true)
  expect(nsMock).not.toHaveBeenCalled()
})

test('手输校验回归:非法名 errMsg、合法名加 chip', async () => {
  nsMock.mockResolvedValue({ namespaces: [] })
  const w = mountEd({ clusterId: '' })
  const inp = w.find('[data-testid="ns-manual-input"]')
  await inp.setValue('Bad_Ns'); await inp.trigger('keydown.enter')
  expect(w.text()).toContain(i18n.global.t('nsAllowlist.invalid'))
  expect(w.emitted('update:modelValue')).toBeUndefined()
  await inp.setValue('demo-ns'); await inp.trigger('keydown.enter')
  expect(w.emitted('update:modelValue')[0]).toEqual([['demo-ns']])
})
