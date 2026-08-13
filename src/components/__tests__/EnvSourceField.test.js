import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import EnvSourceField from '../common/EnvSourceField.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ currentCluster: 'c1', fetchConfigMaps: vi.fn(), fetchSecrets: vi.fn() }),
}))
vi.mock('@/composables/useK8sQuery', async () => {
  const { ref } = await import('vue')
  const mk = items => ({ data: ref(items), isSuccess: ref(true) })
  return {
    useResourceList: ({ key }) => String(key).includes('secrets')
      ? mk([{ namespace: 'default', name: 'sec-a', data: { tok: 'x' } }])
      : mk([{ namespace: 'default', name: 'cm-a', data: { foo: '1', bar: '2' } }]),
  }
})

const mountField = (props = {}) => mount(EnvSourceField, {
  props: { kind: 'configmap', namespace: 'default', withKey: true, ...props },
})

test('② 用户键入资源名 → dataKey 被清空', async () => {
  const w = mountField({ name: 'cm-a', dataKey: 'foo' })
  await w.find('input').setValue('cm-b') // setValue 触发原生 input 事件
  expect(w.emitted('update:dataKey')?.at(-1)).toEqual([''])
})

test('② 程序化改 name(prop)→ dataKey 不清(复制 workload 回填场景)', async () => {
  const w = mountField({ name: 'cm-a', dataKey: 'foo' })
  await w.setProps({ name: 'cm-b' })
  expect(w.emitted('update:dataKey')).toBeUndefined()
})

test('② withKey=false(envFrom 场景)→ 键入不产生 update:dataKey', async () => {
  const w = mountField({ withKey: false, name: 'cm-a' })
  await w.find('input').setValue('cm-b')
  expect(w.emitted('update:dataKey')).toBeUndefined()
})

test('④ name 不在当前 ns 列表 → 显 nsMissing;匹配 → 不显', async () => {
  const miss = mountField({ name: 'ghost-cm', withKey: false })
  expect(miss.html()).toContain('envSource.nsMissing')
  const hit = mountField({ name: 'cm-a', withKey: false })
  expect(hit.html()).not.toContain('envSource.nsMissing')
})
