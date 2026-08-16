// useResourceApply 呈报语义:partial(主资源已落但有资源失败)时不得报 success——
// 2026-08-16 线上事故:applyResourceYaml 已返回 ok+partial+warning,但这里只看 res.ok
// 弹 success toast,把 warning 吞了(CreateFromYamlDialog/详情页 YAML 编辑全走此路径)。
import { test, expect, vi } from 'vitest'

const { applyResourceYaml, notify } = vi.hoisted(() => ({ applyResourceYaml: vi.fn(), notify: vi.fn() }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ applyResourceYaml }) }))
vi.mock('@/composables/useToast', () => ({ notify }))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (k, params) => (params ? `${k}:${JSON.stringify(params)}` : k) } } }))

import { useResourceApply } from '@/composables/useResourceApply'

test('部分成功:ok+partial → warning 呈报失败明细,不报 success', async () => {
  applyResourceYaml.mockResolvedValueOnce({ ok: true, partial: true, warning: 'Service/x: boom', kind: 'Deployment', name: 'd' })
  const { applyYaml } = useResourceApply()
  const res = await applyYaml('apiVersion: v1')
  expect(res.ok).toBe(true)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('Service/x: boom'))
  expect(notify).not.toHaveBeenCalledWith('success', expect.anything())
})

test('全成功 → success toast', async () => {
  applyResourceYaml.mockResolvedValueOnce({ ok: true, kind: 'Deployment', name: 'd' })
  const { applyYaml } = useResourceApply()
  await applyYaml('apiVersion: v1')
  expect(notify).toHaveBeenCalledWith('success', expect.anything())
})

test('失败 → error toast + 错误消息', async () => {
  applyResourceYaml.mockResolvedValueOnce({ ok: false, error: 'bad yaml' })
  const { applyYaml } = useResourceApply()
  await applyYaml('apiVersion: v1')
  expect(notify).toHaveBeenCalledWith('error', 'bad yaml')
})
