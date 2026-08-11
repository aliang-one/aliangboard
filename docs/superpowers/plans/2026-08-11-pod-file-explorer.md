# Pod 文件查看器 VSCode 式重构 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Pod 文件浏览从「单视图扁平列表」重构为「左侧懒加载目录树 + 右侧上下文区（文件夹→条目列表 / 文件→Prism 高亮内容）」，保留全部现有编辑能力（上传/下载/在线编辑保存），零新依赖。

**Architecture:** 原地重写 `FileBrowserBody.vue` 为薄编排层，组合 `usePodFiles`（数据层 composable，container:path 复合键缓存）+ `FileTree`/`FileTreeNode`（递归懒加载树，provide/inject）+ `FolderPreview`/`FilePreview`（右栏）。复用现有 `SplitPane` / `CodeViewer` / `code-theme`。后端 `/api/podfile/*` 不变。

**Tech Stack:** Vue 3 (`<script setup>`，纯 JS)、Vite、vue-i18n（JSON locale）、Tailwind + MD3 token、Prism.js（已登记依赖）、vitest + happy-dom + @vue/test-utils。

**参考 spec：** `docs/superpowers/specs/2026-08-11-pod-file-explorer-design.md`

## Global Constraints

- **不新增依赖**：复用已登记的 `prismjs`；编辑态用原生 `<textarea>`，禁止引入 Monaco/CodeMirror。
- **i18n**：所有可见文案走 `t()`；新增键同时写 `src/locales/zh.json` 与 `src/locales/en.json`；消息值含 HTML 须 `v-html`；字面 `@` 须转义为 `{'@'}`；`npm run i18n:check` 必过。
- **测试约定**：vitest 测试文件路径匹配 `src/**/*.{test,spec}.js`（colocate `__tests__/` 子目录）；组件用 `@vue/test-utils` 的 `mount` + happy-dom；纯逻辑放 `src/logic/`；`npm run test:unit` = `vitest run`。
- **类型/语法基线**：`npm run typecheck`（`node --check` 全 `.js/.mjs`）；`.vue` 编译由 `npm run build` 覆盖。
- **样式**：Tailwind + MD3 token；代码配色单一来源 `src/styles/code-theme.js`；Material Symbols 图标需显式 `font-family`（class `material-symbols-outlined`）。
- **代码风格**：`<script setup>`、纯 JS、中文行内注释、命名/缩进贴周边代码。
- **分支**：`feat/pod-file-explorer`（worktree `.claude/worktrees/pod-file-explorer`）。每个 Task 结束 commit。
- **复用契约（勿改签名）**：`podFileApi.list/read/write/download`（见 spec §3）；`FileBrowserBody` props `namespace/pod/container`；根元素 `h-full min-h-0`；`SplitPane` props `storageKey` 必填 + 具名 slot `first`/`second`；`CodeViewer` props `code/lang/maxHeight`，`lang` 须为 Prism 语言 id。

---

## File Structure

| 文件 | 状态 | 职责 |
|------|------|------|
| `src/logic/fileLang.js` | 新增 | 纯函数 `langFor(name)→Prism id`、`isHighlightable(name)` |
| `src/logic/__tests__/fileLang.test.js` | 新增 | 上述纯函数测试 |
| `src/composables/usePodFiles.js` | 新增 | 数据层：list/read/write/download + 缓存 + invalidate/resetForContainer |
| `src/composables/__tests__/usePodFiles.test.js` | 新增 | 缓存契约测试（mock `@/api/client`） |
| `src/components/common/CodeViewer.vue` | 修改 | 扩展 Prism 语言懒加载表 |
| `src/components/__tests__/CodeViewer.test.js` | 新增 | 新语言（go）高亮冒烟 |
| `src/components/common/FileTreeNode.vue` | 新增 | 递归树节点（inject 上下文） |
| `src/components/common/FileTree.vue` | 新增 | 左栏：渲染根节点 |
| `src/components/__tests__/FileTree.test.js` | 新增 | 树渲染/选中/展开冒烟（stub inject） |
| `src/components/common/FolderPreview.vue` | 新增 | 右栏：文件夹条目列表 |
| `src/components/common/FilePreview.vue` | 新增 | 右栏：文件查看/编辑/下载/二进制/截断 |
| `src/components/__tests__/FilePreview.test.js` | 新增 | 查看/编辑/二进制分支冒烟 |
| `src/components/common/FileBrowserBody.vue` | 重写 | 编排器：toolbar + SplitPane + provide 上下文 |
| `src/components/__tests__/FileBrowserBody.test.js` | 新增 | 集成冒烟：树→文件夹→文件 |
| `src/locales/zh.json` / `en.json` | 修改 | `component.fileBrowser` 下 +5 键 |

---

## Task 1: 纯函数 fileLang（扩展名→Prism 语言 id）

**Files:**
- Create: `src/logic/fileLang.js`
- Test: `src/logic/__tests__/fileLang.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `langFor(name: string): string`（返回 Prism 语言 id，未命中返回 `'none'`）；`isHighlightable(name: string): boolean`。大小写不敏感；无扩展名特判 `Dockerfile`/`Makefile`。

- [ ] **Step 1: 写失败测试**

创建 `src/logic/__tests__/fileLang.test.js`：

```js
import { test, expect } from 'vitest'
import { langFor, isHighlightable } from '../fileLang'

test('langFor: 配置类', () => {
  expect(langFor('a.yaml')).toBe('yaml')
  expect(langFor('a.YML')).toBe('yaml')
  expect(langFor('config.json')).toBe('json')
  expect(langFor('pyproject.toml')).toBe('toml')
  expect(langFor('app.ini')).toBe('ini')
  expect(langFor('a.cfg')).toBe('ini')
  expect(langFor('logger.properties')).toBe('properties')
})
test('langFor: 脚本/语言', () => {
  expect(langFor('run.sh')).toBe('bash')
  expect(langFor('main.py')).toBe('python')
  expect(langFor('i.js')).toBe('javascript')
  expect(langFor('m.mjs')).toBe('javascript')
  expect(langFor('a.ts')).toBe('typescript')
  expect(langFor('main.go')).toBe('go')
  expect(langFor('lib.rs')).toBe('rust')
  expect(langFor('App.java')).toBe('java')
  expect(langFor('a.c')).toBe('c')
  expect(langFor('a.h')).toBe('c')
  expect(langFor('a.cpp')).toBe('cpp')
  expect(langFor('a.cs')).toBe('csharp')
  expect(langFor('q.sql')).toBe('sql')
  expect(langFor('web.rb')).toBe('ruby')
  expect(langFor('svc.php')).toBe('php')
})
test('langFor: 标记/web', () => {
  expect(langFor('page.html')).toBe('markup')
  expect(langFor('data.xml')).toBe('markup')
  expect(langFor('s.svg')).toBe('markup')
  expect(langFor('style.css')).toBe('css')
  expect(langFor('README.md')).toBe('markdown')
  expect(langFor('q.graphql')).toBe('graphql')
  expect(langFor('p.diff')).toBe('diff')
})
test('langFor: 无扩展名特判 + 大小写不敏感', () => {
  expect(langFor('Dockerfile')).toBe('docker')
  expect(langFor('DOCKERFILE')).toBe('docker')
  expect(langFor('Makefile')).toBe('makefile')
})
test('langFor: 未命中 → none', () => {
  expect(langFor('notes')).toBe('none')
  expect(langFor('weird.xyz')).toBe('none')
  expect(langFor('')).toBe('none')
  expect(langFor(undefined)).toBe('none')
  expect(langFor('path/noext/file')).toBe('none')
})
test('isHighlightable', () => {
  expect(isHighlightable('a.js')).toBe(true)
  expect(isHighlightable('notes')).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/fileLang.test.js`
Expected: FAIL（`Cannot find module '../fileLang'`）

- [ ] **Step 3: 写最小实现**

创建 `src/logic/fileLang.js`：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/logic/__tests__/fileLang.test.js`
Expected: PASS（6 用例）

- [ ] **Step 5: 提交**

```bash
git add src/logic/fileLang.js src/logic/__tests__/fileLang.test.js
git commit -m "feat(pod-files): fileLang 扩展名→Prism 语言 id 纯函数"
```

---

## Task 2: usePodFiles composable（数据层 + 缓存）

**Files:**
- Create: `src/composables/usePodFiles.js`
- Test: `src/composables/__tests__/usePodFiles.test.js`

**Interfaces:**
- Consumes: `podFileApi`（`@/api/client`，签名见 spec §3）
- Produces: `usePodFiles()` → `{ dirCache, fileCache, inflight, lastError, listDir, readFile, writeFile, download, invalidate, invalidateDir, resetForContainer }`。其中：
  - `dirCache` / `fileCache`：`ref(Map)`，键 `"${container}::${path}"`；写缓存时整体替换 Map 以触发响应式。
  - `listDir(ctx, path, { force }?)`：`ctx={namespace,pod,container}`；返回排序后的 `entries[]`；命中缓存且非 force 则不发请求。
  - `readFile(ctx, path, { force }?)`：返回 `{ name, path, content, truncated, binary }`。
  - `writeFile(ctx, path, bytes: Uint8Array)`：base64 编码后调 `podFileApi.write`；成功后 invalidate 该文件 + 其父目录缓存。
  - `download(ctx, path)`：返回 `Blob`。
  - `invalidate(container, path)` / `invalidateDir(container, path)`：删除对应键。
  - `resetForContainer(container)`：删除该 container 前缀的所有键（保留其它 container）。

- [ ] **Step 1: 写失败测试**

创建 `src/composables/__tests__/usePodFiles.test.js`：

```js
import { test, expect, vi, beforeEach } from 'vitest'

vi.mock('@/api/client', () => ({
  podFileApi: {
    list: vi.fn(), read: vi.fn(), write: vi.fn(), download: vi.fn(),
  },
}))
import { podFileApi } from '@/api/client'
import { usePodFiles } from '../usePodFiles'

const CTX = { namespace: 'ns', pod: 'p', container: 'c' }

beforeEach(() => {
  podFileApi.list.mockReset(); podFileApi.read.mockReset()
  podFileApi.write.mockReset(); podFileApi.download.mockReset()
})

test('listDir: 同 ctx+path 命中缓存只请求一次', async () => {
  podFileApi.list.mockResolvedValue({ entries: [{ name: 'a', type: 'file' }] })
  const { listDir } = usePodFiles()
  await listDir(CTX, '/x'); await listDir(CTX, '/x')
  expect(podFileApi.list).toHaveBeenCalledTimes(1)
})

test('listDir: force 绕过缓存', async () => {
  podFileApi.list.mockResolvedValue({ entries: [] })
  const { listDir } = usePodFiles()
  await listDir(CTX, '/x'); await listDir(CTX, '/x', { force: true })
  expect(podFileApi.list).toHaveBeenCalledTimes(2)
})

test('listDir: 目录在前排序', async () => {
  podFileApi.list.mockResolvedValue({ entries: [
    { name: 'z.txt', type: 'file' }, { name: 'a', type: 'dir' }, { name: 'm', type: 'dir' },
  ] })
  const { listDir } = usePodFiles()
  const e = await listDir(CTX, '/')
  expect(e.map(x => x.name)).toEqual(['a', 'm', 'z.txt'])
})

test('listDir: 不同 container 隔离缓存', async () => {
  podFileApi.list.mockResolvedValue({ entries: [] })
  const { listDir } = usePodFiles()
  await listDir(CTX, '/x'); await listDir({ ...CTX, container: 'other' }, '/x')
  expect(podFileApi.list).toHaveBeenCalledTimes(2)
})

test('readFile: 命中缓存', async () => {
  podFileApi.read.mockResolvedValue({ path: '/a.go', content: 'x', truncated: false, binary: false })
  const { readFile } = usePodFiles()
  await readFile(CTX, '/a.go'); await readFile(CTX, '/a.go')
  expect(podFileApi.read).toHaveBeenCalledTimes(1)
})

test('writeFile: invalidate 文件 + 父目录缓存', async () => {
  podFileApi.list.mockResolvedValue({ entries: [] })
  podFileApi.read.mockResolvedValue({ path: '/d/f.txt', content: 'x', truncated: false, binary: false })
  podFileApi.write.mockResolvedValue({ ok: true })
  const { listDir, readFile, writeFile } = usePodFiles()
  await listDir(CTX, '/d'); await readFile(CTX, '/d/f.txt')
  expect(podFileApi.list).toHaveBeenCalledTimes(1)
  expect(podFileApi.read).toHaveBeenCalledTimes(1)
  await writeFile(CTX, '/d/f.txt', new TextEncoder().encode('y'))
  await listDir(CTX, '/d'); await readFile(CTX, '/d/f.txt')
  expect(podFileApi.list).toHaveBeenCalledTimes(2) // 父目录被失效→重取
  expect(podFileApi.read).toHaveBeenCalledTimes(2)  // 文件被失效→重取
})

test('resetForContainer: 只清当前 container', async () => {
  podFileApi.list.mockResolvedValue({ entries: [] })
  const { listDir, resetForContainer } = usePodFiles()
  await listDir(CTX, '/x'); await listDir({ ...CTX, container: 'b' }, '/x')
  resetForContainer('c')
  await listDir(CTX, '/x')                       // c 已清→重取
  await listDir({ ...CTX, container: 'b' }, '/x') // b 仍在→命中
  expect(podFileApi.list).toHaveBeenCalledTimes(3)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/usePodFiles.test.js`
Expected: FAIL（`Cannot find module '../usePodFiles'`）

- [ ] **Step 3: 写最小实现**

创建 `src/composables/usePodFiles.js`：

```js
// Pod 文件数据层：封装 podFileApi，带 container:path 复合键缓存。
// 供 FileBrowserBody 及其子组件（经 provide/inject）复用。预留为 Vue Query 迁移替换点。
import { ref } from 'vue'
import { podFileApi } from '@/api/client'

function sortEntries(a, b) {
  return a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
}
function parentDir(path) {
  if (path === '/' || !path) return '/'
  const parts = path.split('/').filter(Boolean); parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}
// Uint8Array → base64（分块避免 fromCharCode 栈溢出，与原 writeBytes 行为一致）
function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function usePodFiles() {
  const dirCache = ref(new Map())   // `${container}::${path}` -> entries[]
  const fileCache = ref(new Map())  // key -> { name, path, content, truncated, binary }
  const inflight = ref(new Set())   // 正在加载的 dir key
  const lastError = ref('')

  const dk = (container, path) => `${container || ''}::${path}`
  const setMap = (refObj, next) => { refObj.value = next } // 整体替换触发响应式

  async function listDir(ctx, path, { force = false } = {}) {
    const k = dk(ctx.container, path)
    if (!force && dirCache.value.has(k)) return dirCache.value.get(k)
    const s = new Set(inflight.value); s.add(k); inflight.value = s
    lastError.value = ''
    try {
      const res = await podFileApi.list({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container, path })
      const entries = (res.entries || []).slice().sort(sortEntries)
      setMap(dirCache, new Map(dirCache.value).set(k, entries))
      return entries
    } catch (e) { lastError.value = e.message || 'readDirFailed'; throw e }
    finally { const s2 = new Set(inflight.value); s2.delete(k); inflight.value = s2 }
  }

  async function readFile(ctx, path, { force = false } = {}) {
    const k = dk(ctx.container, path)
    if (!force && fileCache.value.has(k)) return fileCache.value.get(k)
    lastError.value = ''
    try {
      const res = await podFileApi.read({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container, path })
      const f = { name: (path.split('/').pop() || path), path: res.path, content: res.content, truncated: res.truncated, binary: res.binary }
      setMap(fileCache, new Map(fileCache.value).set(k, f))
      return f
    } catch (e) { lastError.value = e.message || 'readFailed'; throw e }
  }

  async function writeFile(ctx, path, bytes) {
    await podFileApi.write({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container, path, data: bytesToBase64(bytes) })
    invalidate(ctx.container, path)
    invalidateDir(ctx.container, parentDir(path))
  }

  function download(ctx, path) {
    return podFileApi.download({ namespace: ctx.namespace, pod: ctx.pod, container: ctx.container, path })
  }

  function invalidate(container, path) {
    const k = dk(container, path)
    if (fileCache.value.has(k)) setMap(fileCache, (() => { const n = new Map(fileCache.value); n.delete(k); return n })())
  }
  function invalidateDir(container, path) {
    const k = dk(container, path)
    if (dirCache.value.has(k)) setMap(dirCache, (() => { const n = new Map(dirCache.value); n.delete(k); return n })())
  }

  function resetForContainer(container) {
    const prefix = `${container || ''}::`
    const filterMap = (m) => { const n = new Map(); for (const [k, v] of m) if (!k.startsWith(prefix)) n.set(k, v); return n }
    setMap(dirCache, filterMap(dirCache.value))
    setMap(fileCache, filterMap(fileCache.value))
  }

  return { dirCache, fileCache, inflight, lastError, listDir, readFile, writeFile, download, invalidate, invalidateDir, resetForContainer }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/usePodFiles.test.js`
Expected: PASS（7 用例）

- [ ] **Step 5: 提交**

```bash
git add src/composables/usePodFiles.js src/composables/__tests__/usePodFiles.test.js
git commit -m "feat(pod-files): usePodFiles 数据层 composable(container:path 缓存)"
```

---

## Task 3: 扩展 CodeViewer 语言集

**Files:**
- Modify: `src/components/common/CodeViewer.vue`（`loadPrism()` 内的 import 列表）
- Test: `src/components/__tests__/CodeViewer.test.js`

**Interfaces:**
- Consumes: Prism 语言组件（`prismjs/components/*`，已在依赖内）
- Produces: `CodeViewer` 现支持 go/rust/java/c/cpp/csharp/sql/php/ruby/markup/css/markdown/graphql/docker/makefile/diff（除原有 yaml/json/toml/ini/properties/bash/python/javascript/typescript）。`lang` 为上述 id 时高亮，否则退化纯文本（既有行为）。

> Prism 依赖顺序：`clike` → `javascript` → `typescript`；`c` → `cpp`。按序 await import 确保 dependent 在 dependency 之后注册。

- [ ] **Step 1: 写失败测试**

创建 `src/components/__tests__/CodeViewer.test.js`：

```js
import { test, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CodeViewer from '../common/CodeViewer.vue'

test('CodeViewer: go 语言加载并产出 Prism token', async () => {
  const w = mount(CodeViewer, { props: { code: 'package main\nfunc main() {}\n', lang: 'go' } })
  await flushPromises() // 等 Prism 懒加载 + watchEffect 高亮
  expect(w.html()).toContain('token')
})

test('CodeViewer: lang=none 退化纯文本无 token', async () => {
  const w = mount(CodeViewer, { props: { code: 'plain text', lang: 'none' } })
  await flushPromises()
  expect(w.html()).toContain('plain text')
  expect(w.html()).not.toContain('token')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/CodeViewer.test.js`
Expected: FAIL（go 用例：当前未 import prism-go，`Prism.languages.go` 不存在 → 无 token）

- [ ] **Step 3: 修改 CodeViewer.vue 的 loadPrism**

把 `src/components/common/CodeViewer.vue` 中 `loadPrism` 内的 `Promise.all([...])` 替换为按依赖顺序的 await 序列（保留原有语言，新增见注释）：

```js
function loadPrism() {
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
```

并更新文件顶部注释的语言列表说明。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/CodeViewer.test.js`
Expected: PASS（2 用例）

- [ ] **Step 5: 提交**

```bash
git add src/components/common/CodeViewer.vue src/components/__tests__/CodeViewer.test.js
git commit -m "feat(pod-files): CodeViewer 扩展 Prism 语言集(go/rust/java/c/cpp/...)"
```

---

## Task 4: FileTree + FileTreeNode（递归懒加载树）

**Files:**
- Create: `src/components/common/FileTreeNode.vue`
- Create: `src/components/common/FileTree.vue`
- Test: `src/components/__tests__/FileTree.test.js`

**Interfaces:**
- Consumes（inject key `'fileExplorer'`，由 Task 7 的 `FileBrowserBody` provide）：
  ```js
  { ctx, selected: Ref<string|null>, isExpanded(path):boolean, isLoading(path):boolean,
    childrenOf(path):Entry[], selectNode(path, isDir):void, toggleNode(path):Promise<void> }
  ```
  `Entry = { name: string, type: 'dir'|'file' }`。
- Produces：`FileTree`（无 props，从 inject 读根 `childrenOf('/')`）；`FileTreeNode`（props：`entry: Entry`、`parentPath: string`（默认 `'/'`）、`depth: number`（默认 `0`）；递归引用自身渲染子节点）。

- [ ] **Step 1: 写失败测试**

创建 `src/components/__tests__/FileTree.test.js`：

```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import FileTree from '../common/FileTree.vue'
import FileTreeNode from '../common/FileTreeNode.vue'

// 构造 inject 桩
function stubApi(over = {}) {
  return {
    ctx: { namespace: 'ns', pod: 'p', container: 'c' },
    selected: { value: null },
    isExpanded: () => false,
    isLoading: () => false,
    childrenOf: (p) => p === '/' ? [{ name: 'app', type: 'dir' }, { name: 'a.go', type: 'file' }] : [{ name: 'inner.go', type: 'file' }],
    selectNode: vi.fn(),
    toggleNode: vi.fn().mockResolvedValue(),
    ...over,
  }
}

test('FileTree: 渲染根条目', () => {
  const w = mount(FileTree, { global: { provide: { fileExplorer: stubApi() } } })
  expect(w.text()).toContain('app')
  expect(w.text()).toContain('a.go')
})

test('FileTreeNode: 点文件行触发 selectNode(file)', async () => {
  const api = stubApi()
  const w = mount(FileTreeNode, {
    props: { entry: { name: 'a.go', type: 'file' }, parentPath: '/', depth: 0 },
    global: { provide: { fileExplorer: api } },
  })
  await w.find('.fb-row').trigger('click')
  expect(api.selectNode).toHaveBeenCalledWith('/a.go', false)
})

test('FileTreeNode: 点 twisty 触发 toggleNode；展开后渲染子节点', async () => {
  const api = stubApi({ isExpanded: (p) => p === '/app' })
  const w = mount(FileTreeNode, {
    props: { entry: { name: 'app', type: 'dir' }, parentPath: '/', depth: 0 },
    global: { provide: { fileExplorer: api } },
  })
  await w.find('.fb-twisty').trigger('click')
  expect(api.toggleNode).toHaveBeenCalledWith('/app')
  expect(w.text()).toContain('inner.go') // 展开后递归渲染子节点
})

test('FileTreeNode: 选中态高亮 class', () => {
  const api = stubApi({ selected: { value: '/a.go' } })
  const w = mount(FileTreeNode, {
    props: { entry: { name: 'a.go', type: 'file' }, parentPath: '/', depth: 0 },
    global: { provide: { fileExplorer: api } },
  })
  expect(w.find('.fb-row').classes()).toContain('fb-selected')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/FileTree.test.js`
Expected: FAIL（找不到组件模块）

- [ ] **Step 3: 写 FileTreeNode.vue**

创建 `src/components/common/FileTreeNode.vue`：

```vue
<script setup>
// 递归树节点：通过 inject('fileExplorer') 拿上下文，避免深层 prop 透传。
// 文件夹：点 twisty 展开/折叠（懒加载由 toggleNode 负责）；点行选中。
import { computed, inject } from 'vue'

const props = defineProps({
  entry: { type: Object, required: true },
  parentPath: { type: String, default: '/' },
  depth: { type: Number, default: 0 },
})

const x = inject('fileExplorer')
const joinPath = (d, n) => (d.endsWith('/') ? d + n : d + '/' + n)
const path = computed(() => joinPath(props.parentPath, props.entry.name))
const isDir = computed(() => props.entry.type === 'dir')
const expanded = computed(() => isDir.value && x.isExpanded(path.value))
const loading = computed(() => isDir.value && x.isLoading(path.value))
const selected = computed(() => x.selected.value === path.value)
const children = computed(() => expanded.value ? (x.childrenOf(path.value) || []) : [])

function onRow() { x.selectNode(path.value, isDir.value) }
async function onTwisty(e) { e.stopPropagation(); await x.toggleNode(path.value) }
</script>

<template>
  <div>
    <div class="fb-row flex items-center gap-xs rounded-md cursor-pointer hover:bg-surface-container-low transition-colors"
         :class="{ 'fb-selected bg-primary/10 text-primary': selected }"
         :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
         @click="onRow">
      <button v-if="isDir" class="fb-twisty p-0 w-4 flex items-center justify-center text-on-surface-variant hover:text-primary" @click="onTwisty" :aria-label="expanded ? $t('component.fileBrowser.collapse') : $t('component.fileBrowser.expand')">
        <span class="material-symbols-outlined text-base">{{ expanded ? 'expand_more' : 'chevron_right' }}</span>
      </button>
      <span v-else class="inline-block w-4 shrink-0" />
      <span class="material-symbols-outlined text-base shrink-0" :class="isDir ? 'text-primary' : 'text-on-surface-variant'">{{ isDir ? (expanded ? 'folder_open' : 'folder') : 'description' }}</span>
      <span class="font-mono text-xs truncate flex-1" :title="entry.name">{{ entry.name }}</span>
      <span v-if="loading" class="material-symbols-outlined animate-spin text-xs text-on-surface-variant">progress_activity</span>
    </div>
    <FileTreeNode v-if="expanded" v-for="c in children" :key="c.name" :entry="c" :parent-path="path" :depth="depth + 1" />
  </div>
</template>
```

- [ ] **Step 4: 写 FileTree.vue**

创建 `src/components/common/FileTree.vue`：

```vue
<script setup>
// 左栏目录树：渲染根目录条目；展开/选中态由 inject 上下文驱动。
import { inject } from 'vue'
import FileTreeNode from './FileTreeNode.vue'

const x = inject('fileExplorer')
const root = () => x.childrenOf('/') || []
const rootLoading = () => x.isLoading('/')
</script>

<template>
  <div class="h-full overflow-auto min-h-0 py-xs">
    <div v-if="rootLoading()" class="py-md text-center text-body-sm text-on-surface-variant">
      <span class="material-symbols-outlined animate-spin inline-block">progress_activity</span>
    </div>
    <template v-else>
      <FileTreeNode v-for="e in root()" :key="e.name" :entry="e" parent-path="/" :depth="0" />
      <p v-if="!root().length" class="py-md text-center text-body-sm text-on-surface-variant/60">{{ $t('component.fileBrowser.emptyDir') }}</p>
    </template>
  </div>
</template>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/FileTree.test.js`
Expected: PASS（4 用例）

- [ ] **Step 6: 提交**

```bash
git add src/components/common/FileTreeNode.vue src/components/common/FileTree.vue src/components/__tests__/FileTree.test.js
git commit -m "feat(pod-files): FileTree+FileTreeNode 递归懒加载树(inject 上下文)"
```

---

## Task 5: FolderPreview（右栏·文件夹）

**Files:**
- Create: `src/components/common/FolderPreview.vue`

**Interfaces:**
- Consumes（inject `'fileExplorer'`）：`childrenOf(path)`、`selectNode(path, isDir)`。
- Produces：`FolderPreview`（props：`path: string`（默认 `'/'`））。点条目 → `selectNode(childPath, isDir)`，由编排器切右栏。

- [ ] **Step 1: 写失败测试**

创建 `src/components/__tests__/FolderPreview.test.js`：

```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import FolderPreview from '../common/FolderPreview.vue'

const api = {
  childrenOf: (p) => p === '/app' ? [{ name: 'a.go', type: 'file' }, { name: 'sub', type: 'dir' }] : [],
  selectNode: vi.fn(),
}

test('FolderPreview: 列条目 + 点文件触发 selectNode', async () => {
  const w = mount(FolderPreview, { props: { path: '/app' }, global: { provide: { fileExplorer: api } } })
  expect(w.text()).toContain('a.go')
  expect(w.text()).toContain('sub')
  const rows = w.findAll('button.fb-item')
  await rows[0].trigger('click')
  expect(api.selectNode).toHaveBeenCalledWith('/app/a.go', false)
})

test('FolderPreview: 空目录文案', () => {
  const w = mount(FolderPreview, { props: { path: '/empty' }, global: { provide: { fileExplorer: api } } })
  expect(w.text()).toContain('emptyDir') // i18n 键兜底（测试环境无 t，渲染键名）
})
```

> 说明：测试环境未装 i18n 插件时 `$t(key)` 抛错或返回键——本组件用 `useI18n()` 的 `t`，测试需挂 i18n 插件。若测试因 i18n 报错，给 mount 加 `global: { plugins: [i18n], provide:... }`（参考 `_allComponentsMount.test.js` 顶部对 `i18n` 的引入）。执行时若发现此问题，把 `import { i18n } from '@/i18n'` 加入并 `plugins: [i18n]`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/FolderPreview.test.js`
Expected: FAIL（找不到组件）

- [ ] **Step 3: 写 FolderPreview.vue**

创建 `src/components/common/FolderPreview.vue`：

```vue
<script setup>
// 右栏·文件夹：展示该目录条目（v1 无 size），点条目交给编排器选中。
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const props = defineProps({ path: { type: String, default: '/' } })
const x = inject('fileExplorer')
const joinPath = (d, n) => (d.endsWith('/') ? d + n : d + '/' + n)
const entries = computed(() => x.childrenOf(props.path) || [])
function open(e) { x.selectNode(joinPath(props.path, e.name), e.type === 'dir') }
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-center gap-xs pb-sm border-b border-outline-variant/40 shrink-0 pr-10">
      <span class="material-symbols-outlined text-primary text-base">folder_open</span>
      <span class="font-mono text-xs text-on-surface truncate flex-1" :title="path">{{ path }}</span>
      <span class="text-[10px] text-on-surface-variant shrink-0">{{ t('component.fileBrowser.folderItems', { count: entries.length }) }}</span>
    </div>
    <div class="flex-1 overflow-auto mt-sm min-h-0">
      <p v-if="!entries.length" class="py-md text-center text-body-sm text-on-surface-variant/60">{{ t('component.fileBrowser.emptyDir') }}</p>
      <button v-for="e in entries" :key="e.name" class="fb-item w-full flex items-center gap-sm px-sm py-1.5 rounded-lg hover:bg-surface-container-low text-left transition-colors" @click="open(e)">
        <span class="material-symbols-outlined text-base shrink-0" :class="e.type === 'dir' ? 'text-primary' : 'text-on-surface-variant'">{{ e.type === 'dir' ? 'folder' : 'description' }}</span>
        <span class="font-mono text-xs truncate flex-1">{{ e.name }}</span>
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/FolderPreview.test.js`
Expected: PASS（2 用例；若因 i18n 报错，按 Step 1 说明挂 i18n 插件后应通过）

- [ ] **Step 5: 提交**

```bash
git add src/components/common/FolderPreview.vue src/components/__tests__/FolderPreview.test.js
git commit -m "feat(pod-files): FolderPreview 右栏文件夹条目列表"
```

---

## Task 6: FilePreview（右栏·文件：查看/编辑/下载/二进制/截断）

**Files:**
- Create: `src/components/common/FilePreview.vue`
- Test: `src/components/__tests__/FilePreview.test.js`

**Interfaces:**
- Consumes（inject `'fileExplorer'`）：`ctx`、`readFile(ctx,path)`、`writeFile(ctx,path,bytes)`、`download(ctx,path)`、`invalidate`。另 `import { langFor } from '@/logic/fileLang'`、`CodeViewer`、`useToast`。
- Produces：`FilePreview`（props：`path: string`）。`path` 变化 → 自动 `readFile`；查看态 `CodeViewer`（`lang=langFor(name)`）；编辑态 `<textarea>` + `[保存][取消]`；二进制→占位+下载；截断→提示条+下载。

- [ ] **Step 1: 写失败测试**

创建 `src/components/__tests__/FilePreview.test.js`：

```js
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
import { notify } from '@/composables/useToast'

function api(file) {
  return {
    ctx: { namespace: 'ns', pod: 'p', container: 'c' },
    readFile: vi.fn().mockResolvedValue(file),
    writeFile: vi.fn().mockResolvedValue(),
    download: vi.fn().mockResolvedValue(new Blob(['x'])),
    invalidate: vi.fn(),
  }
}

beforeEach(() => notify.mockReset())

test('FilePreview: 查看态渲染 CodeViewer（含内容）', async () => {
  const w = mount(FilePreview, {
    props: { path: '/a.go' },
    global: { plugins: [i18n], provide: { fileExplorer: api({ name: 'a.go', path: '/a.go', content: 'package main', truncated: false, binary: false }) } },
  })
  await flushPromises()
  expect(w.text()).toContain('package main')
  expect(w.find('pre').exists()).toBe(true)
})

test('FilePreview: 编辑→保存触发 writeFile', async () => {
  const a = api({ name: 'a.go', path: '/a.go', content: 'old', truncated: false, binary: false })
  const w = mount(FilePreview, { props: { path: '/a.go' }, global: { plugins: [i18n], provide: { fileExplorer: a } } })
  await flushPromises()
  await w.find('button.fb-edit').trigger('click')
  expect(w.find('textarea').exists()).toBe(true)
  await w.find('textarea').setValue('new content')
  await w.find('button.fb-save').trigger('click')
  await flushPromises()
  expect(a.writeFile).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalled()
})

test('FilePreview: 二进制→占位 + 下载按钮', async () => {
  const a = api({ name: 'a.bin', path: '/a.bin', content: '', truncated: false, binary: true })
  const w = mount(FilePreview, { props: { path: '/a.bin' }, global: { plugins: [i18n], provide: { fileExplorer: a } } })
  await flushPromises()
  expect(w.text()).toContain('binaryHint') // i18n 键兜底或文案
  expect(w.find('textarea').exists()).toBe(false)
})

test('FilePreview: 截断→显示提示', async () => {
  const a = api({ name: 'big.log', path: '/big.log', content: 'x'.repeat(10), truncated: true, binary: false })
  const w = mount(FilePreview, { props: { path: '/big.log' }, global: { plugins: [i18n], provide: { fileExplorer: a } } })
  await flushPromises()
  expect(w.text()).toContain('truncated')
})
```

> 同 Task 5：组件用 `useI18n()`，测试需挂 `i18n` 插件（已 `plugins: [i18n]`）。i18n 文案断言用键名/关键英文词兜底，避免依赖具体译文。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/FilePreview.test.js`
Expected: FAIL（`FilePreview is not defined` —— 测试用了未 import 的组件）

> 修正：在测试顶部加 `import FilePreview from '../common/FilePreview.vue'`（写测试时漏写则补上）。

- [ ] **Step 3: 写 FilePreview.vue**

创建 `src/components/common/FilePreview.vue`：

```vue
<script setup>
// 右栏·文件：path 变化→readFile；查看态 CodeViewer 高亮；编辑态 textarea；
// 二进制→占位+下载；截断→提示+下载。保存走 usePodFiles.writeFile。
import { ref, computed, watch, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { langFor } from '@/logic/fileLang'
import { notify } from '@/composables/useToast'
import CodeViewer from './CodeViewer.vue'

const { t } = useI18n()
const props = defineProps({ path: { type: String, required: true } })
const x = inject('fileExplorer')

const file = ref(null)        // { name, path, content, truncated, binary }
const loading = ref(false)
const error = ref('')
const editing = ref(false)
const editContent = ref('')
const saving = ref(false)

const lang = computed(() => (file.value ? langFor(file.value.name) : 'none'))
const editable = computed(() => !!file.value && !file.value.binary && !file.value.truncated)

async function load() {
  loading.value = true; error.value = ''; editing.value = false
  try {
    file.value = await x.readFile(x.ctx, props.path)
  } catch (e) { error.value = e.message || t('component.fileBrowser.readFailed') }
  finally { loading.value = false }
}
watch(() => props.path, load, { immediate: true })

function startEdit() { if (!editable.value) return; editContent.value = file.value.content; editing.value = true }
function cancelEdit() { editing.value = false }
async function saveEdit() {
  saving.value = true
  try {
    await x.writeFile(x.ctx, file.value.path, new TextEncoder().encode(editContent.value))
    notify('success', t('component.fileBrowser.saved'))
    file.value = { ...file.value, content: editContent.value }
    editing.value = false
  } catch (e) { notify('error', e.message || t('component.fileBrowser.saveFailed')) }
  finally { saving.value = false }
}
async function download() {
  try {
    const blob = await x.download(x.ctx, file.value.path)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = file.value.name; a.click(); URL.revokeObjectURL(url)
  } catch (e) { notify('error', e.message || t('component.fileBrowser.downloadFailed')) }
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <!-- 头部：路径 + 徽标 + 操作 -->
    <div class="flex items-center gap-xs pb-sm border-b border-outline-variant/40 shrink-0 pr-10">
      <span class="material-symbols-outlined text-base text-on-surface-variant shrink-0">description</span>
      <span class="font-mono text-xs truncate flex-1" :title="path">{{ file?.name || path }}</span>
      <span v-if="file?.binary" class="text-[10px] px-1 rounded bg-surface-container text-on-surface-variant shrink-0">{{ t('component.fileBrowser.binary') }}</span>
      <span v-else-if="file?.truncated" class="text-[10px] px-1 rounded bg-tertiary-container/20 text-tertiary-container shrink-0">{{ t('component.fileBrowser.truncated') }}</span>
      <button class="p-1 rounded-md text-on-surface-variant hover:text-primary hover:bg-primary/10 shrink-0" :title="t('component.fileBrowser.download')" @click="download"><span class="material-symbols-outlined text-base">download</span></button>
      <template v-if="editable && !editing">
        <button class="fb-edit flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 shrink-0" @click="startEdit"><span class="material-symbols-outlined text-sm">edit</span>{{ t('common.edit') }}</button>
      </template>
      <template v-else-if="editing">
        <button class="px-sm py-1 rounded-md border border-outline-variant text-xs text-on-surface hover:bg-surface-container shrink-0" @click="cancelEdit">{{ t('common.cancel') }}</button>
        <button class="fb-save flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary text-on-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50 shrink-0" :disabled="saving" @click="saveEdit"><span class="material-symbols-outlined text-sm">{{ saving ? 'progress_activity' : 'save' }}</span>{{ t('common.save') }}</button>
      </template>
    </div>

    <!-- 主体 -->
    <div class="flex-1 overflow-auto mt-sm min-h-0">
      <p v-if="loading" class="py-md text-center text-body-sm text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block">progress_activity</span></p>
      <p v-else-if="error" class="text-body-sm text-error py-sm flex items-center gap-xs"><span class="material-symbols-outlined text-base">error</span>{{ error }}</p>
      <template v-else-if="file">
        <!-- 截断提示 -->
        <p v-if="file.truncated" class="text-[11px] text-tertiary-container bg-tertiary-container/10 px-sm py-xs rounded mb-sm flex items-center gap-xs">
          <span class="material-symbols-outlined text-sm">warning</span>{{ t('component.fileBrowser.contentTruncated') }}
        </p>
        <!-- 二进制 -->
        <div v-if="file.binary" class="py-md text-center text-body-sm text-on-surface-variant/70 flex flex-col items-center gap-sm">
          <span class="material-symbols-outlined text-2xl">memory</span>
          <span>{{ t('component.fileBrowser.binaryHint') }}</span>
        </div>
        <!-- 查看 -->
        <CodeViewer v-else-if="!editing" :code="file.content" :lang="lang" max-height="100%" />
        <!-- 编辑 -->
        <textarea v-else v-model="editContent" class="w-full bg-code-surface text-on-code-surface p-md rounded-lg font-mono text-code-sm outline-none border border-primary/40" style="resize: none; min-height: 60vh" />
      </template>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/FilePreview.test.js`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
git add src/components/common/FilePreview.vue src/components/__tests__/FilePreview.test.js
git commit -m "feat(pod-files): FilePreview 查看/编辑/下载/二进制/截断"
```

---

## Task 7: 重写 FileBrowserBody（编排器）+ i18n 键 + 集成测试

**Files:**
- Modify (rewrite): `src/components/common/FileBrowserBody.vue`
- Modify: `src/locales/zh.json`、`src/locales/en.json`（`component.fileBrowser` 下 +5 键）
- Test: `src/components/__tests__/FileBrowserBody.test.js`

**Interfaces:**
- Consumes：Task 2 的 `usePodFiles`、Task 4-6 的子组件、`SplitPane`、`useToast`、`podFileApi`。
- Produces：`FileBrowserBody`（props 不变：`namespace/pod/container`；根 `h-full min-h-0`）。`provide('fileExplorer', { ctx, selected, isExpanded, isLoading, childrenOf, selectNode, toggleNode, readFile, writeFile, download, dirCache })`。

**新增 i18n 键**（zh.json 与 en.json 的 `component.fileBrowser` 对象内追加）：

| key | zh | en |
|-----|----|----|
| `emptyHint` | 选择左侧的文件或文件夹查看内容 | Select a file or folder on the left to view |
| `folderItems` | {count} 项 | {count} items |
| `binaryHint` | 二进制文件不提供预览，可下载查看 | Binary file — preview unavailable, download to view |
| `collapse` | 折叠 | Collapse |
| `expand` | 展开 | Expand |

> 复用既有键：`common.sync`（刷新）、`common.edit/save/cancel/loading`、`component.fileBrowser.upload/uploaded/uploadFailed/saved/emptyDir/download` 等。

- [ ] **Step 1: 写失败测试**

创建 `src/components/__tests__/FileBrowserBody.test.js`：

```js
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  podFileApi: {
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    download: vi.fn(),
  },
}))
import { podFileApi } from '@/api/client'
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

let _ls
beforeEach(() => {
  _ls = globalThis.localStorage
  const mem = new Map()
  globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), clear: () => mem.clear() }
  podFileApi.list.mockReset(); podFileApi.read.mockReset(); podFileApi.write.mockReset(); podFileApi.download.mockReset()
})
afterEach ? null : null
import FileBrowserBody from '../common/FileBrowserBody.vue'

test('FileBrowserBody: 挂载加载根；点文件→FilePreview；点文件夹→FolderPreview', async () => {
  podFileApi.list.mockResolvedValue({ entries: [{ name: 'app', type: 'dir' }, { name: 'readme.md', type: 'file' }] })
  podFileApi.read.mockResolvedValue({ path: '/readme.md', content: '# hi', truncated: false, binary: false })
  const w = mount(FileBrowserBody, { props: { namespace: 'ns', pod: 'p', container: 'c' }, global: { plugins: [i18n] } })
  await flushPromises()
  expect(w.text()).toContain('app')
  expect(w.text()).toContain('readme.md')
  // 点文件
  const fileRow = w.findAll('.fb-row').filter(r => r.text().includes('readme.md'))[0]
  await fileRow.trigger('click')
  await flushPromises()
  expect(podFileApi.read).toHaveBeenCalledWith(expect.objectContaining({ path: '/readme.md' }))
  // 点文件夹
  const dirRow = w.findAll('.fb-row').filter(r => r.text().includes('app'))[0]
  await dirRow.trigger('click')
  await flushPromises()
  expect(w.text()).toContain('app') // FolderPreview 头部仍含路径
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/FileBrowserBody.test.js`
Expected: FAIL（旧 FileBrowserBody 没有 `.fb-row` / 新结构）

- [ ] **Step 3: 追加 i18n 键**

编辑 `src/locales/zh.json` 与 `src/locales/en.json`：在 `component.fileBrowser` 对象内追加上表 5 个键（保持 JSON 合法、逗号正确）。

- [ ] **Step 4: 重写 FileBrowserBody.vue**

整体替换 `src/components/common/FileBrowserBody.vue`：

```vue
<script setup>
// Pod 文件浏览（VSCode 式）：左懒加载树 + 右上下文区（文件夹/文件）。
// 编排器：持有 selected/expanded，provide('fileExplorer') 给子树，复用 usePodFiles。
// props 契约不变（namespace/pod/container），根 h-full min-h-0 供 SplitPane 取尺寸。
import { ref, computed, provide, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { notify } from '@/composables/useToast'
import { usePodFiles } from '@/composables/usePodFiles'
import SplitPane from './SplitPane.vue'
import FileTree from './FileTree.vue'
import FolderPreview from './FolderPreview.vue'
import FilePreview from './FilePreview.vue'

const { t } = useI18n()
const props = defineProps({
  namespace: { type: String, default: '' },
  pod: { type: String, default: '' },
  container: { type: String, default: '' },
})

const files = usePodFiles()
const selected = ref(null)            // path | null
const selectedIsDir = ref(false)
const expanded = ref(new Set())
const fileInput = ref(null)

const ctx = computed(() => ({ namespace: props.namespace, pod: props.pod, container: props.container }))
const k = path => `${props.container || ''}::${path}`

function childrenOf(path) { return files.dirCache.value.get(k(path)) || [] }
function isExpanded(path) { return expanded.value.has(path) }
function isLoading(path) { return files.inflight.value.has(k(path)) }
function selectNode(path, isDir) { selected.value = path; selectedIsDir.value = isDir }
async function toggleNode(path) {
  if (expanded.value.has(path)) {
    const s = new Set(expanded.value); s.delete(path); expanded.value = s; return
  }
  if (!files.dirCache.value.has(k(path))) {
    try { await files.listDir(ctx.value, path) } catch {}
  }
  const s = new Set(expanded.value); s.add(path); expanded.value = s
}

provide('fileExplorer', {
  ctx, selected, isExpanded, isLoading, childrenOf, selectNode, toggleNode,
  readFile: files.readFile, writeFile: files.writeFile, download: files.download, dirCache: files.dirCache,
})

// 上传：写入到「当前选中文件夹」或其父目录
function joinPath(d, n) { return d.endsWith('/') ? d + n : d + '/' + n }
function parentDir(path) { if (path === '/' || !path) return '/'; const p = path.split('/').filter(Boolean); p.pop(); return p.length ? '/' + p.join('/') : '/' }
function pickUpload() { fileInput.value?.click() }
async function onUpload(e) {
  const f = e.target.files?.[0]; if (!f) return
  const dir = selectedIsDir.value ? selected.value : (selected.value ? parentDir(selected.value) : '/')
  const target = joinPath(dir, f.name)
  try {
    await files.writeFile(ctx.value, target, new Uint8Array(await f.arrayBuffer()))
    notify('success', t('component.fileBrowser.uploaded', { name: f.name, size: f.size }))
    await files.listDir(ctx.value, dir, { force: true })
  } catch (err) { notify('error', err.message || t('component.fileBrowser.uploadFailed')) }
  finally { e.target.value = '' }
}

async function refresh() {
  await files.listDir(ctx.value, '/', { force: true }).catch(() => {})
  for (const p of expanded.value) await files.listDir(ctx.value, p, { force: true }).catch(() => {})
}

onMounted(() => { if (props.namespace && props.pod) files.listDir(ctx.value, '/').catch(() => {}) })
// 换容器：清该容器缓存 + 重置选中/展开 + 重拉根
watch(() => props.container, (c) => {
  files.resetForContainer(c)
  selected.value = null; selectedIsDir.value = false; expanded.value = new Set()
  if (props.namespace && props.pod) files.listDir(ctx.value, '/').catch(() => {})
})
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- 工具条 -->
    <div class="flex items-center gap-xs pb-sm border-b border-outline-variant/40 shrink-0">
      <button class="p-1 rounded-md text-on-surface-variant hover:bg-surface-container" :title="t('common.sync')" @click="refresh">
        <span class="material-symbols-outlined text-base" :class="files.inflight.value.size ? 'animate-spin' : ''">refresh</span>
      </button>
      <span class="font-mono text-xs text-on-surface-variant truncate flex-1">{{ selected || '/' }}</span>
      <button class="flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 shrink-0" :title="t('component.fileBrowser.uploadToDir')" @click="pickUpload">
        <span class="material-symbols-outlined text-sm">upload</span>{{ t('component.fileBrowser.upload') }}
      </button>
    </div>

    <!-- 主体：左树 | 右上下文 -->
    <div class="flex-1 min-h-0 mt-sm">
      <SplitPane storage-key="pod-file-explorer-split" :default-split="0.32">
        <template #first>
          <FileTree />
        </template>
        <template #second>
          <div v-if="!selected" class="h-full flex items-center justify-center text-body-sm text-on-surface-variant/60 px-lg text-center">
            {{ t('component.fileBrowser.emptyHint') }}
          </div>
          <FolderPreview v-else-if="selectedIsDir" :path="selected" />
          <FilePreview v-else :key="selected" :path="selected" />
        </template>
      </SplitPane>
    </div>

    <input ref="fileInput" type="file" class="hidden" @change="onUpload">
  </div>
</template>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/FileBrowserBody.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/components/common/FileBrowserBody.vue src/locales/zh.json src/locales/en.json src/components/__tests__/FileBrowserBody.test.js
git commit -m "feat(pod-files): FileBrowserBody 重写为 VSCode 式树+上下文双栏(+i18n 键)"
```

---

## Task 8: 全量门禁 + 手测说明

**Files:** 无新文件（验证型任务）

- [ ] **Step 1: 全量单测**

Run: `npm run test:unit`
Expected: 全绿（含本特性 7 个新测试文件 + 既有套件）

- [ ] **Step 2: 语法/类型基线**

Run: `npm run typecheck`
Expected: PASS（`node --check` 全 `.js/.mjs`）

- [ ] **Step 3: i18n 门禁**

Run: `npm run i18n:check`
Expected: PASS（无残存中文、键对齐、无缺失键）

- [ ] **Step 4: 生产构建（覆盖 .vue 编译）**

Run: `npm run build`
Expected: 构建成功，无 Vue 模板编译错误

- [ ] **Step 5: 手测说明（无法自动化的真实 K8s 交互）**

本地起服务后（`npm run dev` + 后端），在 Pod 详情 Files 标签与 Deployment 概览「文件」弹窗验证：
1. 左树出现根目录条目；点文件夹 `▸` 懒加载展开子项；再点折叠。
2. 点文件夹名 → 右栏出现该文件夹条目列表（`FolderPreview`），头部显示 `{count} 项`。
3. 点文件 → 右栏出现高亮内容（验证 `.go`/`.yaml`/`.md` 等着色）；截断文件显示提示条；二进制文件显示占位 + 下载。
4. 编辑文本文件 → 改 → 保存 → 回查看态内容已更新；树/列表刷新。
5. 上传文件 → 出现在当前文件夹列表；下载按钮可用。
6. 拖动 SplitPane 分割条 → 比例持久化（刷新仍在）。
7. 多容器 Pod 切容器 → 树重置、选中清空、右栏回空状态提示。

- [ ] **Step 6: 提交（如有门禁修复）**

```bash
git add -A
git commit -m "test(pod-files): 全量门禁通过(typecheck/build/i18n/test:unit)" || echo "无需提交"
```

---

## Self-Review（spec 覆盖核对）

- spec §2 目标 1（双栏懒加载树）→ Task 4 + 7 ✓
- spec §2 目标 2（Prism 高亮、程序员后缀）→ Task 1（映射）+ 3（语言集）+ 6（接入）✓
- spec §2 目标 3（保留上传/下载/编辑）→ Task 6（编辑/下载）+ 7（上传）✓
- spec §2 目标 4（零新依赖）→ 全程仅 prismjs 既有 + 原生 textarea ✓
- spec §2 目标 5（两消费方自动获益，props 契约不变）→ Task 7 保持 props + 根 `h-full` ✓
- spec §3 复用契约（podFileApi / SplitPane / CodeViewer）→ 各 Task Interfaces 已注 ✓
- spec §6 数据流（挂载/展开/选中/编辑/上传/换容器）→ Task 7 编排器实现 + Task 2 缓存失效 ✓
- spec §7 错误/边界（list/read/write 失败、413、空、二进制、截断）→ Task 6/7 覆盖 ✓
- spec §8 决策（v1 无 size、二进制信任服务端、textarea 编辑、selected=null 初值）→ Task 1/2/6/7 一致 ✓
- spec §9 测试策略（纯逻辑 + 缓存契约 + 组件冒烟 + 门禁）→ Task 1/2/3/4/5/6/7/8 ✓
- 类型一致性：`Entry={name,type}`、`ctx={namespace,pod,container}`、inject key `'fileExplorer'`、`usePodFiles` 返回名在各 Task 间一致 ✓
- 无占位符：所有步骤含真实代码 / 真实命令 ✓
