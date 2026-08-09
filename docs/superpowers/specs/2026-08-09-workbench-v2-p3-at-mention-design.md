# 工作台 V2 P3 — @-mention + 资源搜索

- 日期:2026-08-09
- 分支:`feat/workbench-v2-p1`(worktree)
- 状态:APPROVED(brainstorm 2026-08-09)
- 关联:V2 P3;依赖 P4(ResourceCard)+ P2(WorkbenchChat)

## 背景

对话里 `@pod:nginx` 引用 live 资源 → 搜索下拉 → 选中插入 chip → 发送时注入 agent 上下文。P4 ResourceCard 驱动卡片渲染。

## 范围

**做:**
1. `GET /api/workbench/search?projectId=X&kind=pod&q=nginx` — 服务端搜索 endpoint。
2. WorkbenchChat 输入框 @-tokenizer + 搜索下拉 + chip 插入。
3. 发送时 `references` 注入：服务端取完整资源 YAML 注入 agent 上下文。
4. 对话中 @-ref resolved → `<ResourceCard>` 内联渲染。

**不做:** AI 生成 @-ref / 资源变更通知 / 自动刷新 / @-ref 历史。

## 设计

### 1. 搜索 API(`server/index.mjs`)

```
GET /api/workbench/search?projectId=<id>&kind=<kind>&q=<name-query>
```
- `requireAdmin`(与现有 workbench 端点一致——平台侧 git + 集群 proxy)。
- 取 project → clusterId → `requestKubernetes(session, listPath)` + name filter。
- kind 映射到 K8s list path：pod → `/api/v1/pods`，deployment → `/apis/apps/v1/deployments`，等（复用 `api-key-tools.mjs` 的 LIST_PATH 模式，但这里用平台 dispatcher 非 SA token）。
- 返回 `[{ name, namespace, kind }]`（slim，capped 50）。
- q 为空 → 全部（capped）；q 非空 → `metadata.name.includes(q)`。

### 2. @-tokenizer(WorkbenchChat.vue 输入框增强)

- `watch(input)` → 检测光标前的 `@kind:query` token（正则 `/@(\w*):(\S*)$/`）。
- `kind` 部分：如果为空或不完整 → 显示 kind 补全提示（pod/deploy/service/...）。
- `query` 部分 → debounce 300ms → 调 `workbenchApi.search(projectId, kind, query)`。
- 下拉列表（absolute positioned，max-h-48 overflow-y-auto）：每项 `ns/name` + kind icon。
- 点击/Enter 选中 → 从 input 删除 `@kind:query` token → 插入 chip（不可编辑的 inline tag）+ 存入 `refs` 数组。
- `refs = [{ kind, namespace, name }]`。

### 3. 上下文注入（发送时）

- `send()` 时：如果 `refs.length`，在 message payload 里加 `references: refs`。
- `POST /api/agent/chat { projectId, message, references }`。
- 服务端 `/api/agent/chat`：收到 `references` → 对每个 ref 取完整资源 YAML（`requestKubernetes` get path）→ 拼成 context block 注入 system 或 user message：
  ```
  Referenced resources:
  [Pod/default/nginx]:
  apiVersion: v1
  kind: Pod
  ...
  ```
- 注入后 refs 清空（每条消息独立）。

### 4. ResourceCard 内联（对话中）

- resolved 的 @-ref → 在 user message 的 turns 渲染里，检测 chip（`@kind:ns/name` 格式）→ 显示 `<ResourceCard :resource="resolvedResource" />`。
- 简化：refs 在 send 时已 fetch（服务端注入），前端也可以在 chip 旁显示 `<ResourceCard>`（需 client-side fetch 或服务端返回 resolved data）。
- MVP：chip 显示为 `kind/ns/name` tag（不内联 ResourceCard，P3b 再做卡片内联）。

### 5. client API(`src/api/client.js`)

```js
workbenchApi.search = (projectId, kind, q) =>
  platformHttp.request(`/api/workbench/search?projectId=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(q || '')}`)
```

### 6. i18n

`workbench.chat.atMention*`：补全提示、无结果、loading。zh/en。

## 数据流

```
用户输入 @pod:nginx
  → tokenizer 检测 → debounce → GET /api/workbench/search?projectId&kind=pod&q=nginx
  → 下拉 [{name:'nginx',namespace:'default',kind:'Pod'}, ...]
  → 选中 → chip 插入 + refs.push({kind:'Pod',namespace:'default',name:'nginx'})
  → 输入剩余消息 → 发送
  → POST /api/agent/chat { projectId, message, references: refs }
  → 服务端 resolve refs → fetch YAML → 注入 agent 上下文
  → agent 回答（看得到引用的资源）
```

## 错误处理
- 搜索失败 → 下拉显示「搜索失败」+ 重试。
- 无结果 → 「无匹配资源」。
- 资源注入失败（资源不存在）→ 注入 `[Pod/default/nginx]: (not found)` 占位。

## 测试
- 后端搜索 endpoint：mock requestKubernetes → 返回 filtered list。
- 前端：`npm run build` + `npm run i18n:check`。
- 手测：@pod:nginx → 下拉 → 选中 → 发送 → agent 回答引用了资源。

## 非目标
ResourceCard 内联对话(P3b) / AI 生成 @-ref / 资源变更通知 / @-ref 历史持久化。
