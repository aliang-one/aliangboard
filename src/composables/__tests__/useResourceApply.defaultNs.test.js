// defaultNs 透传链第二跳:useResourceApply → store(2026-08-28;C2 审查:此跳断裂则功能整体静默失效)。
import { test, expect, vi } from 'vitest'

const applyResourceYaml = vi.fn(async () => ({ ok: true, kind: 'Service', name: 's1' }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ applyResourceYaml: (...a) => applyResourceYaml(...a) }),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useResourceApply } from '@/composables/useResourceApply'

test('applyYaml 透传 opts.defaultNs 给 store.applyResourceYaml', async () => {
  const { applyYaml } = useResourceApply()
  await applyYaml('a: 1', { defaultNs: 'demo' })
  expect(applyResourceYaml).toHaveBeenCalledWith('a: 1', { defaultNs: 'demo' })
})

test('不传 opts:第二参为 {}(现行为)', async () => {
  const { applyYaml } = useResourceApply()
  await applyYaml('a: 1')
  expect(applyResourceYaml).toHaveBeenLastCalledWith('a: 1', {})
})
