# MCP/API-key 审计查看器 + 调用来源标识

- 日期:2026-08-06
- 分支:`feat/mcp-audit-viewer`(从 `main` `50023d6` 起)
- 状态:APPROVED(brainstorm 2026-08-06)
- 关联记忆:[[mcp-audit-viewer-need]]、[[apikey-mcp-agent-base]]

## 背景

`audit_log` 表已**全量记录**每次 API-key 鉴权的工具调用(经 `runBoundedTool` 两阶段 started/finalized + 链式哈希):keyId/owner/clusterId/namespace/verb/resource/tool/result(ok/denied/error)/reason/requestSummary。三条调用路——外部 MCP(`/mcp`)、内部 agent(`/api/agent/chat`)、直接(`/api/key/<cluster>/call`)——**共用同一条链**,此前**无字段区分来源**,也**无任何 UI/端点可查看**。现有 `src/views/AuditLogs.vue` 是 K8s Events(集群事件),与本次无关。

本 spec 建:(1)给 `audit_log` 加**来源标识** `source`;(2)admin 审计查看页(「最近活跃 key」面板 + 调用记录表 + 完整性校验)。

## 范围(已与用户确认)

**做:**
1. `audit_log` 加 `source` 列(mcp/agent/direct),三条调用路写入各自来源。
2. 三个 admin 只读端点:活跃 key 聚合、分页流水、链完整性校验。
3. admin 页 `AuditTrail.vue`:「最近活跃 key」面板 + 调用记录表(含 source 列/过滤)+ 行详情 + 完整性徽章。

**不做(非目标):**
- 自动保留/裁剪策略(分页 + 现有索引够 v1;增长成问题再加)。
- 实时推送(SSE/WebSocket)——stateless MCP 无「在线」概念,window 聚合 + 手动刷新即近似。
- 把 `source` 纳入哈希链(见下「关键决策」)。
- 合并 K8s Events / 浏览器用户操作日志(来源不同,保持各自页面)。

## 关键决策

### A. `source` 不进哈希链(CORE_FIELDS 不变)

`audit_log` 的防篡改链由 `CORE_FIELDS` 参与哈希:`prevHash/hash`。若把 `source` 加进 `CORE_FIELDS`,**所有存量行重算后将不再匹配其存储 hash** → `verifyChain` 从最旧行起断裂。

决策:`source` 作为**普通列、不参与哈希**。**who/what/result(keyId/owner/cluster/namespace/verb/resource/tool/result/reason)仍受哈希保护**;`source` 是路由标签。权衡:有 DB 写权限者可改某行 `source` 而不被链发现——但其只能「错标通道」,无法篡改「做了什么/结果」(仍哈希保护)。对 MVP 审计(诚实记录 + 事后复盘,非对抗性 DB 篡改威胁模型)可接受。

> 备选(本次不取):一次性重链历史 + 把 source 纳入哈希——保 source 也防篡改,但工作量大、且「重链」本身削弱历史可证明性。

### B. 客户端身份 = API key

「哪些客户端在用」按 **API key**(owner + label + cluster)聚合,不引入额外 client 注册。一把 key 即一个客户端身份。

## 架构

### 1. 数据模型:`source` 列 + 三路写入

**schema 迁移**(幂等,沿用 `tool_overrides` 同款 `try { ALTER TABLE ... ADD COLUMN } catch {}`,放 `audit.mjs` 的 `createAuditSchema`):
```js
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (..., source TEXT, prevHash TEXT NOT NULL, hash TEXT NOT NULL)`)  // 新库 CREATE 带 source
try { db.exec('ALTER TABLE audit_log ADD COLUMN source TEXT') } catch { /* 列已存在(旧库) */ }
```
- `source` 取值:`'mcp'` | `'agent'` | `'direct'`;存量行迁移后为 `NULL`(查看器显示「—/legacy」)。
- **`CORE_FIELDS` 不加 `source`**(决策 A)。`writeAudit` 把 `source` 写入列但不参与 `canonical`/`rowHash`。

**三路写入**:`runBoundedTool` 的 `intent` 加 `source`;`reserveAudit`/`finalizeAudit` 经 `writeAudit` 落 `source` 列。`callTool` 签名加 `source` 形参(默认 `'direct'`),三个调用点显式传:

| 调用路 | 文件 | 传入 |
|--------|------|------|
| 直接 `/api/key/<cluster>/call` | `server/index.mjs` | `callTool(keyRow, cluster, tool, args, 'direct')` |
| 外部 MCP `/mcp` tools/call | `server/mcp.mjs` `handleMcpMessage` | `callTool(keyRow, cluster, name, args, 'mcp')` |
| 内部 agent `/api/agent/chat` | `server/tool-registry.mjs` K8S `exec` | `callTool(ctx.keyRow, ctx.cluster, t.name, args, 'agent')` |

> `runBoundedTool` 形参对象加 `source`;intent = `{...原有, source}`;`finalizeAudit(db, intent, {result, reason})` 与 denied/error 路径均带 `intent.source`。工作台(platform)工具不经 `callTool`(用 `ctx.wb.*`),不入 `audit_log`,无 source。

### 2. 端点(均 `requireAdmin`,纯读)

**`GET /api/admin/audit-log/active?window=<sec>&source=<s>`**(window 默认 900):
- 按 key 聚合近 `window` 秒、可选 `source` 过滤的调用:
  `[{ keyId, owner, label, clusterId, count, lastTs, ok, denied, error }]`(label 经 join `api_keys`)。
- 按 `lastTs DESC` 排序。

**`GET /api/admin/audit-log?key=&owner=&cluster=&tool=&result=&source=&since=&until=&page=&size=`**:
- 分页调用流水(默认按 `ts DESC`,size 默认 50、上限 200):
  `{ items: [...全字段含 source], total, page, size }`。
- 过滤器均为可选;`result` ∈ {ok,denied,error};`source` ∈ {mcp,agent,direct}。

**`GET /api/admin/audit-log/verify`**(按需,按钮触发):
- 返 `{ valid: boolean, brokenSeq?: number }`(复用 `verifyChain`;`verifyChain` 是 O(n),不放每载)。

### 3. 前端 `src/views/admin/AuditTrail.vue`

- **路由 + 侧栏**:路由 `/admin/audit-trail`,侧栏「审计」入口。
- **数据获取**:对齐 admin 兄弟页(`ApiKeyManagement` 等)—— `adminApi` + `ref` + `onMounted` + 手动刷新(本轮不上 Vue Query;Vue Query 迁移范围是资源视图,admin 页统一后续再切)。
- **顶部「最近活跃 key」面板**:
  - window 选择器(900/1800/21600 秒 = 15min/30min/6h);可选 source 过滤(默认 all)。
  - 卡片列表:每卡 owner + label + cluster + count + 相对时间 lastTs + ok/denied/error 分布条(色标)。
  - 空态:「近 N 分钟无活跃 key」。
- **调用记录表**(`DataTable`,分页):
  - 列:ts / owner / **source**(徽章 mcp/agent/direct)/ cluster / namespace / tool / resource / result(色标)/ reason。
  - 过滤器:owner · key · cluster · tool · result · **source** · 时间范围。
  - 行点开 → 详情(requestSummary / 完整 reason / prevHash+hash / seq)。
- **完整性徽章**:页顶「链完整性 ✓/✗」+ 「校验」按钮 → 调 `/verify`。
- **i18n**:全文案经 `$t`(zh+en),key 前缀 `auditTrail.*`;`npm run i18n:check` 必过(仓库门禁)。

## 数据流

```
调用路(direct/mcp/agent) → callTool(..., source) → runBoundedTool({...,source})
  → reserveAudit(intent 含 source) → finalizeAudit → writeAudit(写 source 列,不入 hash)
查看:admin 页 → adminApi.auditTrail.{active,log,verify} → 三个 GET 端点 → 读 audit_log
```

## 错误处理 / 边界

- `source` 未知/缺失 → 列 `NULL`,查看器显示「—」;不影响链。
- `active` window 非法(≤0)→ 钳到默认 900;超大(>86400)→ 钳到 86400。
- `log` 分页越界 → 返空 items + 实际 total。
- `verify` 在超大表上慢(O(n))→ 仅按钮触发,响应可接受;不阻塞页面加载。
- 端点均 `requireAdmin`;非 admin → 401/403(沿用现有中间件)。

## 测试

- `audit.mjs`(`node --test`):`writeAudit` 带 source 落库;`verifyChain` 在「有 source 行 + 无 source 存量行」混合下仍 valid(source 不在 CORE_FIELDS);迁移幂等(二次 `createAuditSchema` 不报错)。
- 三路 source 流向(纯逻辑/桩):`callTool(...,'mcp')` 的 intent.source 入 audit;direct/agent 同理。可复用 `api-key-tools.test.mjs` 的 `runBoundedTool` 桩(断言 audit 行 `source`)。
- 端点(集成):`active` 聚合(window 边界 + source 过滤)、`log` 分页/过滤、`verify` 返 valid。
- 前端:`npm run build` 通过(`.vue` 编译)+ `npm run i18n:check` 通过(无硬编码)。

## 非目标(再确认)

- 自动保留/裁剪、实时推送、source 入哈希、合并 K8s Events。
- 「真正实时在线客户端」(stateless MCP 不支持;window 聚合是刻意近似)。
