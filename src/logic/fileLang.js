// 文件名 → Prism 语法 id 映射；未命中返回 'none'（CodeViewer 退化为纯文本）。
// 仅做语言推断；二进制判定信任服务端 read 返回的 binary 标志（NUL 字节探测）。
const EXT_MAP = {
  yaml: 'yaml', yml: 'yaml',
  json: 'json', toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
  sh: 'bash', bash: 'bash',
  py: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
  go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', sql: 'sql', php: 'php', rb: 'ruby',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', rss: 'markup',
  css: 'css', md: 'markdown', markdown: 'markdown',
  graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
  mk: 'makefile',
}
// 无扩展名 basename 特判（大小写不敏感）
const BASENAME_MAP = { dockerfile: 'docker', makefile: 'makefile' }

export function langFor(name) {
  if (!name) return 'none'
  const base = String(name).split('/').pop() || name
  const lower = base.toLowerCase()
  if (BASENAME_MAP[lower]) return BASENAME_MAP[lower]
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return 'none'
  return EXT_MAP[lower.slice(dot + 1)] || 'none'
}

export function isHighlightable(name) {
  return langFor(name) !== 'none'
}
