import { test, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CodeViewer from '../common/CodeViewer.vue'

// 辅助：CodeViewer.loadPrism 内含 30+ 顺序 await import 链；happy-dom + vitest 下每个动态 import
// 都是一次宏任务跳转，整条链解析需 ~2s。flushPromises(setTimeout0) 无法可靠排空，需多轮真实等待
// 后再 flush 让 watchEffect 走完高亮。详见 brief「flaky」备注。
const flushDeep = async () => {
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 100))
    await flushPromises()
  }
}

test('CodeViewer: go 语言加载并产出 Prism token', async () => {
  const w = mount(CodeViewer, { props: { code: 'package main\nfunc main() {}\n', lang: 'go' } })
  await flushDeep() // Prism 多段懒加载链 + watchEffect 高亮
  expect(w.html()).toContain('token')
})

test('CodeViewer: lang=none 退化纯文本无 token', async () => {
  const w = mount(CodeViewer, { props: { code: 'plain text', lang: 'none' } })
  await flushPromises()
  expect(w.html()).toContain('plain text')
  expect(w.html()).not.toContain('token')
})
