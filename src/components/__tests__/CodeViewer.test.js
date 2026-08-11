import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CodeViewer from '../common/CodeViewer.vue'

// CodeViewer.loadPrism 内含 30+ 顺序 await import 链；happy-dom + vitest 下整条链
// 解析需数秒，且全量套件下受 transform/import 竞争影响时长不稳定。固定轮次等待
// (flushDeep/flushShallow) 在隔离下通过、全量下偶发败。改用 vi.waitFor 轮询断言，
// 重试到通过或超时——对时序鲁棒。
test('CodeViewer: go 语言加载并产出 Prism token', async () => {
  const w = mount(CodeViewer, { props: { code: 'package main\nfunc main() {}\n', lang: 'go' } })
  await vi.waitFor(() => expect(w.html()).toContain('token'), { timeout: 5000, interval: 50 })
})

test('CodeViewer: lang=none 退化纯文本无 token', async () => {
  const w = mount(CodeViewer, { props: { code: 'plain text', lang: 'none' } })
  await flushPromises()
  expect(w.html()).toContain('plain text')
  expect(w.html()).not.toContain('token')
})
