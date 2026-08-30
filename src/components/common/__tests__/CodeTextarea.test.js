// src/components/common/__tests__/CodeTextarea.test.js
// 语法高亮编辑器(2026-08-29):透明 textarea 叠加 Prism 高亮层——编辑时即高亮,零新依赖。
// 契约:v-model 直传;高亮层 aria-hidden 且经 DOMPurify;滚动同步;inheritAttrs=false 使
// data-testid 等透传到内部 textarea(调用方选择器/测试不破)。
import { test, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CodeTextarea from '@/components/common/CodeTextarea.vue'

let w = null
afterEach(() => { w?.unmount(); w = null })

test('v-model:输入 emits update:modelValue,textarea 显示当前值', async () => {
  w = mount(CodeTextarea, { props: { modelValue: 'a: 1', lang: 'yaml', 'data-testid': 'ccm-yaml-input' } })
  const ta = w.find('textarea')
  expect(ta.element.value).toBe('a: 1')
  // data-testid 透传到 textarea(inheritAttrs=false + v-bind=$attrs)
  expect(ta.attributes('data-testid')).toBe('ccm-yaml-input')
  ta.setValue('a: 2\nb: 3')
  expect(w.emitted('update:modelValue')[0]).toEqual(['a: 2\nb: 3'])
})

test('高亮层:pre aria-hidden 存在,yaml 文本进入高亮层(转义或高亮形态)', async () => {
  w = mount(CodeTextarea, { props: { modelValue: 'kind: ConfigMap\nmetadata:\n  name: x', lang: 'yaml' } })
  await nextTick()
  const pre = w.find('pre')
  expect(pre.attributes('aria-hidden')).toBe('true')
  // Prism 懒加载前为转义文本,加载后为高亮 HTML——两种形态都须包含原文可见内容
  expect(pre.text()).toContain('kind: ConfigMap')
  expect(pre.text()).toContain('name: x')
})

test('滚动同步:textarea 滚动带动高亮层', async () => {
  const long = Array.from({ length: 60 }, (_, i) => `k${i}: v${i}`).join('\n')
  w = mount(CodeTextarea, { props: { modelValue: long, lang: 'yaml' }, attrs: {} })
  await nextTick()
  const ta = w.find('textarea')
  // 压缩容器高度使可滚
  ta.element.style.height = '100px'
  ta.element.scrollTop = 200
  await ta.trigger('scroll')
  await nextTick()
  const pre = w.find('pre').element
  expect(pre.scrollTop).toBe(200)
})

test('modelValue 外部变化(非用户输入)→ textarea 跟随', async () => {
  w = mount(CodeTextarea, { props: { modelValue: 'a: 1', lang: 'yaml' } })
  await w.setProps({ modelValue: 'b: 2' })
  expect(w.find('textarea').element.value).toBe('b: 2')
})
