# @server:AI 对话引用 SSH 服务器 设计

日期:2026-08-30
状态:已评审(用户裁定:单层搜索列表交互;脱敏红线保持)

## 1. 背景与目标

工作台 @-mention 现只支持 K8s 资源(`@kind:关键字` → `/api/workbench/search` K8s list → refs `{kind,namespace,name}` → `fetchRefContext` 每轮拉实况注入 system)。目标:SSH 服务器成为可 @ 引用资源——`@server` 出现选择器,按 **名称/IP/备注关键字** 单层搜索定位,选中后 AI 每轮获得该服务器的上下文,并天然衔接既有 `wb_ssh_exec` / `wb_ssh_read_file` / `write_server_notes`(按服务器名称寻址)。

用户已裁定的交互:**单层搜索列表**(不做 clusterRef 分组二级导航)。

## 2. 触发与选择器(前端 WorkbenchChat.vue)

- `KIND_ALIASES` 增 `server: 'server', ssh: 'server'`;`KIND_LABELS` 增 `server: 'Server'`;`@` kind 提示与可发现性文案同步提及 @server。
- `@server:关键字` → server 搜索分支(前端 watch 里 alias==='server' 时走新分支,不做 ns/ 斜杠解析):
  - 调 `GET /api/workbench/search?projectId&kind=server&q=<关键字>`(debounce 200ms 复用现有节奏)
  - 单层列表实时过滤,每项显示 **名称 + clusterRef 标签 + 备注**;host 不在非 admin 前端展示(§4)
- 选中 → refs 增 `{ kind: 'server', namespace: '', name: <服务器名称> }`(名称 = `wb_ssh_exec` 的寻址句柄)。
- chips/编辑重发:refs 原样往返,核验编辑态 draftRefs 对 server refs 成立;ChatTurn ResourceCard 与输入区 chip 对 kind='server' 显示 `dns` 图标 + 服务器名。

## 3. 搜索端点(服务端)

`GET /api/workbench/search`(routes/workbench-projects.mjs)增 `kind=server` 分支,**置于「项目已绑集群」校验之前**(服务器搜索与集群无关,无集群项目可用):

- 数据源 `listSshServers(db, { exposedOnly: true })`——与 AI SSH 能力面完全一致:admin 未暴露给 AI 的服务器 @ 不出来。
- 过滤:q(小写)对 `name / host / description` 任一包含匹配;cap 50。
- 响应:`{ items: [{ kind:'server', name, description, clusterRef, ...(admin ? { host } : {}) }] }`——**host 字段仅 admin 响应携带**。
- 门:**requirePlatform**(从 requireAdmin 放宽,仅对 server 分支;K8s 分支维持 requireAdmin 不动)。理由:workbench AI 系统提示词本就向所有平台用户注入 exposed 服务器清单(name/description/clusterRef),选择器是同一事实源的可视化;host 对非 admin 不出网。
  - 路由内部结构:server 分支先返回;K8s 分支的 requireAdmin 检查保留在原位置(实现时注意把 requireAdmin 从函数级移到 K8s 分支内,不能让 server 分支被 admin 门挡住)。

## 4. 脱敏红线(2026-08-28 审计裁决贯通,勿推翻)

- **选择器**:host 参与搜索匹配;host 字段仅 admin 响应携带(非 admin 响应无此字段,前端自然不显示)。
- **AI 上下文**:server ref 注入块**不含 host/username**——与台账 AI 视图脱敏完全一致。AI 通过名称寻址,不需要 IP。
- 凭据任何一层都不出现(现状保持)。
- 若未来要让 AI 看到真实 IP,须用户明确推翻 2026-08-28 裁决,不在本特性内。

## 5. 上下文注入(fetchRefContext 增 server 分支)

- `ref.kind === 'server'` → 不走 `getApiPath`(否则落「不支持的 kind」);查 `listExposed()` 按 `name` 定位(兜底按 `id` 匹配),命中注入块:

  ```
  [server//<名称>]:
  { "name":"…", "description":"…", "clusterRef":"…", "os":"…", "status":"…",
    "approvalPolicy":"…", "capabilities":["wb_ssh_exec(按服务器策略审批)","wb_ssh_read_file","write_server_notes"] }
  ```

  字段以 store 实际列为准(osId/osName/status/approvalPolicy 等);**不含 host/username/凭据**。
- 实时性:每轮现查;服务器被删或被取消暴露 → `[server//<名称>]: (not found / 已不可用)`(与 K8s ref 漂移语义同款)。
- **guard 修正**:现 `fetchRefContext` 开头 `if (!references.length || !k8sSession) return ''` 会吞掉无集群项目的 server refs——改为:references 为空仍返 '';含 server refs 时即使无 k8sSession 也继续(server refs 不依赖 k8sSession),仅 K8s refs 在无 k8sSession 时逐条标 `(not found / 无集群)`。
- 块仍过 `formatRefBlock`(围栏 + 16KB 截断)与 48KB 引用预算(机制复用)。

## 6. 权限与可见性总表

| 面 | 规则 |
|----|------|
| 选择器可见范围 | exposedOnly 服务器(所有 workbench 平台用户) |
| host 展示 | 仅 admin(选择器响应与 UI) |
| AI 上下文 | name/description/clusterRef/os/status/approvalPolicy/capabilities;无 host/username |
| 工具执行 | 不变:wb_ssh_* 按各服务器审批策略(必审/只读免审/免审) |
| 未暴露服务器 | 选择器搜不到、ref 每轮标 not found |

## 7. 测试

| 层 | 用例 |
|----|------|
| 服务端 search | exposedOnly 过滤(未暴露不可见);name/host/备注三路命中;非 admin 响应无 host 字段、admin 有;无集群项目可用;K8s kind 分支回归(仍 requireAdmin + 需绑集群) |
| 服务端 fetchRefContext | server 分支注入块内容与脱敏断言(块内无 host/username 子串);服务器已删/取消暴露 → not found;无 k8sSession 时 server refs 仍注入、K8s refs 标无集群;预算截断复用 |
| 前端 | `@server:` 触发 server 分支;选中落 chip `{kind:'server',namespace:'',name}`;chip/ResourceCard 渲染(dns 图标+名称);编辑重发往返保留 server refs |

## 8. 明确不做(YAGNI)

- MCP/API-key 场景的 server ref(无 references 管线)
- 「@server 直接触发 exec」动作语义——引用只注入上下文,行动走工具+既有审批
- clusterRef 分组二级导航(已裁定单层)
- host 进 AI 上下文(红线,§4)
- 服务器选择器的收藏/置顶等增强
