# Wave 2 Phase B:网关执行(反向解析 + 全出口强制 + 头剥离)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** allowlist 集群上,session 面的**每一个** K8s 出口(path 型透传/watch、body 型端点全清单、ns 列表过滤)按 `authz.mjs` 授权强制;入站伪造头无条件剥离;所有拒绝写 denied 审计。退出判据:**不存在任何未经授权检查的 K8s 出口**。

**Architecture:** 新 `server/k8s-path.mjs` 反向解析器(KIND_API prefix 表 + `/apis/<group>/<ver>/` 通配,路径规范化前置,未知 fail-closed);新 `server/k8s-gate.mjs` 单一执行助手 `gateK8sSession(db, session, { namespace, level })`(open 直通 / legacy 无归属会话兼容直通 / allowlist 走 canAccessNs,403 时 denied 审计带 user/cluster/ns/path/method)——index.mjs 全部出口逐点接线,每处一行调用。头剥离在 dispatcher 顶部一次完成。

**Tech Stack:** Node + node:sqlite、node:test。

**Spec:** `docs/superpowers/specs/2026-09-05-usercenter-wave2-multitenancy-design.md` §4/§10 Phase B

## Global Constraints

- 提交作者 `aliang-one <aliangdone@gmail.com>`(提交前核);英文信息;禁 Co-Authored-By 尾注;worktree 执行 `--no-ff` 合回;**实现者禁自行合并**。
- 零新依赖;node:sqlite 绑定禁 undefined;**热路径 prepare 提升**(Phase A perf 前账:gateK8sSession 用模块级一次 prepare 的语句,不逐请求 prepare)。
- 兼容红线:legacy 无归属 session(userId NULL)与 open 集群行为逐字节不变——`gateK8sSession` 对两者直接返回 true,不产生任何审计/开销差异;升级不杀存量。
- **范围红线**:不碰 wb 工具/@mention(Phase C)、对话门(Phase D)、impersonation(Phase E);admin 平台凭据路径(requestKubernetes by clusters row,如 probe/台账)不经此门。
- 403 shape:沿用既有 `{ message }`;denied 审计字段 `{ owner: session.username||session.userId, clusterId, namespace, verb: method, resource: path, tool: 'k8s_gate', result: 'denied', reason, requestSummary: `path=${path}`, source: 'platform' }`。

---

### Task 1: server/k8s-path.mjs 反向解析器

**Files:**
- Create: `server/k8s-path.mjs`
- Test: Create `server/k8s-path.test.mjs`

**Interfaces:**
- Produces: `parseApiPath(pathname) -> { clusterScope: bool, namespace: string|null, resource: string, name: string|null, subresource: string|null } | null`(null=无法解析=调用方对非 admin fail-closed)。规范化:拒绝含 `..`、`\`、`%` 二次编码(%25)、空段、`~` 的路径 → null。识别三类:`/api/v1/...`、`/apis/<group>/<ver>/...`、`/api/v1/namespaces/<ns>/...`(ns 型);`/apis/<g>/<v>/namespaces/<ns>/...` 同理;尾段即 name,倒数第二段若为 exec/logs/portforward/attach/log 则记 subresource。基于 `KIND_API`(kind-paths.mjs:7)prefix 表匹配 resource 段;不在表内的 resource 仍解析(返回 resource 名),但**未知完整前缀**(非 /api/、非 /apis/) → null。

- [ ] **Step 1: 失败测试**(server/k8s-path.test.mjs:核心用例——`/api/v1/namespaces/team-a/pods` → {clusterScope:false,namespace:'team-a',resource:'pods',name:null};`/apis/apps/v1/namespaces/team-a/deployments/web` → name:'web';`/api/v1/namespaces` → {clusterScope:true,namespace:null,resource:'namespaces'};`/api/v1/nodes` → clusterScope:true;`/api/v1/namespaces/team-a/pods/x/exec` → subresource:'exec';`/apis/example.com/v1/namespaces/ns/things/y` → 解析成功(通配 group);`/foo/bar`、`/api/v1/namespaces/../secrets`、`/api/v1/namespaces/%252e%252e/x`、`/api/v1//pods` → 全 null)
- [ ] **Step 2: 红** → **Step 3: 实现**(顺序:先规范化(逐段 decodeURIComponent 后再验 `/^[\w.-]+$/` 且 decode 前后不含 `%`、不含 `..`),再按三前缀分发;resource 表匹配用 KIND_API 的 prefix 值集合) → **Step 4: 绿** → **Step 5: Commit** `feat(server): k8s-path reverse parser with path normalization (fail-closed)`

---

### Task 2: server/k8s-gate.mjs 执行助手(含 prepare 提升)

**Files:**
- Create: `server/k8s-gate.mjs`
- Test: Create `server/k8s-gate.test.mjs`(makeAuthzDb 从 ./authz.test.mjs import)

**Interfaces:**
- Consumes: `canAccessNs`/`effectiveGrants`(server/authz.mjs),`writeAudit`(server/audit.mjs)。
- Produces: `createK8sGate({ db, writeAudit }) -> { gateK8sSession(session, { namespace, level, path, method }) -> boolean }`——**模块内一次 prepare**(users/namespaces 查询的提升语句句柄存闭包;`sessionOwnerValid` 的语句提升属 session-guard,不在本任务)。语义:①`!session.userId`(legacy)→ true;②查 clusters 行:不存在或 nsAuthMode!=='allowlist' → true;③`canAccessNs(db, {userId, role}, session.clusterId, namespace, level)` → true;④否则 writeAudit(denied shape 见 Global)→ false。db 抛异常 → true(fail-open 仅限基础设施故障,与 sessionOwnerValid 的 fail-closed 相反——**裁决**:网关拒绝路径 fail-open 会放行,故与 guard 一致改为 fail-closed→false 并 audit reason='db-error';以本条为准实现)。

- [ ] **Step 1: 失败测试**(open 集群 true;legacy session true;allowlist+授权 view→GET true;view 会话请求 operate false+审计行;disabled 用户 false;cluster 行缺失 true;db-throw false+审计 reason='db-error';prepare 只发生一次——用 db prepare 计数代理断言)
- [ ] **Step 2: 红** → **Step 3: 实现** → **Step 4: 绿** → **Step 5: Commit** `feat(server): k8s-gate session enforcement helper with hoisted prepares + denied audit`

---

### Task 3: 透传 / watch / exec-WS / ns 列表过滤接线(index.mjs)

**Files:**
- Modify: `server/index.mjs`(透传块 :2092 起;watch :2097;exec WS :2291 附近;dispatcher 顶部头剥离)
- Test: `server/w2b-gate.test.mjs`(新建;node:test,直接构造 req/res 级最小桩走 index 内部不可行 → **裁决**:把透传/ns 过滤/watch 判定抽为 k8s-gate.mjs 的三个纯辅助 `gateParsedPath(gate, parse, method)`、`filterNamespaceList(bodyItems, grants)`、`gateWatchResources(gate, list)` 并单测;index.mjs 接线由 T5 矩阵文件以「源码断言」辅助锁:grep 断言各出口调用了 gate——临时防线,Phase B 终审以人工核)

**Interfaces:**
- Produces: 透传处理:parseApiPath(path after strip) → null 且非 admin session → 403;ns 型 → gateK8sSession(level=levelForRequest(method, subresource));clusterScope → GET 放行 / 非 GET 403;`GET /api/v1/namespaces`(或 /apis/.../namespaces)→ 响应 items 过滤(allowlist 时只留 grants 命中 ns;实现:`filterNamespaceList`);watch:parseResources 的 list 逐项 ns gate,任一不过 → 整流 403(建流前);exec WS:ownerValid 之后追加 gateK8sSession(q.namespace, operate)。**头剥离**:dispatcher 顶部对 `req.headers` 删除所有 `impersonate-*` 与 `x-remote-*` 前缀键(requestKubernetes 上游调用前生效;node headers 小写化,直接 delete)。

- [ ] **Step 1: 失败测试**(三辅助纯函数全档:parse null+非 admin→拒;ns view+GET+授权→过;ns operate+view 授权→拒+审计;clusterScope POST→拒;namespaces 过滤保留/剔除;watch 混合 ns 任一未授权→拒)
- [ ] **Step 2: 红** → **Step 3: 实现**(k8s-gate.mjs 三辅助 + index.mjs 四处接线 + 头剥离循环 `for (const k of Object.keys(req.headers)) if (k.startsWith('impersonate-') || k.startsWith('x-remote-')) delete req.headers[k]`) → **Step 4: 绿 + npm test** → **Step 5: Commit** `feat(server): enforce ns authorization on passthrough, watch, exec-ws; strip spoofed impersonation headers; filter namespaces list`

---

### Task 4: body/query 型端点全清单接线

**Files:**
- Modify: `server/index.mjs`(11 处,每处 input 解析后一行 gate 调用)
- Test: `server/w2b-gate.test.mjs`(追加辅助断言)

**Interfaces:**
- 逐点清单(锚点为当前 HEAD 行号,执行者以内容搜索为准):
  1. `POST /api/apply`(:1690)→ 解析 YAML 全部文档的 `metadata.namespace`(缺省 'default'),**逐 ns 全部 operate 通过才放行**(用 js-yaml loadAll,已在依赖);
  2. `POST /api/pod/debug`(:2017)→ input.namespace,operate;
  3. `POST /api/cronjob/trigger`(:2038)→ input.namespace,operate;
  4. `POST /api/registry/tags`(:2055)→ 集群级,ns 无关 → 仅 `canAccessCluster` 语义:allowlist 集群非 admin → 403(用 gateK8sSession namespace=null 分支:namespace null + allowlist → 拒;open/legacy → true——**gateK8sSession 增补:namespace null 时 allowlist 集群一律 false**,Task 2 实现时并入并补测试);
  5. `GET /api/resource/tree`(:2072)→ q.namespace,view;
  6. `POST /api/portforward`(创建,:1719)→ input.namespace,operate;`/:id` 子路径(attach/关断)→ 经 forwards Map 记录的 namespace 复检 operate;
  7. `/api/pvcfile/*`(:1742)→ input.namespace;GET 读 → view,写/上传 → operate(按 req.method 分);
  8. `/api/podfile/*`(:1779 query / :1821 body)→ namespace,GET 类 view / POST 类 operate;
  9. `/api/terminals` 创建(:1905)→ input.namespace,operate;`:id` 重连/写入 → terminals 表行有 namespace 列(:1909 INSERT 含 namespace)→ 查行复检 operate;
  10. `/api/file-browsers` 创建(:1983)→ input.namespace,operate;
  11. `GET /api/session` → 无 K8s 动作,不加。

- [ ] **Step 1: 失败测试**(w2b-gate.test.mjs 对 gateK8sSession null-namespace 分支 + 逐端点的 gate 参数形状纯函数 `nsForOutlet(outlet, input, q)` 不必要——直接逐点断言:为可测,把「取 ns+level」的判定写成导出纯函数 `outletNs(outlet, { input, query, method, row })`?**否——过度抽象。裁决:接线保持内联一行,gateK8sSession 单测 + Task 5 源码断言锁覆盖**;本任务测试仅补 gateK8sSession null-ns 分支与 terminals/podfile 按 method 分档的 levelForRequest 用例)
- [ ] **Step 2: 红(null-ns 分支)** → **Step 3: 逐点接线**(11 处,每处一行;denied 审计由 gate 内部完成) → **Step 4: 绿 + npm test + source-assert**(新增 `server/w2b-coverage.test.mjs`:读 server/index.mjs 源码,断言 11 个锚点字符串(如 `url.pathname === '/api/apply'`)之后 30 行内出现 `gateK8sSession(`——结构性防线,锁「出口全覆盖」退出判据) → **Step 5: Commit** `feat(server): enforce ns gate on all body/query k8s outlets (+ coverage guard test)`

---

### Task 5: 门禁收口 + 退出判据

- [ ] **Step 1:** `npm test`;`npm run test:unit -- --maxWorkers=2`;`npm run typecheck`;`npm run build`;裸 `npm run i18n:check`(新键:403 消息 `api.nsForbidden` zh「无权访问该 namespace」/ en "Namespace not allowed" — w2b 用 sendJson message;入 messages/api.mjs)。
- [ ] **Step 2: 覆盖断言自检**:w2b-coverage.test.mjs 11/11 锚点;`grep -n "gateK8sSession(" server/index.mjs | wc -l` ≥ 13(透传/watch/exec/11 端点)。
- [ ] **Step 3: 手测脚本**(交控制器):allowlist 集群 + view 授权用户 → UI 列表可见、删除按钮操作 403、exec 终端打不开、portforward 拒、apply 多 ns 文档部分未授权整单 403、`GET /namespaces` 无未授权项。
- [ ] **Step 4: 合并**(控制器)。

## 手测清单(网关重启)
① open 集群全功能回归(逐字节);② legacy 会话(open)不失效;③ allowlist:view 用户可读不可写,operate 用户可写;④ team-b 全手法 403 + audit_log 出现 tool=k8s_gate denied 行;⑤ 伪造 Impersonate-User 头被剥离(上游请求头断言或日志)。

## 非目标
wb 工具/@mention(Phase C)、对话降门(Phase D)、impersonation 下游注入与组 RoleBinding(Phase E)、admin 凭据数据面(台账/probe/托管 SA——平台运维路径,恒 admin)。
