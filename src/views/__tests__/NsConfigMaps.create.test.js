import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const invalidateQueries = vi.fn()

vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({
    data: { value: [] },
    isLoading: { value: false },
    isError: { value: false },
    error: { value: null },
    refetch: vi.fn(),
  }),
}))
vi.mock('@tanstack/vue-query', () => ({ useQueryClient: () => ({ invalidateQueries }) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'c1',
    setNamespace: vi.fn(),
    addConfigMap: vi.fn(),
    addSecret: vi.fn(),
    deleteConfigMap: vi.fn(),
    deleteSecret: vi.fn(),
    fetchConfigMaps: vi.fn(),
    fetchSecrets: vi.fn(),
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'ns1' } }),
  useRouter: () => ({ push: vi.fn() }),
}))

import NsConfigMaps from '@/views/NsConfigMaps.vue'
import NsSecrets from '@/views/NsSecrets.vue'

const ccmStub = {
  props: ['modelValue', 'kind', 'namespace'],
  emits: ['update:modelValue', 'created'],
  template:
    '<div v-if="modelValue" :data-testid="`ccm-stub-${kind}`" :data-ns="namespace" @click="$emit(\'created\')" />',
}

beforeEach(() => invalidateQueries.mockClear())

test('NsConfigMaps: 新建入口挂新 Modal;created → invalidate configmaps 查询;旧 createForm 已删', async () => {
  const w = mount(NsConfigMaps, {
    global: { plugins: [i18n], stubs: { CreateConfigResourceModal: ccmStub } },
  })
  expect(w.vm.createForm).toBeUndefined()
  await w.find('[data-testid="open-create"]').trigger('click')
  expect(w.find('[data-testid="ccm-stub-configmap"]').exists()).toBe(true)
  expect(w.find('[data-testid="ccm-stub-configmap"]').attributes('data-ns')).toBe('ns1')
  await w.find('[data-testid="ccm-stub-configmap"]').trigger('click')
  expect(invalidateQueries).toHaveBeenCalledTimes(1)
  const qk = invalidateQueries.mock.calls[0][0].queryKey
  expect(qk[0]).toBe('cluster')
  expect(qk[2]).toBe('configmaps')
})

test('NsSecrets: 新建入口挂新 Modal;created → invalidate secrets 查询;旧 createForm 已删', async () => {
  const w = mount(NsSecrets, {
    global: { plugins: [i18n], stubs: { CreateConfigResourceModal: ccmStub } },
  })
  expect(w.vm.createForm).toBeUndefined()
  await w.find('[data-testid="open-create"]').trigger('click')
  expect(w.find('[data-testid="ccm-stub-secret"]').exists()).toBe(true)
  expect(w.find('[data-testid="ccm-stub-secret"]').attributes('data-ns')).toBe('ns1')
  await w.find('[data-testid="ccm-stub-secret"]').trigger('click')
  expect(invalidateQueries).toHaveBeenCalledTimes(1)
  const qk = invalidateQueries.mock.calls[0][0].queryKey
  expect(qk[0]).toBe('cluster')
  expect(qk[2]).toBe('secrets')
})
