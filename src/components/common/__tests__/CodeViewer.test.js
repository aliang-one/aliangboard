// 安全回归(2026-08-28 CSO 审计发现 #1):CodeViewer 三条裸渲染路径曾把原始 code 灌进 v-html
// (① 初始 ref(props.code) 首帧;② lang='none';③ 无 grammar 回退)。pod 文件/ConfigMap 值等
// 集群可控内容经 FilePreview/DataKeysEditor 到达此处 → 存储型 XSS。本测试固化消毒语义:
// none/无 grammar 路径 = 纯文本转义(字面显示,无活元素),Prism 路径产物必须过 DOMPurify。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CodeViewer from '@/components/common/CodeViewer.vue'

const PAYLOAD = `<img src=x onerror="alert(1)"><script>alert(2)</script><b>bold</b>`

// 安全属性 = DOM 里不产生可执行元素/属性;转义文本里"看得见"标签字符串是预期(字面展示)。
function expectNoLiveMarkup(w) {
  expect(w.element.querySelector('img, script, iframe, svg')).toBe(null)
  const html = w.html()
  expect(html).not.toContain('<img')   // 活元素以原始 < 序列化;转义文本只出现 &lt;img
  expect(html).not.toContain('<script')
}

test('lang=none:恶意 HTML 按字面转义显示,不产生活元素', async () => {
  const w = mount(CodeViewer, { props: { code: PAYLOAD, lang: 'none' } })
  await nextTick()
  expectNoLiveMarkup(w)
  // 字面语义:标签以转义文本可见(内容没丢)
  expect(w.html()).toContain('&lt;img')
  expect(w.html()).toContain('&lt;b&gt;bold&lt;/b&gt;')
})

test('首帧即安全且可见:Prism 加载前后都不裸渲(转义文本先行,高亮后无活元素)', async () => {
  const w = mount(CodeViewer, { props: { code: PAYLOAD, lang: 'yaml' } })
  // 不等 Prism——首帧断言:内容已可见(转义)且无活元素
  expect(w.html()).toContain('&lt;img')
  expectNoLiveMarkup(w)
  // 等 Prism 真正加载并高亮(懒加载 + watchEffect 异步;轮询直到高亮产物或超时)
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 50))
    await nextTick()
    if (w.html().includes('token')) break
  }
  expectNoLiveMarkup(w) // 高亮产物(或其转义兜底)无论如何不得含活元素
})

test('catch 兜底路径同样转义:空 code 不炸、不出现 undefined', async () => {
  const w = mount(CodeViewer, { props: { code: '', lang: 'none' } })
  await nextTick()
  expect(w.html()).not.toContain('undefined')
})
