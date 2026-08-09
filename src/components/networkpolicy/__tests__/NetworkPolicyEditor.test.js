import { test, expect, vi, afterEach } from 'vitest'
import { mount, DOMWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const applyYamlMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useResourceApply', () => ({
  useResourceApply: () => ({ applyYaml: applyYamlMock }),
}))

import NetworkPolicyEditor from '@/components/networkpolicy/NetworkPolicyEditor.vue'

// Modal 把内容 teleport 到 document.body,wrapper.find() 不遍历 teleport 后的 DOM。
// 用 body.querySelector 定位元素后用 DOMWrapper 包裹(保留 .trigger/.element 等 API),
// 断言内容不变。每次 mount 后需重新查询(teleport DOM 随挂载/卸载增删)。
let wrapper = null
afterEach(() => { if (wrapper) { wrapper.unmount(); wrapper = null } })

function mountIt(props = {}) {
  wrapper = mount(NetworkPolicyEditor, {
    props: { modelValue: true, namespace: 'default', ...props },
    global: { plugins: [createPinia(), i18n] },
  })
  return wrapper
}
function el(selector) { return new DOMWrapper(document.body.querySelector(selector)) }

test('默认放行起步:两方向显示 allowAll 标签,Create 可点', () => {
  const w = mountIs()
  expect(document.body.textContent).toContain(i18n.global.t('ns.netpolCreate.consequenceAllowAll'))
})

test('删光 ingress 规则 → denyAll,Create 禁用;勾确认后可点', async () => {
  const w = mountIs()
  // 先填一个合法名字,隔离 denyAll 守卫(nameValid=true 后,disabled 只受 denyAll/ack 影响)
  await el('input[data-test="name-input"]').setValue('my-policy')
  // 删除唯一 ingress 规则
  await el('button[data-test="rm-ingress-rule-0"]').trigger('click')
  expect(document.body.textContent).toContain(i18n.global.t('ns.netpolCreate.consequenceDenyAll'))
  const createBtn = el('button[data-test="create"]')
  expect(createBtn.attributes('disabled')).toBeDefined()
  await el('input[data-test="ack-denyall"]').setValue(true)
  expect(el('button[data-test="create"]').attributes('disabled')).toBeUndefined()
})

test('YAML save 合法 → 回填 model;非法 → 显示错误', async () => {
  const w = mountIs()
  // 通过找真实 YamlEditor 触发 save 事件 → 走 onYamlSave
  const yaml = w.findComponent({ name: 'YamlEditor' })
  // 合法:onYamlSave 把 model 替换为解析结果,名字输入框随之更新
  yaml.vm.$emit('save', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: fromyaml\n  namespace: default\nspec:\n  podSelector: {}\n  policyTypes: [Ingress]\n  ingress: [{}]\n')
  await w.vm.$nextTick()
  await w.vm.$nextTick()
  expect(el('input[data-test="name-input"]').element.value).toBe('fromyaml')
  // 非法:显示解析错误
  yaml.vm.$emit('save', ':::bad:::')
  await w.vm.$nextTick()
  expect(document.body.textContent).toContain(i18n.global.t('ns.netpolCreate.err.parseError'))
})

function mountIs() { return mountIt() }
