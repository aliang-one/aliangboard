import { test, expect, beforeAll } from 'vitest'
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

// 预热：在 beforeAll 里挂载一次性实例触发 Prism 懒加载链，模块缓存热后再 unmount。
// 之后 test 里的新实例共享已 resolve 的 PrismPromise。预热把 30+ 顺序 import 的高昂一次性
// 成本移出 test 之外；但 watchEffect 仍是 async（即便 await 已 resolve 的 promise 也让出
// 微任务），故 test 内仍需少量 flush+wait 轮次让高亮落定。全量套件竞争 transform 时尤甚。
let _warmup = null
beforeAll(async () => {
  _warmup = mount(CodeViewer, { props: { code: 'package warmup', lang: 'go' } })
  await flushDeep()
  _warmup.unmount()
  _warmup = null
})

// 已预热 Prism，仅余 watchEffect 的几轮微任务需要排空
const flushShallow = async (n = 5) => {
  for (let i = 0; i < n; i++) {
    await new Promise(r => setTimeout(r, 10))
    await flushPromises()
  }
}

test('CodeViewer: go 语言加载并产出 Prism token', async () => {
  const w = mount(CodeViewer, { props: { code: 'package main\nfunc main() {}\n', lang: 'go' } })
  await flushShallow() // Prism 已预热；仅需 watchEffect 走完高亮
  expect(w.html()).toContain('token')
})

test('CodeViewer: lang=none 退化纯文本无 token', async () => {
  const w = mount(CodeViewer, { props: { code: 'plain text', lang: 'none' } })
  await flushPromises()
  expect(w.html()).toContain('plain text')
  expect(w.html()).not.toContain('token')
})
