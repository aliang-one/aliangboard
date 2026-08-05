# Ingress 路由规则编辑器重构

- **日期**：2026-08-05
- **状态**：已确认，待实现
- **范围**：`NsIngressDetail.vue` 的 Edit Rules 弹窗 + `store.updateIngressRules` / `mapIngress`

## 1. 背景与动机

详情页（展示）已按域名分组（`rulesByHost`），结构清晰，用户满意。但 **Edit Rules 弹窗**仍是**平铺表格**（每行 host/path/pathType/service/port），与详情页割裂：

- 同一 host 的多条 path 要**重复填 host**，看不出分组。
- **无保存前校验**：空 service/port、path 不以 `/` 开头、同 host 下 path 重复等问题直接提交，由 K8s 拒绝或静默失败。
- **不支持 `spec.defaultBackend`**：`allRules` 只展开 `rules.http.paths`，`updateIngressRules` 只 PATCH `spec.rules`。有 defaultBackend 的 ingress 编辑后会丢失它。
- 缺少复制/移动等便捷操作。

**目标**：重构编辑器为「host 分组卡片 + 顶部 defaultBackend 卡片」，与详情页同构；加严格校验；补齐 defaultBackend 全链路；补齐 host/path 的增删/复制/上下移操作。

## 2. 目标与非目标

### 目标
1. 编辑器按 host 分组（host 卡片内含 path 列表），与详情页同构，消除重复填 host。
2. 保存前**严格校验**（必填/格式/重复），有错误时**阻断保存**（按钮禁用 + 错误汇总）。
3. 支持 `spec.defaultBackend`（开关式卡片，默认收起）。
4. 更多操作：host / path 的增、删、复制、上移、下移；清空全部。
5. 移动用**上移/下移按钮**（项目无拖拽库，原生 drag 不稳）。

### 非目标（YAGNI）
- 不改详情页展示（用户满意）。
- 不改 IngressClass / TLS / Annotations / Labels 的编辑。
- 不改 `NsIngress.vue` 创建表单。
- 不引入拖拽库 / sortable。
- 不做 host 格式的严格正则（K8s 接受域名/IP/`*` 通配等多种，宽松处理）。

## 3. 现状

- `NsIngressDetail.vue:410-451`：Edit Rules Modal，平铺表格；`editRules = [{host,path,pathType,serviceName,servicePort}]`。
- `openRulesEditor` / `addRule` / `removeRule` / `saveRules`（行 75-93）。
- `store.updateIngressRules(name, ns, flatRules)`（cluster.js:548）：按 host 聚合成 `spec.rules` 后 PATCH（merge-patch）；**无 defaultBackend、无校验**，空值默认 `'/'` / `80`。
- `mapIngress`（cluster.js）**未映射 `spec.defaultBackend`**。
- `allRules`（NsIngressDetail.vue:28）只展开 `rules.http.paths`，不读 defaultBackend。
- 项目**无拖拽库**（grep 确认），无拖拽实现先例。

## 4. 设计（方案 A：host 分组卡片）

### 4.1 组件内数据模型（告别平铺）

用分组模型替换平铺 `editRules`：

```js
const editModel = ref({
  hosts: [
    { host: 'app.example.com', paths: [
      { path: '/', pathType: 'Prefix', serviceName: 'web', servicePort: '80' },
    ] },
  ],
  defaultBackend: { enabled: false, serviceName: '', servicePort: '' },
})
```

- **`openRulesEditor`**：从 `allRules`（含新读的 defaultBackend，见 4.3）构建：
  - 按 `r.host`（空 host 归为 `''`）分组 → `hosts[]`。
  - `defaultBackend.enabled = !!ing.defaultBackend`；启用时回填其 `serviceName` / `servicePort`。
  - 空数据时给一个空 host + 一条默认 path（保留现有行为）。
- **`saveRules`**：展平 `hosts` → `flatRules`（每条 `{host, path, pathType, serviceName, servicePort}`）传 store；`defaultBackend` 单独传（见 4.4）。

### 4.2 UI（Edit Rules 弹窗重构）

Modal 内自上而下：

1. **顶部说明**（保留现有"保存即 patch"文案）。
2. **校验错误汇总**：`v-if="errors.length"`，列出错误条目（定位到 host/path）。无错误时不占位。
3. **默认后端卡片**（开关式，默认收起）：
   - checkbox「启用默认后端 (`spec.defaultBackend`)」。
   - `v-if="editModel.defaultBackend.enabled"`：`PortSelect`(serviceName, options=`nsServiceNames`) + `PortSelect`(servicePort, options=`portsFor(defaultBackend.serviceName)`)。
4. **host 卡片列表**：`v-for="(h, hi) in editModel.hosts"`：
   - 卡片 header：host 文本输入 + 操作图标（复制 host / 上移 / 下移 / 删除 host）。
   - 卡片 body：path 行列表，每行 = path 输入 + pathType `<select>` + `PortSelect`(serviceName) + `PortSelect`(servicePort) + 操作图标（复制 / 上移 / 下移 / 删除）+ 错误标红（`border-error` / 错误提示）。
   - 卡片底部：「＋ 加 path」按钮（push 到 `h.paths`）。
5. **底部**：「＋ 加 host」按钮（push 空 host）+ 「清空全部」（`hosts=[]; defaultBackend.enabled=false`，二次确认）。
6. **actions**：Cancel + **Save Rules**（`:disabled="errors.length > 0"`）。

### 4.3 `mapIngress` 扩展（store）

`mapIngress` 增加 `defaultBackend` 字段，从 `spec.defaultBackend` 映射：

```js
const db = spec.defaultBackend?.service
const defaultBackend = db ? { serviceName: db.name || '', servicePort: String(db.port?.number ?? db.port?.name ?? '') } : null
```

返回对象加 `defaultBackend`。组件通过 `ing.defaultBackend` 读取（`allRules`/`openRulesEditor`）。

### 4.4 `updateIngressRules` 扩展（store）

签名扩展为 `updateIngressRules(name, ns, flatRules, defaultBackend)`：

- 现有：`flatRules` 按 host 聚合 → `rules`。
- 新增 `defaultBackend` 处理：
  - `defaultBackend.enabled && serviceName && servicePort` → `db = { service: { name, port: { number: Number(servicePort) } } }`。
  - 否则 → `db = null`（merge-patch 删除）。
- 远端**一次 PATCH**（rules + defaultBackend 同 body，避免两次请求）：
  ```js
  body: JSON.stringify({ spec: { rules, defaultBackend: db } })
  // db === null 时 merge-patch 删除 spec.defaultBackend
  ```
- 本地合并：`updateIngress(name, ns, { rules, defaultBackend: db, hosts: rules.map(r=>r.host).filter(Boolean).join(',') })`。

> 注意：`defaultBackend: null` 必须显式出现在 PATCH body 中，merge-patch 才会删除字段；`undefined` 不会。

### 4.5 校验（computed `errors`）

对 `editModel` 计算 `errors` 数组（每项 `{ loc, msg }`），用于：
- 顶部汇总展示。
- 行级标红（path 输入 `:class` 绑错误）。
- Save 按钮 `:disabled`。

规则：
- **path**：必填、必须以 `/` 开头。
- **serviceName**：必填。
- **servicePort**：必填、是数字。
- **同 host 下 path 重复**：同 `host` 内出现相同 `path` 字符串 → 错误。
- **host**：空 host 合法（=通配，`spec.rules` 的 host 可空）；非空 host 不做严格格式校验。
- **defaultBackend**（`enabled` 时）：serviceName 必填、servicePort 必填数字。

### 4.6 操作函数

- host：`addHost()` / `removeHost(i)` / `duplicateHost(i)`（深拷贝 paths，host 名加 ` (copy)` 后缀或留空）/ `moveHost(i, dir)`。
- path：`addPath(hi)` / `removePath(hi, i)` / `duplicatePath(hi, i)` / `movePath(hi, i, dir)`。
- `clearAll()`：`hosts = []`、`defaultBackend.enabled = false`（带确认）。

上下移按钮在边界（首/末）时 `disabled`。

## 5. 边界情况

| 场景 | 处理 |
|---|---|
| ingress 无 rules | 编辑器显示空 + 「加 host」引导 |
| ingress 有 defaultBackend 无 rules | defaultBackend 卡片自动启用回填；hosts 空 |
| defaultBackend 与 rules 共存 | K8s 允许；两者独立编辑、一次 PATCH 同提交 |
| 用户关闭 defaultBackend 开关 | saveRules 传 `null`，PATCH 删除 `spec.defaultBackend` |
| 空 host（通配）| 合法，归为 `host: ''`；`hosts` 汇总里显示 `*` |
| 校验错误 | Save 禁用 + 顶部汇总 + 行标红；不向 K8s 提交错误数据 |

## 6. 测试

- **组件层**：项目无前端测试框架 → 手动验证清单（`npm run dev` + 浏览器）：
  - 编辑器按 host 分组展示，host 内增删/复制/移动 path、增删/复制/移动 host、清空全部。
  - 校验：空 service/port、path 非 `/` 开头、同 host 重复 path → 标红 + Save 禁用 + 汇总。
  - defaultBackend 开关：启用→编辑→保存→远端 spec.defaultBackend 正确；关闭→保存→远端 defaultBackend 被删除。
  - 保存后回读：重新打开编辑器，分组/defaultBackend 正确回填。
- **store 层**：`updateIngressRules` 的 PATCH body 构造（rules 聚合 + defaultBackend 对象/null）可在 `scripts/test.mjs` 加一个镜像纯函数测试（抽 `buildIngressRulesPatch(flatRules, defaultBackend)` 纯函数，store 调用它，test.mjs 测它）——与端口选择的 `extractContainerPorts` 同模式。

## 7. 涉及文件清单

**修改**
- `src/views/NsIngressDetail.vue`：编辑器数据模型/UI/校验/操作全重构（`editModel`、`openRulesEditor`、`saveRules`、`errors` computed、host/path 操作函数、Edit Rules Modal 模板）。
- `src/stores/cluster.js`：`mapIngress` 加 `defaultBackend` 字段；`updateIngressRules` 扩展签名与 PATCH body（rules + defaultBackend）；可选抽 `buildIngressRulesPatch` 纯函数。

**新增（可选）**
- `src/composables/useIngressRules.js`：若把 `buildIngressRulesPatch` / 校验逻辑抽成纯函数便于单测，按端口选择的 `usePorts.js` 模式。
