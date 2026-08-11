# Pod 文件查看器 —— VSCode 式重构设计

- 日期：2026-08-11
- 分支：`feat/pod-file-explorer`（worktree：`.claude/worktrees/pod-file-explorer`，基于本地 `main` @ `1059e83`）
- 类型：前端 UX 重构（原地重写 `FileBrowserBody`，新增若干聚焦组件），后端 `/api/podfile/*` 不变
- 依赖政策：**不新增依赖**（复用已登记的 `prismjs`；编辑态用原生 `<textarea>`）

## 1. 背景与问题

现有 Pod 文件浏览（`src/components/common/FileBrowserBody.vue`，171 行）是**单视图扁平列表**：

- 选中文件后**整屏替换**为 `<pre>` 纯文本（**无语法高亮**），看不到目录上下文；
- 左侧无目录树，只有顶部面包屑逐级进入；
- 工具能力齐备（list/read/write/upload/download/在线编辑）但呈现「单调」。

用户期望：左侧可展开的**文件目录树**，右侧**内容区**——选中文件夹显示该文件夹条目列表，选中文件加载内容并支持程序员常用后缀的语法高亮。保留全部现有编辑能力（上传/下载/在线编辑/保存）。

## 2. 目标 / 非目标

**目标**

1. 双栏布局：左 = 懒加载嵌套目录树；右 = 上下文区（文件夹→条目列表；文件→高亮内容）。
2. 文件查看态用 Prism 语法高亮，覆盖程序员常用后缀（见 §5）。
3. 保留现有全部能力：上传、下载、在线编辑保存（编辑态 `<textarea>`，不高亮）。
4. 零新依赖；复用 `SplitPane` / `CodeViewer` / `code-theme` / `Modal`。
5. 两个消费方（Pod 详情 Files 标签、Deployment 概览 `FileBrowser` 弹窗）自动获得新 UI——保持 `FileBrowserBody` 的 props 契约 `namespace/pod/container` 不变。

**非目标（v1 不做）**

- 编辑态实时语法高亮（需引入 Monaco/CodeMirror，违反依赖政策；后续按需走 eng-review）。
- 目录条目大小/修改时间展示（见 §8「已澄清的取舍」）。
- 多标签页编辑器、文件搜索、Git diff 等 VSCode 高级特性。
- Vue Query 迁移（数据层重构进行中；本设计的 `usePodFiles` composable 预留为后续替换点，见 §10）。

## 3. 已核实的现有契约（重构基础）

**`podFileApi`（`src/api/client.js`）**——全部复用，签名不变：

| 方法 | 入参 | 返回 |
|------|------|------|
| `list` | `{namespace, pod, container, path}` | `{ path, entries: [{ name, type: 'dir'\|'file' }] }` |
| `read` | `{..., path}` | `{ path, content(utf8), truncated, binary }` |
| `write` | `{..., path, data(base64)}` | `{ ok, path, bytes }` |
| `download` | `{..., path}` | `Blob`（>16MB 时后端返 413） |

**后端（`server/index.mjs` `/api/podfile/*`）不变**，要点：

- `list`：`ls -1Ap` 解析为 `{name, type}`，**无 size/mtime**；`-A` 跳过 `.`/`..`，`-p` 给目录名加尾 `/`。
- `read`：`head -c` 截断到 `PODFILE_PREVIEW_LIMIT = 256KB`；`truncated = 超限`；`binary = stdout 含 NUL 字节`（**服务端探测，前端直接信任此标志**）。
- `download`：`cat` 全量，上限 `PODFILE_DOWNLOAD_LIMIT = 16MB`。

**组件契约**

- `FileBrowserBody.vue`：props `namespace/pod/container`（String）。根元素 `h-full min-h-0`，必须保持（`SplitPane` 需有尺寸的父容器）。
- `FileBrowser.vue`（弹窗壳）：透传三 props，给 `FileBrowserBody` 套 `style="height: 62vh"`。本设计不动它。
- `CodeViewer.vue`：props `code/lang/maxHeight`；Prism 懒加载，`lang` 须是 Prism 语言 id（如 `yaml`/`json`/`javascript`）。
- `SplitPane.vue`：必填 `storageKey`；具名 slot `first`/`second`；右上角有浮动「方向切换」按钮（见 §6 与右栏工具条的避让）。

## 4. 架构：组件分解（Approach A）

`FileBrowserBody` 重写为薄编排层，组合以下聚焦单元（均位于 `src/components/common/`，composable 位于 `src/composables/`）：

| 文件 | 状态 | 职责 |
|------|------|------|
| `FileBrowserBody.vue` | **重写** | 编排器。持有 `selected`（当前选中路径，文件或文件夹；初值 `null`）、`expanded`（`Set<path>`）、`container`。watch `container` 变化 → 调 `usePodFiles.resetForContainer()` 并重置 selected/expanded、重拉根。渲染：顶部工具条（容器选择器沿用 PodDetail 外置；上传/刷新按钮）+ `SplitPane(树 \| 上下文)`。`provide` 文件上下文供树注入。保持 props 契约。 |
| `FileTree.vue` | 新增 | 左栏容器。从根 `/` 起，把根 entries 喂给 `FileTreeNode` 递归渲染。空/加载/错误态。 |
| `FileTreeNode.vue` | 新增（递归） | 单条目。文件夹：`▸` 点击 → emit 请求展开/折叠（未缓存则触发 `listDir`）；点名称 → `select(dir)`。展开时递归渲染子 `FileTreeNode`。文件：点击 → `select(file)`。选中态高亮。通过 `inject` 拿上下文（selected/expanded/handlers/dirCache），避免深层 prop 透传。 |
| `FolderPreview.vue` | 新增 | 右栏（选中文件夹）。展示该文件夹 entries（图标 + 名称 + 类型；**v1 无 size**）。点条目 → emit `open(path, isDir)`。复用树已加载的同一份 listing（`dirCache`）。 |
| `FilePreview.vue` | 新增 | 右栏（选中文件）。查看态：`CodeViewer`（按扩展名选 lang）+ 工具按钮 `[下载][编辑]`；截断/二进制提示条。编辑态：等宽 `<textarea>`（行号可选）+ `[保存][取消]`，复用现有 `writeBytes`（base64→`podFileApi.write`）。保存成功 → emit `saved`（编排器 invalidate + 重读，回到查看态）。二进制 → 占位 + 仅下载。 |
| `usePodFiles.js` | 新增（composable） | 数据层。封装 `podFileApi.list/read/write/download`；内存缓存 `dirCache: Map<container:path, entries>` 与 `fileCache: Map<container:path, {content,truncated,binary}>`；`invalidate(path)`（写/上传后）、`resetForContainer()`（换容器）。暴露 `loading/error` refs。所有调用按 `container:path` 复合键，天然隔离多容器。 |
| `fileLang.js` | 新增（`src/utils/`） | 纯函数：`langFor(filename) → Prism 语言 id`、`isHighlightable(filename)`。仅做扩展名→语言映射，**不做**二进制判定（二进制信任服务端 `binary` 标志）。 |
| `CodeViewer.vue` | **微调** | 扩展 Prism 语言懒加载表（增加 go/rust/java/c/cpp/cs/sql/css/markup/dockerfile/makefile/diff/graphql 等，见 §5）。无新依赖。 |

**不变**：`FileBrowser.vue`、`PodDetail.vue`（Files 标签）、`client.js`、`server/`。

## 5. 语法高亮覆盖（`fileLang.js` + `CodeViewer` 扩展）

`fileLang.js` 维护扩展名 → Prism 语言 id 映射，未命中 → `'none'`（`CodeViewer` 已处理 `none`/无 grammar 退化为纯文本）：

- 配置类：`yaml`(yml/yaml) · `json`(json) · `toml` · `ini`(ini/cfg/conf) · `properties`
- 脚本/语言：`bash`(sh) · `python`(py) · `javascript`(js/mjs/cjs) · `typescript`(ts) · `go` · `rust`(rs) · `java` · `c` · `cpp`(cc/cpp/cxx/h/hpp) · `csharp`(cs) · `sql` · `php` · `ruby`(rb)
- Web/标记：`markup`(html/htm/xml/svg/rss) · `css` · `markdown`(md) · `graphql`
- 运维：`dockerfile`(Dockerfile) · `makefile`(mk/Makefile) · `diff`(patch) · `nginx`(conf, 启发式) · `gitignore`（纯文本兜底）

`CodeViewer.vue` 在现有懒加载块中追加对应 `import('prismjs/components/prism-<id>')`（注意 Prism 依赖关系：如 `cpp` 依赖 `c`，`typescript` 依赖 `javascript`，需按序 import；Prism 组件 import 即注册 `Prism.languages[<id>]`）。各语言按需懒加载，首屏成本不变，新增语言仅在首次命中时加载。

## 6. 数据流

```
挂载 → listDir('/') 缓存根；selected = null → 右栏空状态提示
▸ 展开文件夹 → 若 dirCache 未命中则 listDir(path) → 加入 expanded → 子节点渲染
点文件夹名 → selected = path（dir）→ 右栏 FolderPreview（读 dirCache[path]，命中即免请求）
点文件（树内或 FolderPreview 内）→ selected = path（file）→ 右栏 FilePreview → readFile(path)（命中 fileCache 免请求）→ CodeViewer
  编辑 → textarea 预填 content → 保存 writeBytes → writeFile → invalidate(file.path) + invalidate(其父目录) → 重读 → 查看态
  下载 → podFileApi.download(blob) → anchor 另存
  二进制 → 占位文案 + [下载]
  截断 → 顶部提示「>256KB 已截断，建议下载」+ [下载]
上传（工具条）→ 写入 selected 所在文件夹（selected 为文件夹即其本身，为文件即其父目录）→ invalidate 该目录 → 树 + FolderPreview 刷新
换容器（props.container 变）→ resetForContainer()：清 dirCache/fileCache、selected=null、expanded=Set()、重拉 '/'
```

**SplitPane 避让**：`storageKey="pod-file-explorer-split"`，`defaultDirection="horizontal"`，`defaultSplit≈0.32`（树窄、内容宽，贴近 VSCode）。`SplitPane` 右上角浮动「方向切换」按钮会与右栏工具条 `[下载][编辑]` 区域重叠 → 右栏工具条在右上预留 `pr-8` 让位（或固定把方向切换藏掉，仅水平模式——见 §11 待定）。

## 7. 错误处理 / 边界

- `list` 失败：对应树节点（或左栏）内联红字 + 重试。后端 404（路径不存在）单独文案。
- `read` 失败：FilePreview 内联错误，保留选中态可回退。
- `write`/上传失败：停留编辑态、toast 报错、保住输入。
- 下载 413（>16MB）：toast 提示「请在终端中下载」。
- 空目录 / 空状态：友好文案。
- 选中态丢失：换容器/重置后 selected=null，右栏回空状态提示。

## 8. 已澄清的取舍（决策记录）

1. **范围 = 浏览 + 保留全部编辑**（用户裁决）。编辑态用 `<textarea>` 不高亮（用户裁决，避免新依赖）。
2. **交互模型 = 懒加载树 + 双栏上下文**（用户裁决，见 §4/§6）。
3. **v1 FolderPreview 不显示文件大小**：`/api/podfile/list` 用 `ls -1Ap` 仅给 `{name,type}`；跨容器 shell（busybox vs coreutils）可移植地取 size/mtime 脆弱（`ls -l` 解析受文件名空格影响、`stat`/`find -printf` 在 busybox 不可用）。权衡后 v1 不做，列入 §10 未来项。**这是与展示给用户的示意 mockup（含 "1.2 KB"）的已知偏差**，已显式记录。
4. **二进制判定信任服务端**（NUL 字节探测），不再前端按扩展名猜；`fileLang.js` 只管语言映射。
5. **默认 selected=null**（右栏空状态提示，贴近 VSCode「未打开编辑器」），而非默认选中根目录。

## 9. 测试策略

遵循 `CLAUDE.md`：纯逻辑优先自研零依赖运行器/`node --test`，组件交互用 vitest。

- **纯逻辑（`node --test` 或 vitest）**
  - `fileLang.js`：`langFor` 全扩展名覆盖 + 未命中→`'none'`；大小写不敏感（`.YAML`/`.Dockerfile`）。
  - `usePodFiles.js`：mock `podFileApi`，验证 dirCache/fileCache 命中免请求、`invalidate` 清除指定键、`resetForContainer` 清全部、复合键 `container:path` 隔离。
- **组件冒烟（vitest + happy-dom + @vue/test-utils）**
  - `FileBrowserBody`：挂载渲染左树；点文件夹 → 右栏出现 FolderPreview；点文件 → 右栏出现 FilePreview 并触发 read。
  - `FilePreview`：查看态渲染 CodeViewer；切换编辑/保存/取消；二进制/截断分支。
- **基线**：`npm run typecheck`（`node --check` 全 .js/.mjs）+ `npm run build`（.vue 编译）+ `npm run i18n:check` 必过。

## 10. 未来增强（显式 out-of-scope）

- 目录条目 size/mtime（需可移植 shell 探测或后端结构化接口）。
- 编辑态实时高亮（引入 CodeMirror 6 / Monaco，须 eng-review 登记新依赖）。
- 数据层切 Vue Query：`usePodFiles` 内部换成 `useQuery`/`useMutation`，组件 props/events 不变——这是预留的替换点。
- 多文件标签页、文件内搜索、路径复制。

## 11. 待实现时确认的小决策（不阻塞本 spec）

- `SplitPane` 方向切换按钮：保留 vs 仅水平（避免与右栏工具条重叠）。倾向：保留但在右栏工具条留 `pr-8` 让位。
- `FileTreeNode` 缩进：按深度 `padding-left: depth * 14px`（贴近 VSCode）。
- 编辑态行号：v1 可不做（textarea + 等宽即可），如做用纯 CSS 计数器或最小行号槽。
