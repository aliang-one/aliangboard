// agent 终答 markdown → 安全 HTML。同步：marked.parse 默认渲染（围栏代码 → <pre><code class="language-X">，
// 代码本身已转义）→ DOMPurify 消毒（默认保留 class，剥离 script/事件属性）。
// 代码高亮（token span）由消费方在 v-html 渲染后调 Prism.highlightAllUnder 补（见 ChatTurn.vue）。
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: false })

export function renderMarkdown(md) {
  if (!md) return ''
  const raw = marked.parse(String(md))
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
}
