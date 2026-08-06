# MCP 底座补全(rollout)+ 每工具授权覆盖

- 日期:2026-08-06
- 分支:`feat/workbench`
- 状态:APPROVED(brainstorm 2026-08-06)
- 关联记忆:[[apikey-mcp-agent-base]](MCP 底座补全 6/11 → 本轮 → 8/11 已接通 + 细粒度配置)

## 背景

`server/authorize.mjs` 的 `DANGEROUS_TOOLS` 列了 11 个 admin 档工具,作为「MCP 底座补全」的总清单。截至 `bbb0c41` 已接通 6 个(`exec_pod`/`browse_files`/`read_file`/`apply_yaml`/`delete_resource`/`kubectl_debug`),剩 5 个:`attach`、`upload_file`、`port_forward`、`rollout_undo`、`update_image`。

现有授权模型是**粗粒度**的:3 档(read/operator/admin),`tierTools(tier)` 是固定的 tier→工具集映射;每个 key 绑定**单个** namespace(`boundSA_namespace`)。本轮在 tier 之上加**每工具覆盖**(per-tool override)。

## 范围(已与用户确认)

1. **接通 2 个干净 stub**:`rollout_history` + `rollout_undo` + `update_image`(rollout 拆成 history/undo 两个工具,见决策 A)。
2. **每工具覆盖**:单个 key 可在 tier 基础上 allow/deny 具体工具。
3. **显式延后 3 个**:`attach`(流式)、`port_forward`(stateful:在网关主机开 TCP 监听,外部 AI 拿到的 localhost 地址不可达)、`upload_file`(exec 写文件,转义/注入风险大)。在代码与本文档登记延后理由,使 11/11 「有交代」而非静默丢弃。

> 这 3 个延后的工具已在 `tools/list` 中自然不出现(`mcp.mjs` 的 tools/list 与「实际已实现的 `apiKeyTools.listTools()`」取交集),故延后不改变任何运行时行为,仅补文档。

## 决策

### A. rollout 拆成 `rollout_history`(read)+ `rollout_undo`(admin 写)

内部 agent 的人审门是**按工具名**判定的(`agent-runner.mjs:30`:`needsApproval = requiringApproval.has(name) && offered.has(name)`)。若用一个合并的 `rollout_undo`(标 `requiresApproval`)工具,agent 即使只是想**列出 revision 历史**(读)也会触发人审 checkpoint。

- `rollout_history`:minTier **read**,不审批。列 Deployment 的 ReplicaSet → `[{revision, image, current, createdAt}]`。
- `rollout_undo`:minTier **admin**,审批。args `namespace,name,toRevision`,把 `deployment.spec.template` PATCH 成目标 ReplicaSet 的 template。

读/写分离,审批语义正确;AI 可自由查历史,只有真正 undo 才 checkpoint。

### B. 单个 `tool_overrides` JSON 列 + 组合语义

- 列:`api_keys.tool_overrides TEXT`(可空),存 `{allow?: string[], deny?: string[]}`。
- 有效工具集:**`effective = tierTools(tier) ∪ allow − deny`**。
- `allow` 可越过 tier(如 operator + `exec_pod`)——这是用户明确要的灵活性;真授权由绑定 SA 的 K8s RBAC 兜底(策略层放行但 SA 无 `pods/exec` → apiserver 403 → 审计 error)。
- 单列、单次迁移、原子;优于双列(`tool_allow`/`tool_deny`)的额外 schema 面。

## 架构

### 1. 三个新 K8s 工具(复用接线模板)

模板 = 注入现有 gateway 函数 → `tools.X(runBoundedTool 全链 admin 档 + 人审 + SA RBAC + 审计)` → `tool-registry` 条目 + 测试。

| 工具 | minTier | 审批 | 后端 | 行为 |
|------|---------|------|------|------|
| `rollout_history` | read | 否 | `requestFn` GET `/apis/apps/v1/namespaces/<ns>/replicasets?labelSelector=...` | 列 Deployment 的 ReplicaSet → revisions。 |
| `rollout_undo` | admin | 是 | `requestFn` PATCH deployment | args `toRevision` 必填;取目标 RS template PATCH 回 deployment。 |
| `update_image` | admin | 是 | `requestFn` PATCH workload | `kubectl set image` 语义;strategic-merge-patch `containers[name==container].image`。kind ∈ deployments/statefulsets/daemonsets。 |

- `rollout_history`:`GET replicasets`,按 `pod-template-hash`/ownerReferences 过滤出该 deployment 的 RS,每条映射 `{revision(annotations['deployment.kubernetes.io/revision']), image, current(==deployment revision), createdAt}`。
- `rollout_undo`:`GET` 目标 RS → `PATCH /apis/apps/v1/namespaces/<ns>/deployments/<name>`(strategic-merge-patch,`{spec:{template: targetRS.spec.template}}`);返回 `{undone, toRevision, previousImage, newImage}`。作用域限定 **deployments**(最常见 rollout 目标)。
- `update_image`:同 `restart` 的 patch 形状,`{spec:{template:{spec:{containers:[{name, image}]}}}}`。

三个均经 `runBoundedTool`(admin 档 + SA token + 审计),与 `kubectl_debug`/`delete_resource` 完全一致。

### 2. 每工具覆盖(细粒度配置)

**Schema 迁移**(幂等,沿用 `index.mjs:53` 模式):
```js
try { db.exec('ALTER TABLE api_keys ADD COLUMN tool_overrides TEXT') } catch { /* 列已存在 */ }
```

**`effectiveTools(keyRow)`**(`authorize.mjs`,新增单一真源):
```
effective = new Set(tierTools(tier))
if (tool_overrides) { for t in allow: effective.add(t); for t in deny: effective.delete(t) }
// 未知 tier → tierTools 返 [](fail-closed 不变);未知工具名校验在 mint/update 时拦截
```
`authorize()` 由 `tierTools(keyRow.tier).includes(tool)` 改为 `effectiveTools(keyRow).has(tool)`。

**三处「广告」路径全部改用 `effectiveTools(keyRow)`**(不再用 `tierTools(tier)`):
- `mcp.mjs:27` — 外部 MCP `tools/list`。
- `agent-runner.mjs:17` — 内部 agent offering;经新方法 `registry.toolDefsFor(names)`(按显式名字集取 def,忽略 minTier,使覆盖能把 admin 工具暴露给 operator key)。
- 工作台(platform)工具不受影响——有 workbench ctx 时照常 offer。

**校验**(mint + update 时):allow/deny 条目必须是 registry 里的真实工具名;未知→拒;同一工具同时出现在 allow 与 deny→拒(矛盾)。

**端点**:
- mint 接受 `tool_overrides`(`POST /api/admin/apikeys`)。
- 新增 `PATCH /api/admin/apikeys/:id/overrides` —— **无需重签 secret** 即可改覆盖(覆盖非机密);admin 限定。
- `listKeys` 返回该列供展示。

**UI**(`src/views/admin/ApiKeyManagement.vue`):建/编 key 时,把 tier 默认工具集显示为开关(deny=关),另提供「越过 tier 追加」选择器(allow);越过 tier 时给警告。

### 3. 测试

- `authorize.test.mjs`:`effectiveTools` 组合(tier 基、+allow、−deny、allow 越过 tier、未知 tier→空、校验拒未知名/拒 allow∩deny);保留现有 `tierTools` 用例(导出不变,仍绿)。
- `api-key-tools.test.mjs`:`rollout_history`(stub requestFn 返 RSes)、`rollout_undo`(PATCH 成目标 template)、`update_image`(PATCH image)——与现有 `kubectl_debug`/`delete_resource` 用例同构。
- 端点:mint 带 overrides、PATCH overrides、`effectiveTools` 端到端(tools/list 与 agent offering 反映覆盖)。

## 数据流

外部 MCP(`POST /mcp` tools/call):
```
resolveApiKey → keyRow(+tool_overrides) → checkRate → handleMcpMessage
  → tools/list: effectiveTools(keyRow) ∩ listTools() → 广告
  → tools/call: apiKeyTools.callTool → runBoundedTool → authorize(=effectiveTools.has) → SA token → fn → 审计
```

内部 agent(`/api/agent/chat`):
```
createAgentRunner({keyRow,...}) → toolDefs = registry.toolDefsFor(effectiveTools(keyRow)) + workbenchToolDefs
  → agent loop;写工具(rollout_undo/update_image/...) → needsApproval checkpoint → resume 续跑
```

## 错误处理

- 覆盖 JSON 损坏(parse 失败)→ 视为无覆盖(tier 默认)+ 审计告警(fail-open 到 tier,不 fail-closed 到空,避免坏数据锁死所有 key)。
- `rollout_undo` 的 `toRevision` 不存在 → SA token GET 返空 → 抛 `revision <N> 不存在`。
- `update_image` 容器名不存在 → strategic-merge 静默无操作;先 GET 校验容器名存在,不存在则明示报错。
- SA RBAC 不足(如越权 allow 了 exec 但 SA 无权)→ apiserver 403 → `runBoundedTool` catch → 审计 error,返 PERMISSION_DENIED(rbac)。

## 显式延后(非本轮)

| 工具 | 理由 |
|------|------|
| `port_forward` | stateful:在网关主机开本地 TCP 监听(`127.0.0.1:localPort`),外部 AI 拿到不可达的 localhost 地址;对 stateless MCP 价值≈0,除非加 tunnel/proxy。 |
| `attach` | 流式:`kubectl attach` 是 live stream,塞不进单次有界响应;对 AI 罕用。 |
| `upload_file` | exec 写文件,内容转义/注入面大;若做需重 guardrail(base64-pipe、仅 `/tmp`、size cap、路径白名单)。 |

代码侧:在 `authorize.mjs` 的 `DANGEROUS_TOOLS` 旁加一行注释指向本节,登记延后意图。

## 非目标

- 跨 namespace(每 ns 授权 / 多 ns allowlist)——本轮不做(用户选「per-tool override only」)。
- resource×verb 矩阵(与原生 K8s RBAC 重复)。
- 覆盖的审计专项视图(走现有 `audit_log`,不另造)。
