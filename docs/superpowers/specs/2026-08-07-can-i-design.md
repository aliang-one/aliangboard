# can_i 工具(RBAC 自检 via SelfSubjectAccessReview)

- 日期:2026-08-07
- 分支:`feat/can-i`(worktree `.claude/worktrees/can-i`,从 `origin/main` `b8b31d8` 起)
- 状态:APPROVED(brainstorm 2026-08-07)
- 关联:资源操作完备性 B 的权限可观测子项;[[apikey-mcp-agent-base]]

## 背景

`can_i` 名字早已在 `BOUNDED_TOOLS`(read 档)但**未实现**(phantom,调则「未知工具」)。它是 MCP 工具集里最后一块缺口:让 AI 在行动前自检「我(绑定 SA)能对 `<resource>` 做 `<verb>` 吗?」,减少失败/被拒调用。CRUD 已完备(read-gen 的任意读 + apply_yaml 的任意写/改 + delete_resource 的任意删),can_i 补的是**权限可观测**——AI 无法从 tools/list 得知 SA 的真实 K8s RBAC。

## 范围(已确认)

**做:** 实现 `can_i`——RBAC-only via `SelfSubjectAccessReview`(SSAR)。
**不做(明确):**
- **policy 层合取**:不计算 verb→tool 映射的策略允许(AI 自己从 tools/list 知道有哪些工具;can_i 只补 RBAC 这一个未知量)。既有 `canIDecision()` helper 留置不用(YAGNI,避免 churn)。
- cross-namespace allowlist、patch_resource(各自独立 spec)。
- 改 `authorize.mjs`(can_i 已在 BOUNDED_TOOLS,只加 tool 实现 + registry 条目)。

## 设计

### 工具 `can_i`(read 档,requiresApproval false)

args:`{ namespace, verb, resource, group?, name?, subresource? }`(required: `namespace`, `verb`, `resource`)。
- `verb`:kubectl can-i 动词(get/list/watch/create/update/patch/delete/deletecollection/exec/…)。
- `resource`:如 `pods`/`deployments`/`ingresses`/`secrets`。
- `group`:apiGroup(`apps`/`networking.k8s.io`/…;默认 `''` = core)。
- `name`/`subresource`:可选(具体对象或子资源如 `pods/log`)。

经 `runBoundedTool`(read 档;ns 作用域如所有工具):
1. ns 校验(`namespace === keyRow.boundSA_namespace`,既有)。
2. fn:
   - 校验 `verb`/`resource` 非空(缺 → throw)。
   - `POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews`(SA token),body:
     ```jsonc
     { "apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview",
       "spec": { "resourceAttributes": { "namespace": "<ns>", "verb": "<verb>", "group": "<group>",
                                          "resource": "<resource>", ...name/subresource 可选 } } }
     ```
   - 返 `{ allowed, reason, evaluationError, queried:{namespace,verb,resource,group,name,subresource} }`。

### 关键点

- **ns-bound**:can_i 只检**绑定 namespace** 内的 RBAC(与所有工具一致;绑 anydoor 的 key 不能 can_i 别的 ns)。
- **SSAR 失败优雅降级**(不抛):SA 若无 `create selfsubjectaccessreviews` RBAC → SSAR POST 403;fn `catch` → 返 `{allowed:false, evaluationError:'SA 无 selfsubjectaccessreviews 的 create 权限(can_i 需 SA 有 SSAR RBAC)'}`。其他 requestFn 错(5xx/网络)同样优雅返 `{allowed:false, evaluationError:'SSAR 请求失败(http<code>): <msg>'}`。→ can_i 永不抛给调用方,总返结构化结果(AI 可据 evaluationError 判断)。
- **registry 条目**:`minTier:'read'`,`requiresApproval:false`,inputSchema(namespace/verb/resource required;group/name/subresource optional)。
- **不改 authorize**:can_i 已在 BOUNDED_TOOLS → 一旦实现,`listTools()` 含它 → read 档自动广告。

## 数据流

```
AI → callTool(can_i, {namespace,verb,resource,group?...})
  → runBoundedTool(namespace 校验 === boundSA_namespace)
  → fn: POST SSAR(SA token, resourceAttributes)
    ├ 200 {status:{allowed}} → {allowed, reason, evaluationError:null, queried}
    └ 403/5xx/网络(catch)→ {allowed:false, evaluationError:'...', queried}
```

## 错误处理

- 缺 `verb`/`resource` → throw「can_i 缺 verb/resource」(输入校验)。
- 缺 `namespace` → runBoundedTool ns 校验拒(既有,policy)。
- SSAR 403(SA 无 SSAR RBAC)→ `{allowed:false, evaluationError:'SA 无 selfsubjectaccessreviews 的 create 权限...'}`(优雅,提示真配置缺口)。
- SSAR evaluationError(apiserver 无法判定)→ 透传 `evaluationError`。
- `reason`/`evaluationError` 截断防超大(各自 ≤ 300 字符)。

## 测试(mock requestFn 拦截 SSAR POST)

- **happy**:`requestFn` 拦 SSAR POST → 返 `{status:{allowed:true}}` → can_i 返 `{allowed:true}`;并断言 POST body 的 `resourceAttributes` 含正确的 namespace/verb/resource/group。
- **denied**:SSAR → `{status:{allowed:false, reason:'forbidden'}}` → `{allowed:false, reason:'forbidden'}`。
- **evaluationError**:SSAR → `{status:{allowed:false, evaluationError:'...'}}` → 透传。
- **SSAR 403(SA 无 SSAR RBAC)**:`requestFn` 对 SSAR POST 抛 `{status:403}` → can_i **不抛**,返 `{allowed:false, evaluationError:/selfsubjectaccessreviews.*权限/}`。
- **ns 不符**:namespace=他 ns → policy 拒(e.reason==='policy',既有 ns 校验)。
- **read 档可调**:mint read key 可调 can_i(验证 read tier 广告)。
- **缺 verb/resource**:throw /缺 verb\/resource/。

## 非目标(再确认)

policy 层合取 / verb→tool 映射 / cross-namespace / patch_resource / 改 authorize / 移除 canIDecision。
