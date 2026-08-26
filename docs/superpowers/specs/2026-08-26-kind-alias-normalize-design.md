# kind 归一化设计(单数/Kind 名/缩写 → 规范复数)

日期:2026-08-26 · 来源:用户报障(wb_get_resource `kind:"service"` → 「不支持的 kind: service」)· 状态:已对齐

## Context / 根因

所有 kind 分发表只收**小写复数**键,而工具 schema 对 kind 无词表约束——LLM 传 K8s Kind 自然名(单数,如 `service`/`Service`)必被拒。受影响分发点(防线全量扫点):
- `server/index.mjs`:`WB_K8S_LIST_PATH`(listResources :1119)/`WB_K8S_GET_PATH`(getResource :1167、describeResource :1154)
- `server/api-key-tools.mjs`:`LIST_PATH`(list_resources :178)/`GET_PATH`(get_resource :190、describe_resource :226)
- `server/routes/workbench-projects.mjs`:`KIND_PATH`(@-mention 搜索 :171,前端传复数,低危但一并归一)

支持 kind 并集(15):pods/services/configmaps/secrets/namespaces/deployments/statefulsets/daemonsets/ingresses/nodes/persistentvolumes/persistentvolumeclaims/storageclasses/networkpolicies/serviceaccounts。

## 设计

### `server/kindAlias.mjs`(新,纯函数,单一事实源)

```js
normalizeKind(input) → 规范复数键(string) | null
```

- `String(input).trim().toLowerCase()`
- 命中规范复数集 → 直通;查别名表 → 映射;否则 null
- 别名表 = 15 个单数名 + kubectl 风格缩写:`po/svc/cm/ns/deploy/sts/ds/ing/no/pv/pvc/sc/netpol/sa`

### 接线(5 个消费点)

每处 `const k = String(kind||'pods').toLowerCase()` 改为 `const k = normalizeKind(kind)`,null 时报错文案附带支持清单(复用现有 i18n 错误键,详情串拼清单:`不支持的 kind: {k}(支持:pods/services/...,单数/Kind 名/缩写自动归一)`)。@-mention 搜索端点同样换。

### 纵深防御(tool-registry.mjs)

`wb_list_resources`/`wb_get_resource`/`wb_describe_resource` 的 `kind` 参数补 `description`:'资源类别:复数形式(pods/services/deployments/...);单数/Kind 名/缩写自动归一'。

## 测试

新 `server/kind-alias.test.mjs`(node --test,`npm test` 的 `node --test server/*.test.mjs` 自动收):复数直通/单数映射/Kind 大写/kubectl 缩写/未知名 null/空输入 null。接线回归:既有 server 套件(api-key-tools/mcp 相关)。

## 验证

门禁四连;手测:工作台问「看一下 help-friends 的 babycare-svc 服务」→ agent 传 kind=service 也能取到。

## 明确不做

CRD 动态 kind;前端 UI 词表改动(@-mention 已传复数)。
