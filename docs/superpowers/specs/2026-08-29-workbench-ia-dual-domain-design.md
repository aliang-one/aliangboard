# 工作台信息架构双域化(Workbench IA 双域并行)设计

- 日期:2026-08-29
- 状态:已经用户逐节确认的设计定稿
- 范围:工作台五板块(项目/服务器/配置/全局/记录)→ 四板块(项目/服务器/知识/记录)
- 分支:feat/wb-ia-dual-domain(基点 main @ 4f1176a)

## 1. 背景与问题

服务器(SSH 管理功能)进入工作台之前,工作台是「集群单极」世界:项目强绑单个集群、「全局」tab 实为集群台账、记录按集群维度拆分。服务器是第一个**不依赖集群**的一等公民(MCP SSH 分派先于集群守卫),于是原有板块的隐含假设出现裂缝:

| 板块 | 现状问题 |
|---|---|
| 项目 | 项目绑集群,服务器域无对应工作单元(本期不做,见非目标) |
| 服务器 | 本体,自洽;但服务器台账(自由 notes)与集群台账(INDEX/learnings+Distill)机制分居两 tab |
| 配置 | 大杂烩:集群绑定列表 / 项目根目录 / 坏占位的 Distill 状态块 / 悬浮对话配置,与服务器域无任何关系 |
| 全局 | 名为「全局」实为**集群台账**,名不副实;知识分裂在两 tab 两套机制 |
| 记录 | 统计卡与存储分析均无服务器维度;审计只筛 `source='workbench'`,人手 SSH 操作(`source='platform'`)不可见 |

关键事实(设计依据):

- 工作台 tab 是 `WorkbenchShell.vue` 组件内 `ref` 状态,**不走路由**——重排零路由/书签兼容负担。
- 所有 `/api/ssh/*` 端点已收敛 **admin-only**(2026-08-29 裁决 A)。
- `GET /api/ssh/ledger` 已返回后端实时渲染的 `markdown`(renderServerLedger 结构层)+ 自由层 notes。
- 人手 SSH 操作审计:`source='platform'`、tool 名 `ssh_sftp`/`ssh_ledger`/`ssh_server`(routes.mjs audit 助手);AI 的 SSH 调用:`source='workbench'`、resource 按 `SshServer/<id>` 归因(agent-runner.mjs)。
- `queryAuditLog`(audit.mjs)已支持 `source`/`tool` 精确过滤,**不支持前缀**过滤。
- 记录页 storage 块已展示 `dbPath`/`workbenchDir`——配置 tab 的「项目根目录」是纯重复。
- AI 行为配置(禁用工具/附加提示词/工具目录)已有 admin 页 `AiBehaviorConfig.vue`。

## 2. 用户裁决记录(逐问确认)

1. **核心诉求**:概念/导航混乱(优先理顺信息架构,非补功能)。
2. **心智模型**:双域并行——集群世界与服务器世界两个平行域;全局只放真正跨域的东西(知识库、审计)。
3. **配置 tab 处置**:拆散归位,五 tab 变四。
4. **台账体系**:域内自治 + 形态对齐——两套台账机制各自留在自己域内,交互形态对齐,不强制合一套机制。
5. **方案选择**:方案 A(五 tab 收敛为四),否决域优先两级导航(方案 B)与最小归位(方案 C)。

## 3. 目标 / 非目标

**目标**

- 消除「全局」名不副实:tab 更名「知识」,承载跨域知识(集群台账 + 服务器台账)。
- 服务器作为服务器域在导航中获得正确位置与可见性(admin)。
- 记录页补齐服务器维度:统计卡 + 审计来源口径(AI / 人工 SSH 操作)。
- 配置 tab 拆散归位后删除。
- 台账形态对齐:服务器台账获得与集群台账一致的查看/编辑体验(同一面板组件两处复用)。

**非目标(本期明确不做)**

- 服务器域会话/项目(服务器域的工作单元)。
- 项目 × 服务器关联(项目仍集群单绑)。
- 服务器台账 Distill 管线(等服务器域有对话产物再议)。
- 存储分析的服务器维度(终端不落盘、SFTP 直传不驻留、凭据加密列已含在 dbSize)。
- tab 深链路由化。

## 4. 目标态信息架构

| Tab | 键 | 内容域 | 可见性 |
|---|---|---|---|
| 项目 | `projects` | 集群域工作单元(不变) | 所有人 |
| 服务器 | `servers` | 服务器域:机队/终端/文件/台账弹窗 | **仅 admin** |
| 知识 | `knowledge`(原 `global`) | 跨域知识:集群台账区 + 服务器台账区 | 集群区所有人;服务器区仅 admin |
| 记录 | `records` | 跨域记录:统计/存储/对话/审计 | 所有人(审计区事实上的 admin) |

顺序:项目 → 服务器 → 知识 → 记录(资产在前、横切在后)。

## 5. 设计细节

### Section A:Shell 导航重排(src/views/WorkbenchShell.vue)

- `tabs` 数组重排为 `projects / servers / knowledge / records`;删除 `config` 项;`global` 键改名 `knowledge`,图标 `public` → `menu_book`。
- 服务器 tab 加 `v-if="auth.isAdmin"`(唯一新增可见性规则;依据 SSH 全端点 admin-only,非 admin 进入只会看到报错面)。
- 模板中 `WorkbenchConfig` 分支与 import 删除。
- i18n:新增 `workbench.shell.tabKnowledge`;删除 `workbench.shell.tabConfig` / `tabGlobal`(zh/en 同步)。

### Section B:知识 tab(src/views/WorkbenchLedger.vue 改造)

顶部两区分段切换:「集群台账」|「服务器台账」,懒加载、互不阻塞、失败隔离(各自 try/catch + notify)。

- **集群区**:现 WorkbenchLedger 内容原样保留(集群选择器、Bootstrap/Distill、INDEX/learnings 展示、pending 审批横幅、diff Modal)。
- **服务器区**(仅 admin 渲染):
  - 结构层只读视图:展示 `GET /api/ssh/ledger` 返回的 `markdown`,形态与集群台账的 `pre` 块对齐(纯文本,不开 HTML 渲染,无 XSS 面)。
  - 自由层编辑:全局备注 + 每服务器备注行内编辑,走既有 `PUT /api/ssh/ledger`(scope 语义、64KB 上限由后端承担,面板透传错误)。
  - 抽组件 `src/components/ssh/ServerLedgerPanel.vue`:承载「渲染视图 + 自由层编辑」;WorkbenchServers.vue 现有 ledger 弹窗(`btnLedger`/`ledgerModal`)改为包裹该面板——**一套实现两个入口,数据单源在后端**。
  - 不上 Distill(见非目标)。

### Section C:记录 tab(src/views/WorkbenchRecords.vue)

- 统计卡 4 → 5:新增「服务器」卡(总数 + 暴露给 AI 数)。数据走 `sshApi.list()`(与卡片同为 admin-only,可见性一致);非 admin 不发请求、不显示该卡。不改 `workbenchApi.records()` 聚合,避免把 admin 域数据混进普通用户端点。
- 审计区加「来源」筛选(下拉):
  - `工作台 AI`(默认)→ `source=workbench`(保持现状口径)
  - `服务器人工操作` → `source=platform` + `toolPrefix=ssh`
  - `全部` → 不传 source
  - 行首加来源小标签(AI / 人工),「全部」视图混排可辨。
- 后端唯一小改:`queryAuditLog` 增加 `toolPrefix` 参数(`WHERE tool LIKE ? || '%'`,audit.mjs 一行 where 子句),`/api/admin/audit-log` 路由透传该 query param(路由已登记 ROUTE_AUTH,无新路由)。
- 存储块与对话列表不动(见非目标)。

### Section D:配置拆散(src/views/WorkbenchConfig.vue 删除)

| 现有内容 | 去向 | 理由 |
|---|---|---|
| 悬浮对话入口配置(presence) | 迁入 admin `AiBehaviorConfig.vue`(卡片式) | 同属工作台 AI 行为配置;`savePresence` 逻辑原样搬 |
| Distill 状态块 | 删 | 坏占位符(渲染 `=server-side/check gateway`);知识 tab 已有真实 Distill 状态 |
| 集群绑定列表 | 删 | 记录页集群明细 + 项目卡标注已覆盖;省一次 `myClusters` 请求 |
| 项目根目录 | 删 | 记录页 storage 块已展示 `workbenchDir`/`dbPath`,纯重复 |

配套:`WorkbenchConfig.presence.test.js` 迁移为 AiBehaviorConfig 侧 presence 测试;presence i18n 键迁至 admin 命名空间;`workbench.config.*` 余键随视图删除清理。

### Section E:边界与错误处理

- 非 admin:服务器 tab 隐藏、知识 tab 服务器区隐藏、记录页服务器卡不发请求——不出现「能看到但全是报错」的面。
- `ServerLedgerPanel` 零服务器空态:引导文案(先在服务器页添加服务器)。
- notes 编辑失败(64KB 超限等)透传后端 message + notify,面板不自制校验规则(校验单源在后端)。
- 知识 tab 两区加载失败互不影响。

## 6. 测试与门禁

- 迁移:`WorkbenchConfig.presence.test.js` → `AiBehaviorConfig` presence 测试。
- 新增/更新:
  - `ServerLedgerPanel` 组件测试(mock `sshApi`;Modal 断言查 `document.body`)。
  - Shell tab 断言更新(4 tab + 服务器 tab admin-only)。
  - Records 来源筛选测试(断言 `auditTrail.list` 收到的参数)。
  - 后端 `queryAuditLog` 的 `toolPrefix` 单测。
- 门禁:`npm run i18n:check`(删键/迁键后对齐)+ vitest 全绿。

## 7. 验收标准

1. 工作台恰好四个 tab:项目/服务器/知识/记录;「配置」「全局」不复存在(admin 与非 admin 一致,服务器 tab 仅 admin 可见)。
2. 知识 tab 两区均可查看/编辑各自台账;服务器 tab 弹窗与知识 tab 服务器区编辑同一份数据(一端保存另一端重开可见)。
3. 记录页:admin 可见服务器统计卡;审计来源筛选三种口径均能取到预期数据(服务器人工操作可见 `ssh_*` 记录)。
4. AiBehaviorConfig 页可读/存悬浮对话配置,行为与原配置 tab 一致(保存后全端生效)。
5. 非 admin 全程无 SSH 域报错面;i18n:check 与 vitest 全绿。

## 8. 涉及文件清单

| 文件 | 动作 |
|---|---|
| `src/views/WorkbenchShell.vue` | 改:tabs 重排/删 config/服务器 tab admin-only |
| `src/views/WorkbenchLedger.vue` | 改:两区分段切换,纳服务器区 |
| `src/components/ssh/ServerLedgerPanel.vue` | 新:台账面板(渲染+自由层编辑) |
| `src/views/WorkbenchServers.vue` | 改:ledger 弹窗改包 ServerLedgerPanel |
| `src/views/WorkbenchRecords.vue` | 改:服务器统计卡 + 审计来源筛选 |
| `src/views/WorkbenchConfig.vue` | 删 |
| `src/views/admin/AiBehaviorConfig.vue` | 改:纳 presence 卡 |
| `src/views/__tests__/WorkbenchConfig.presence.test.js` | 迁移 |
| `server/audit.mjs` | 改:`toolPrefix` 参数 |
| `server/routes/admin.mjs` | 改:透传 `toolPrefix` |
| `src/locales/zh.json` / `en.json` | 改:增删迁键 |

## 9. 手测清单(需真机/集群,延后)

- admin/非 admin 双身份过一遍四 tab 可见性与数据。
- 知识 tab 服务器台账编辑 → 服务器 tab 弹窗重开数据一致(反向亦然)。
- AI 对话触发 `wb_ssh_exec` 后,记录页「工作台 AI」口径可见;人手 SFTP 上传后「服务器人工操作」口径可见。
- 悬浮对话配置在 AiBehaviorConfig 修改后,悬浮入口行为按新值生效(约 10s)。
