# API key 托管 SA RBAC 漂移检测(health 三态升级)

- 日期:2026-08-27
- 状态:已获批(brainstorming 三问三节全过)
- 来源事故:2026-08-26 MCP 旧 key「策略允许、实发 403、health 绿灯侧骗」

## 背景

`GET /api/admin/apikeys/health` 的 `probeSa`(`server/index.mjs`)只 GET 一发 SA 对象,SA 活着即绿。两个真实翻车场景均不可见:

1. **欠配**:旧 key f70564c2 策略层允许 help-friends/my-assistent(ns 在 allowlist,can_i 能拿到真实 SSAR 评估),但 SA 在这两个 ns 无任何 Role/RoleBinding → 全工具实发 403。列表页绿灯误导用户去给「另一把 key」绑权限,越修越偏。
2. **超配**:managed key e66dd2d9(operator 档)被手工绑内置 `admin` ClusterRole = 平台外的影子权限,UI 显示 operator、实发 ns 全权;repair/sweep 永远清不到它。

修复能力其实已存在(`POST /api/admin/apikeys/:id/sa/repair` 全量 SSA 补齐),缺的只是「发现」。

## 目标 / 非目标

**目标**
1. health 对每把未吊销 key 做 RBAC 漂移探测:欠配(平台供给对象缺/坏)与超配(外来绑定引用我们的 SA)均可见
2. 前端红绿点升级三态(绿/黄/红),黄点直接出「修复」
3. 顺手修旧账:health 无 per-probe 超时(死集群挂死页面)

**非目标(明确不做)**
- 不自动修复(裁决:检测+一键修复档;403 语义比 404 模糊,自动自愈需防抖,范围失控)
- 不删外来绑定(只报告;管理员手工绑的是否撤,人工决策)
- 不做 SSAR/can_i 行为探测(采样有盲区、verb 矩阵成第二事实源)
- 不动 gap①(PATCH /overrides 只改 DB 不补 RBAC——另行小修,同 ns allowlist 先供给后落库模式)

## 决策记录

| 决策点 | 裁决 | 否决的备选 |
|---|---|---|
| 范围 | 检测 + 一键修复 | 检测+热路径 403 自愈;全家桶(含 gap①) |
| 判定手段 | 声明式比对 + 外来绑定扫描 | SSAR 行为探测;两者并用 |
| 触发 | 挂现有 health 端点 | 独立诊断端点(默认仍盲);后台定时 reconcile(引入定时器生命周期,邻自动自愈) |

## §1 探测逻辑(新模块 `server/sa-drift.mjs`)

纯逻辑 + `requestFn` 注入,与 `sa-provision.mjs` 同契约,可单测:

```
probeSaDrift({ requestFn, callCtx }, { keyRow, shared })
  → { saOk, saDetail, rbac: { status, issues[] } }
```

**托管 key(saManaged=1)核对表**——全部复用既有导出(`roleRules`/`rbacTier`/`effectiveNamespaces`/`TIERS`),零新事实源:

| 探测项 | 判定 |
|---|---|
| SA GET(现状保留) | 404/不可达 → saOk=false(红),后续短路 |
| 每 ns GET Role `aliangboard-mcp-<tier>-<id8>`(tier=rbacTier(keyRow)) | 缺失 → `role-missing`;rules 与 `roleRules(tier)` 稳定序列化深比对不等 → `role-rules` |
| 每 ns GET 同名 RoleBinding | 缺失 → `binding-missing`;roleRef 不指同名 Role 或 subjects ≠ 该 SA → `binding-subjects` |
| GET 共享 ClusterRole `aliangboard-mcp-cani`(每 cluster 一次,走 shared 缓存) | 缺失 → `crb-missing`(所有 key 的 can_i 同坏) |
| GET per-key CRB `aliangboard-mcp-cani-<id8>` | 缺失 → `crb-missing` |
| 每 ns list rolebindings + 一次 list clusterrolebindings | subjects 引用我们的 SA 且名字 ∉ 平台命名(三档 Role 名 + cani CRB 名)→ `foreign-binding` / `foreign-crb` |

- ns 集 = `effectiveNamespaces(keyRow)`(绑定 ns ∪ allowed_namespaces);无 allowed_namespaces 时仅绑定 ns
- rules 深比对用稳定序列化(对象键与数组元素均排序),防顺序假阳性
- id8 = `String(keyId).slice(0,8)`,与 `sa-provision.mjs` 一致

**BYO key(saManaged=0)**:SA GET + 每 ns「有无任何绑定引用该 SA」→ 无 → `byo-no-binding`(计 drift,detail 引导自建 RoleBinding 或「接管并修复」);超配扫描跳过(自管身份,一切外来皆合法)。

**status 语义**:`'ok' | 'drift'`(欠配,repair 可修)| `'over'`(仅超配)。`probe-error`(探测超时/失败)记 issue 但**不计入 drift**——只有确认漂移才黄灯,防网络抖动永久黄。

**共享缓存**:一次 health 调用内 `shared = { [clusterId]: { nsList→Promise, crbList→Promise, caniGet→Promise } }`,同 cluster 同 ns 的 list 只发一次(多 key 共享 ns 时去重)。

**per-probe 超时**:每发请求 `Promise.race` 包裹,默认 5000ms(env `HEALTH_PROBE_TIMEOUT_MS`);超时 → `probe-error` + detail「结果可能不完整」;不取消底层请求(只读 GET,泄漏无害)。

## §2 API 契约(向后兼容)

`GET /api/admin/apikeys/health` 每元素新增 `rbac` 字段,其余不变:

```json
{ "id": "…", "prefix": "…", "boundSA": "nursor/aliangboard-mcp-…", "managed": true, "tier": "read",
  "ok": true, "detail": null,
  "rbac": { "status": "drift",
            "issues": [
              { "type": "role-missing", "ns": "help-friends", "detail": "…" },
              { "type": "foreign-binding", "ns": "nursor", "name": "…-admin", "detail": "…" }
            ] } }
```

- `ok` 语义不变(SA 可达)——旧消费方/旧前端零影响
- issue `type` 枚举:`role-missing / role-rules / binding-missing / binding-subjects / crb-missing / foreign-binding / foreign-crb / byo-no-binding / probe-error`
- BYO key 也返回 `rbac`(可能只有 `byo-no-binding`)

## §3 前端(`src/views/admin/ApiKeyManagement.vue`)

红绿点(`ApiKeyManagement.vue:186`)升级三态:

| 状态 | 条件 | 展示 |
|---|---|---|
| 🟢 绿 | `ok && rbac.status === 'ok'` | 不变 |
| 🟡 黄 | `ok && (status === 'drift' \|\| 'over')` | 新增;title 列 issues 明细 |
| 🔴 红 | `!ok` | 不变 |

- 修复链接条件从 `saHealth[row.id] && !ok` 放宽为 `!ok || status === 'drift'`;managed 黄点 → 「修复」(既有键 `admin.apiKeys.repair`),BYO 黄点 → 「接管并修复」(既有键 `repairTakeover`)
- **over 不出修复链接**:title 说明「外来绑定不属于平台托管,repair 不会清理,去留人工决定」
- issues 文案全走 i18n 双语(新键 `admin.apiKeys.drift.*`,过 `npm run i18n:check` 门禁);多 issue 按 ` ` 换行拼接、超长截断
- 网关旧版本无 `rbac` 字段 → 退化为现状两态(既有静默降级路径)

## §4 测试

- **`server/sa-drift.test.mjs`**(node --test,假 requestFn 注入):全绿 / role 缺失 / rules 单 verb 差异也能抓 / binding subjects 错 / CRB 缺失 / 外来绑定识别(含平台命名不误报)/ BYO 无绑定 / 探测超时不计入 drift / 共享 list 去重(两把 key 同 ns,list 只发一次)
- **health 路由测试**(扩既有风格):响应含 `rbac` 字段、`ok` 语义不变
- **前端 vitest**:三态点断言 + 黄点出修复链接 + over 不出链接(既有测试模式;模块级 mock 必配 reset)

## §5 错误处理与边界

- 集群断连:SA GET 先失败 → 红,该 key 后续探测短路
- 探测超时/失败:`probe-error` issue,不影响 status 判定,detail 注明「结果可能不完整」
- key 无 allowed_namespaces:仅绑定 ns,探测照常
- 开销上界:每 key ≈ 2 + 3×N 发 GET + 共享 list;管理页低频打开,可接受(缓存 YAGNI)
- 兼容:`rbac` 字段新增不破坏旧前端;`ok` 语义不变

## 风险与后续

- **rules 回读形状**:SSA 回读理论上 verbatim,但若 apiserver 对 rules 有 normalization,比对层须吸收——测试用 apiserver 真实回读形状构造
- 后续(不在本spec):gap① overrides PATCH 先供给后落库;drift issues 进「MCP 审计查看器」展示
