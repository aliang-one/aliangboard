// TagInput 建议下拉「Teleport body + fixed」契约(2026-09-01 下拉遮挡排查):
// 消费方 DeployApp:969(向导根 overflow-hidden)与 NsWorkloadDetail:2371(编辑壳 Modal
// overflow-y-auto)的 overflow 祖先会把就地 absolute 面板裁切——面板必须传送出裁切链。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TagInput from '../TagInput.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ currentCluster: 'c1', fetchWorkloads: vi.fn() }),
}))
vi.mock('@/composables/useK8sQuery', async () => {
  const { ref } = await import('vue')
  return { useResourceList: () => ({ data: ref([]), isSuccess: ref(true) }) }
})
vi.mock('@/composables/useTagHistory', () => ({
  syncTagHistory: vi.fn(),
  getTagSuggestions: () => [{ tag: 'team-a', count: 2 }],
}))

beforeEach(() => { document.body.innerHTML = '' })

const mountTag = (props = {}) => mount(TagInput, {
  props: { modelValue: '', namespace: 'default', max: 3, ...props },
  attachTo: document.body,
})
const bodyPanel = () => document.body.querySelector('[data-testid="tag-suggest-panel"]')

test('建议面板 Teleport 到 body + fixed + Z.popover(脱离 overflow 裁切链)', async () => {
  const w = mountTag()
  await w.find('input').trigger('focus')
  await nextTick(); await nextTick()
  const panel = bodyPanel()
  expect(panel, '面板应传送至 document.body').toBeTruthy()
  expect(w.element.contains(panel)).toBe(false)
  expect(panel.style.position).toBe('fixed')
  expect(panel.style.zIndex).toBe('110')
})

test('失焦后建议面板收起(body 不残留)', async () => {
  const w = mountTag()
  await w.find('input').trigger('focus')
  await nextTick(); await nextTick()
  expect(bodyPanel()).toBeTruthy()
  await w.find('input').trigger('blur')
  // onBlur 延迟 150ms 关闭(保 mousedown 点选先于失焦的既有语义)
  await new Promise(r => setTimeout(r, 170))
  await nextTick(); await nextTick()
  expect(bodyPanel()).toBeNull()
})
