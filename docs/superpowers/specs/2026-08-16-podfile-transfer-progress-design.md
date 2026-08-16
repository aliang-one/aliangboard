# 容器文件传输进度化 + 文件浏览窗口化 设计文档

日期:2026-08-16
状态:已与用户逐节确认(brainstorming 三部分均获批准)
分支:worktree-feat-podfile-transfer

## 背景与目标

容器文件浏览的传输体验现状:

- **下载**:前端一次性 `response.blob()`(无进度);网关 `exec cat` 整文件驻内存后一次发出,硬编码 16MB 上限。
- **上传**:整文件读入内存 → base64(膨胀 33%)→ JSON body → exec stdin,无进度。
- **文件浏览入口**:PodCard 文件夹按钮跳转详情页;仅 NsWorkloadDetail 用 Modal;详情页内嵌。无最小化/任务栏集成。

目标(用户已确认的裁决):

1. 下载采用 **fetch 流式读取 + 内存累积 + 完成即 Blob 落盘**——应用内看进度,完成瞬间浏览器下载栏出现完整文件(否决 File System Access API 渐进增强,保持全浏览器兼容)。
2. 上传新增 **二进制流式端点**(XHR `upload.onprogress` 真进度,不经 base64)。
3. 大小上限放开到 **1GB 且全局可配**(Settings admin 区,`platform_settings` 键),超限给用户清晰提示。
4. 文件浏览遵循终端逻辑:**PodCard 等入口开浮动窗口,详情页保持内嵌**;窗口可关闭/最小化,最小化后再打开状态同步;**照终端一样 SQLite 持久化,刷新后任务栏恢复**。
5. 底部任务栏扩展为三分区(终端/文件窗口/传输),**传输区显示百分比**,点击打开 TransfersPanel。

## 架构总览

```
AppLayout
├─ TerminalTaskbar(三分区:终端 | 文件窗口 | 传输区汇总)
├─ TerminalWindow × N   ←── 重构为 FloatingWindow 壳 + InteractiveTerminal
├─ FileBrowserWindow × N ←── FloatingWindow 壳 + FileBrowserBody(懒加载)
└─ TransfersPanel       ←── FloatingWindow 壳 + 任务列表(ProgressBar 复用)

stores/transfers.js(内存态,fetch/XHR 跑在 store 里,与组件生命周期解耦)
stores/fileBrowsers.js(照 terminals 平行,SQLite file_browsers 表 + CRUD)
api/http.js:downloadStream / uploadBinary 原语(统一 auth/401)
server/podfile-stream.mjs(纯逻辑,注入 openConn,可测)
server/index.mjs:download 流式 / upload 二进制端点 / admin podfile-config
```

## 1. 服务端改动(server/index.mjs + server/podfile-stream.mjs)

### 1.1 下载流式(改造 /api/podfile/download)

```
① exec wc -c < path        → 文件大小;失败 → 404(响应头未发)
② 大小 > limitMb*1024*1024 → 413 {message 含限额与「设置→文件传输」提示}
③ res.writeHead(200, { content-length, content-disposition, CORS 头(照旧) })
④ exec cat path → stdout 直接 pipe 到 res(网关只持块缓冲)
```

- 网关内存从「整个文件」降为流缓冲;删除 `PODFILE_DOWNLOAD_LIMIT` 16MB 硬编码。
- 中断流(pod 死/exec 断):`res.destroy()`。
- 编排逻辑抽到 `server/podfile-stream.mjs`,以 `openConn(stdoutSink, stderrSink, stdin)` 注入 seam(照 `exec-bounds.mjs`/`runBoundedCollect` 模式),node --test 可测。

### 1.2 二进制流式上传(新增 POST /api/podfile/upload)

- 元信息走查询串:`?namespace=&pod=&container=&path=`;请求体 = 原始文件字节。
- 先查 `content-length` vs 限额:缺失 → 411;超限 → 413。均不启动 exec。
- `req`(Readable)pipe 到 exec stdin(`sh -c 'cat > "$1"'`,argv 传 path 防转义)。
- exec 结束:stderr 非空且无写入 → 4xx/502;成功 → `{ok, path, bytes}`。
- 原 `/api/podfile/write`(base64)保留不动——wb_* 工具链等内部依赖。

### 1.3 限额设置(照 mcp-config 模式)

- `platform_settings` 新键 `podfile.limitMb`,默认 1024。
- `GET/PUT /api/admin/podfile-config` → `{limitMb}`,admin 鉴权(platform_settings 现有 getSetting/setSetting)。
- Settings 页新增 admin 可见 tab「文件传输」:数字输入(MB)+ 保存。
- 限额对下载(stat 结果)与上传(content-length)统一生效。

## 2. 前端传输原语(src/api/http.js)

`createHttp` 增加两个原语,与 request/blob 共用 authHeaders/onUnauthorized:

```js
downloadStream(path, { body, onProgress, signal })
// fetch POST → res.body.getReader() 逐块读,累计 received
// onProgress({ received, total })   total 来自 content-length(缺失 → 0)
// 完成 → new Blob(chunks, {type}) 返回;非 2xx 抛带 .status 的 Error

uploadBinary(path, file, { onProgress, signal })
// XHR(fetch 无上传进度);upload.onprogress → onProgress({received, total})
// signal.abort() → xhr.abort();完成解析 JSON 响应,非 2xx 抛错
```

## 3. 传输任务 store(src/stores/transfers.js,内存态)

```js
task = {
  id, kind: 'download' | 'upload',
  name, namespace, pod, container, path,
  received, total,                    // 字节;total=0 → 不确定态
  status: 'active' | 'done' | 'error' | 'canceled',
  error, startedAt, finishedAt, speed, // speed 滑动窗口 EMA
}
```

- `startDownload(ctx, path)`:建任务 → `downloadStream` 驱动 received → 完成后 Blob + `a.download` 落盘(浏览器下载栏瞬间出现完整文件)→ `URL.revokeObjectURL`。
- `startUpload(ctx, dir, file)`:建任务 → `uploadBinary` → 任务记录 `{container, dir}`。
- **目录刷新机制**(usePodFiles 是每个 FileBrowserBody 各自实例化,store 无法直达缓存):任务完成时置 `finishedAt`;每个 FileBrowserBody(浮窗+详情页内嵌)watch transfers store,发现「同 namespace/pod/container 且刚完成」的上传任务 → 对自己 dirCache 里该 dir `listDir(force:true)`。
- `cancel(id)`(AbortController / xhr.abort)、`remove(id)`、`clearFinished()`。
- **与组件生命周期解耦**:跑在 store 里,关窗口/切页面不中断;刷新即清(fetch 无法幸存,已确认接受,不做持久化)。
- 同名重复下载允许并发;上传取消后容器内可能残留部分写入文件(与现有行为一致,不做 rm——覆盖场景误删更危险)。

## 4. 通用浮动窗口壳(src/components/common/FloatingWindow.vue)

从 TerminalWindow 提取:

```js
props: { title, subtitle, icon, zIndex, width='720px', height='460px' }
emits: ['focus', 'minimize', 'close']
slots: default(窗体)、title-actions(标题栏右侧扩展)
```

内置:标题栏拖拽(初始位置级联 `80 + n*30`)、双击标题或按钮最大化/还原、最小化/关闭按钮、z-index 置顶。**TerminalWindow 重构为壳 + InteractiveTerminal**,行为不变,需回归(拖拽/改名/最大化/最小化/新标签页)。

## 5. 文件浏览窗口(src/stores/fileBrowsers.js + FileBrowserWindow.vue)

- session:`{ id, name: `${pod}/${container}`, namespace, podName, container, status: 'open'|'minimized', zIndex, createdAt }`。
- `openBrowser({namespace, podName, container})`:同 pod+container 去重 → 聚焦置顶。
- SQLite 新表 `file_browsers` + `/api/file-browsers` CRUD(GET/POST/PATCH/DELETE,按 sessionToken 隔离)——与 terminals 端点同构;刷新后恢复为 minimized。
- AppLayout 挂 `FileBrowserWindow`(defineAsyncComponent 懒加载)`v-for + v-show="status==='open'"`——**最小化保 DOM 挂载,树展开/选中/滚动天然同步**。
- 窗口内容器固定(opener 传入,不在窗口内切换)。

### 入口改造

| 入口 | 现状 | 改为 |
|---|---|---|
| PodCard 文件夹按钮 | `goPodTab('#files')` 跳详情页 | `fileBrowsers.openBrowser(...)` 浮窗 |
| NsWorkloadDetail | FileBrowser Modal | `openBrowser(...)`;删除 FileBrowser.vue |
| PodDetail Files tab | 内嵌 FileBrowserBody | 不动 |

## 6. 任务栏三分区(TerminalTaskbar.vue 扩展)

```
[全部关闭] │ <终端项…> │ <文件窗口项…> │ <传输区>              N 个会话
```

- 文件窗口项:folder 图标 + 名称,点击恢复/聚焦,hover 出关闭(同终端)。
- 传输区(有任务才显示):
  - 单任务:`↓ name 42%`(spinner 进行中 / ✓ 完成 / ! 失败)
  - 多任务:`⇅ 传输 2/3 · 67%`(完成数/总数;总进度按字节加权,total=0 的不确定态任务只计入个数、不计入百分比)
  - 点击 → TransfersPanel:任务列表 = 名称 + 方向图标 + ProgressBar + `12.4 MB / 30 MB · 8.2 MB/s` + 取消(进行中)/移除(已结束) + clearFinished。
- 「全部关闭」只作用于终端/文件窗口;传输区清理在 TransfersPanel 内。

## 7. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 下载:文件不存在/无权限 | stat 先行 → 404(头部未发);任务 error |
| 超限额 | 413;message:文件大小 + 当前限额 + 「管理员可在 设置→文件传输 调整」 |
| 下载中断流 | res.destroy();客户端任务 error,丢弃半成品 Blob |
| 上传取消/中断 | 销毁 exec;容器内可能残留部分文件(已知行为);任务 canceled |
| 传输中 401 | onUnauthorized 跳登录;任务 error |
| 无 content-length(防御) | 不确定态:已收字节 + spinner,无百分比 |
| 刷新页面 | 传输全灭;文件/终端窗口 SQLite 恢复为最小化 |

## 8. 测试策略

- **服务端 node --test**(server/podfile-stream.test.mjs,fake conn/streams 照 exec-bounds 模式):
  stat 失败不写头 / 超限 413 / 流式逐块转发 / 中断 destroy;upload:411/413 / pipe 完成 / req 中断清理。
- **前端 vitest**:transfers store(进度/速度/取消/状态机/汇总)、FloatingWindow(事件/拖拽)、Taskbar 传输区(单任务 %、多任务汇总)、fileBrowsers store(去重聚焦)。
- **手测清单**(真集群,用户执行):>100MB 下载进度、取消重下、大文件上传、刷新恢复窗口、限额修改生效。
- 门禁:`npm test`、`npm run test:unit`、`npm run typecheck`、`npm run i18n:check`(新文案 en/zh 双语)。

## 9. 改动清单与实现顺序

**新增**:`FloatingWindow.vue`、`FileBrowserWindow.vue`、`TransfersPanel.vue`、`stores/fileBrowsers.js`、`stores/transfers.js`、`server/podfile-stream.mjs(+test)`、http 原语(+test)、admin podfile-config 端点、Settings tab、i18n 键。
**修改**:`TerminalWindow.vue`(包壳)、`TerminalTaskbar.vue`(三分区)、`PodCard.vue`、`NsWorkloadDetail.vue`、`AppLayout.vue`、`server/index.mjs`(download/upload/file_browsers CRUD)、`client.js`。
**删除**:`FileBrowser.vue`。

**顺序**(依赖驱动):① podfile-stream + 服务端端点 → ② http 原语 + transfers store → ③ FloatingWindow 抽壳 + 终端回归 → ④ fileBrowsers store + 窗口/入口 → ⑤ 任务栏 + TransfersPanel → ⑥ Settings 限额 + i18n 收尾。

全程在 worktree 分支 `worktree-feat-podfile-transfer` 开发。

## 已否决的备选

- File System Access API 渐进增强(用户选全兼容的 fetch+Blob)。
- 统一「工作区窗口」系统重构 term+files 合一 store(动稳定终端代码,风险收益比不划算;用户选方案 A)。
- 仅前端换 XHR 拿 base64 进度(用户选二进制流式端点)。
- 传输任务 SQLite 持久化(fetch 无法幸存刷新,无意义)。
- 上传取消后 rm 清理残留(覆盖场景误删原文件,更危险)。
