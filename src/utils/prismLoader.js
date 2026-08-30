// Prism 懒加载共享器(自 CodeViewer 抽出,供 CodeViewer/CodeTextarea 共用):
// 仅在首次调用时按依赖序拉取 prismjs + 语言包 + 主题(~200KB),之后全 app 共享同一 Promise/模块。
// 消毒职责归调用方(CodeViewer/CodeTextarea 均经 DOMPurify 后才 v-html)。
let PrismPromise = null
export function loadPrism() {
  if (!PrismPromise) {
    PrismPromise = (async () => {
      const Prism = (await import('prismjs')).default
      // 原有
      await import('prismjs/components/prism-json')
      await import('prismjs/components/prism-yaml')
      await import('prismjs/components/prism-toml')
      await import('prismjs/components/prism-ini')
      await import('prismjs/components/prism-properties')
      await import('prismjs/components/prism-bash')
      await import('prismjs/components/prism-python')
      // 新增：基础 + 依赖链
      await import('prismjs/components/prism-markup')      // html/xml/svg/rss
      await import('prismjs/components/prism-css')
      await import('prismjs/components/prism-clike')
      await import('prismjs/components/prism-c')            // c/h
      await import('prismjs/components/prism-cpp')          // 依赖 c
      await import('prismjs/components/prism-java')
      await import('prismjs/components/prism-csharp')
      await import('prismjs/components/prism-javascript')
      await import('prismjs/components/prism-typescript')   // 依赖 javascript
      await import('prismjs/components/prism-go')
      await import('prismjs/components/prism-rust')
      await import('prismjs/components/prism-sql')
      await import('prismjs/components/prism-markup-templating') // prism-php 依赖
      await import('prismjs/components/prism-php')
      await import('prismjs/components/prism-ruby')
      await import('prismjs/components/prism-markdown')
      await import('prismjs/components/prism-graphql')
      await import('prismjs/components/prism-docker')       // 注册 id 'docker'（Dockerfile 映射用）
      await import('prismjs/components/prism-makefile')
      await import('prismjs/components/prism-diff')
      await import('prismjs/themes/prism-tomorrow.css')
      return Prism
    })()
  }
  return PrismPromise
}
