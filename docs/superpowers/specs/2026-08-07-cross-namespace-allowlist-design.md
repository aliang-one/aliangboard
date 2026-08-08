# 跨 namespace allowlist(per-key ns 授权)

- 日期:2026-08-07
- 分支:`feat/cross-ns`(worktree `.claude/worktrees/cross-ns`,从 `origin/main` `61c424c` 起)
- 状态:APPROVED(brainstorm 2026-08-07)
- 关联:资源操作完备性 B 最后一项(跨 ns);[[apikey-mcp-agent-base]]。结构镜像 per-tool override([[tool_overrides]])

## 背景

当前每把 API key 绑**单个** namespace(`boundSA_namespace`)。`runBoundedTool` 强制 `namespace === boundSA_namespace`——超 ns 即 policy 拒。但绑定的 SA(住在 `boundSA_namespace`)**本就能经跨 ns RoleBinding 引用在多个 ns 持有 RBAC**:同一 SA token(TokenRequest 签发,ns-无关)对 SA 有 RBAC 的任何 ns 都生效。所以多 ns 在 RBAC 层已可行,**唯一限制是 policy 层的单 ns 校验**。

本 spec:把单 ns 放宽为 per-key **ns allowlist**(结构与 `tool_overrides` 同构:JSON 列 + policy 校验 + UI)。SA/RoleBinding 仍**带外**配置(管理员在各 ns 建 RoleBinding,平台不自动建——与现状一致)。

## 范围(已确认)

**做:**
1. `api_keys.allowed_namespaces`(JSON 列)+ `effectiveNamespaces(keyRow)`(lenient)+ `normalizeAllowedNamespaces(raw, boundNs)`(strict)。
2. `runBoundedTool` ns 校验改用 allowlist;detail 命名「请求 ns + 允许集 + 配置位置(平台→API Keys + 各 ns RoleBinding)」。
3. mint/list 承载 + PATCH 端点(不重签)。
4. UI:`ApiKeyManagement.vue` 加 ns allowlist 编辑器(boundSA 始终在,额外 ns 自由文本 chip)。

**不做(明确):**
- 平台**不**自动建 SA/RoleBinding(带外;与现状一致)。
- 集群 ns 列表选择器(UI 用自由文本,不拉 ns 列表)。
- resource×verb 矩阵 / per-(ns,tool) 联合授权(超范围)。
- 默认每 key 仍单 ns(向后兼容;`allowed_namespaces=NULL` → 只 `boundSA_namespace`)。

## 关键决策

### A. 允许集 = boundSA ∪ 额外 ns(boundSA 永远在)

`effectiveNamespaces(keyRow) = unique([boundSA_namespace, ...parse(allowed_namespaces)])`。`boundSA_namespace` 永远允许(SA 住那、key 绑那);`allowed_namespaces` 只存**额外** ns(不含 boundSA,运行时自动并入)。损坏/缺 → 回退 `[boundSA_namespace]`(= 今天的行为,向后兼容)。

### B. 带外 RBAC provisioning(平台不建 RBAC 对象)

管理员在 `boundSA_namespace` 建 SA,并在每个额外 ns 建 **RoleBinding**(subject 跨 ns 引用该 SA: `{kind:ServiceAccount, name:<sa>, namespace:<boundSA_namespace>}`)。平台只存 allowlist + 校验 policy;SA 的真实 RBAC(各 ns RoleBinding)决定能否真执行——**policy + RBAC 双层**,与 tool 授权同模型。

### C. 结构镜像 `tool_overrides`(同构,降风险)

- 列(`allowed_namespaces TEXT`,可空,幂等迁移)+ strict 校验函数(`normalizeAllowedNamespaces`)+ lenient 运行时函数(`effectiveNamespaces`)+ mint/PATCH + UI 编辑器——与 `tool_overrides`/`effectiveTools`/`normalizeToolOverrides` 完全同构。复用既有模式,新概念最少。

## 架构

### 1. 数据模型(`server/auth-keys.mjs`)

- `createApiKeysSchema`:CREATE 带 `allowed_namespaces TEXT`;幂等 `try { ALTER TABLE api_keys ADD COLUMN allowed_namespaces TEXT } catch {}`(同 `tool_overrides` 迁移)。
- `mintKey(db, {…, allowed_namespaces})`:`normalizeAllowedNamespaces(allowed_namespaces, boundSA_namespace)` 校验(strict,坏→抛)→ 存 JSON 串(null=无额外)。
- `listKeys` SELECT 加 `allowed_namespaces`。
- (lookupKey 已 `SELECT *`,自动含。)

### 2. 校验/运行时(`server/authorize.mjs`,与 tool 授权同区)

```js
// 运行时(lenient):损坏/缺 → 回退 [boundSA_namespace]。keyRow.allowed_namespaces 来自 DB(TEXT)或内存对象。
export function effectiveNamespaces(keyRow) {
  const set = new Set([keyRow?.boundSA_namespace])
  const raw = keyRow?.allowed_namespaces
  if (!raw) return set
  let arr; try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return set }
  if (Array.isArray(arr)) for (const ns of arr) if (typeof ns === 'string' && ns) set.add(ns)
  return set
}
// mint/PATCH 用(strict):ns 名校验;boundSA 自动并入(输入不应含,但 dedupe);坏→抛。返 JSON 串或 null。
const NS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/  // K8s dns-label(ns 名规范)
export function normalizeAllowedNamespaces(raw, boundNs) {
  if (raw == null) return null
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : null)
  if (!arr) throw new Error('allowed_namespaces 必须是字符串数组')
  const out = []
  for (const ns of arr) {
    if (typeof ns !== 'string') throw new Error('allowed_namespaces 必须是字符串数组')
    if (!NS_NAME.test(ns)) throw new Error(`非法 namespace 名: ${ns}`)
    if (ns !== boundNs && !out.includes(ns)) out.push(ns)  // boundNs 运行时自动并入,不重复存
  }
  return out.length ? JSON.stringify(out) : null
}
```

### 3. policy(`server/api-key-tools.mjs` `runBoundedTool`)

替换 `if (namespace !== keyRow.boundSA_namespace)`:
```js
const allowedNs = effectiveNamespaces(keyRow)
if (!allowedNs.has(namespace)) {
  finalizeAudit(db, intent, { result: 'denied', reason: 'policy' })
  throw new PermissionDeniedError('policy', { tool, detail: `namespace '${namespace}' 不在该 key 允许的 namespace 集([${[...allowedNs].join(', ')}]);绑定 ns + 额外 ns 在 平台管理 → API Keys 配置,SA 的各 ns RoleBinding 自建` })
}
```

### 4. 端点(`server/index.mjs`)

- mint 透传 `allowed_namespaces`(POST /api/admin/apikeys)。
- 新增 `PATCH /api/admin/apikeys/:id/namespaces`(body `{allowed_namespaces}`)→ `normalizeAllowedNamespaces(input, boundNs)` 校验 + UPDATE(不重签);复用既有 PATCH /overrides 的形状。
- list 返回该列(已在 listKeys)。

### 5. UI(`src/views/admin/ApiKeyManagement.vue`)

- 新增 ns allowlist 编辑器(与 ToolOverrideEditor 并列,但 ns 是自由文本非目录):`boundSA_namespace` 永远显示为不可删 chip;文本框「+ 额外 ns」回车追加(校验 dns-label);额外 ns chip 带 × 删除。存为额外 ns 数组(不含 boundSA)。
- 既有 key:列表/编辑展示允许集摘要(如 `anydoor + dev,staging`);PATCH /namespaces 改。

### 6. i18n

新文案经 `$t`(zh/en),`npm run i18n:check` 门禁。

## 数据流

```
admin 配置 key(平台 API Keys):boundSA_namespace(必)+ allowed_namespaces(额外,可选)
  + 带外:在 boundSA 建 SA + 各额外 ns 建 RoleBinding(subject 跨 ns 引用该 SA)
调用 → runBoundedTool: effectiveNamespaces(keyRow).has(namespace)? → policy 放行/拒
  → SA token → apiserver(SA 的各 ns RBAC 兜底真授权)
```

## 错误处理

- `allowed_namespaces` 损坏 JSON → `effectiveNamespaces` 回退 `[boundSA_namespace]`(fail-open 到 boundSA,不锁死 key;同 `effectiveTools` 的损坏回退哲学)。
- 非法 ns 名(dns-label 不符)→ `normalizeAllowedNamespaces` 抛(mint/PATCH 拒)。
- ns 不在 allowlist → policy 拒(detail 命名请求 ns + 允许集 + 配置/RoleBinding 提示)。
- ns 在 allowlist 但 SA 无该 ns RoleBinding → apiserver 403 → 审计 error(策略放行、RBAC 拒——与 tool 授权同)。

## 测试

- `authorize.test.mjs`:`effectiveNamespaces`(null→[boundSA]/+额外/损坏→回退/dedup/boundSA 永在)、`normalizeAllowedNamespaces`(valid/非法名拒/boundNS 不重复存)。
- `auth-keys.test.mjs`:mint 带 allowed_namespaces 落库 + list/lookup 回带;迁移幂等。
- `api-key-tools.test.mjs`:`runBoundedTool` ns 在 allowlist → ok;ns 不在 → policy 拒(detail 命名请求 ns + 允许集);boundSA 永远 ok。
- 端点:mint 透传、PATCH /namespaces(校验+UPDATE 不重签)。

## 非目标(再确认)

平台自动建 SA/RoleBinding / 集群 ns 选择器 / resource×verb 矩阵 / per-(ns,tool) 联合 / 改 SA token 模型(仍是单 SA TokenRequest)。
