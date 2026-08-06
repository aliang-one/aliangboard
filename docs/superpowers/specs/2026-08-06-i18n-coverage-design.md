# i18n 覆盖修复设计（消除硬编码中文）

> 日期：2026-08-06
> 分支：`worktree-fix-i18n`（worktree：`.claude/worktrees/fix-i18n`）
> 状态：方案已与用户对齐，待 spec review

## 1. 背景与现状

AliangBoard 前端使用 `vue-i18n@11`（`legacy:false`、`locale: zh`、`fallbackLocale: en`），翻译文件 `src/locales/{zh,en}.json`，配置在 `src/i18n.js`。

经核查：

- **键对齐良好**：zh 1299 叶子键，en 1303；仅 4 个键 en 有 zh 无（`workload.workloads.{restartSuccess,restartFailed,emptyTitle,emptyDescription}`）。
- **en.json 已全部翻译**：0 个含中文的值 → 「键存在但值未译」失败模式排除。
- **真正问题 = 硬编码绕过 `t()`**：89/111 个 `.vue` 文件含中文，约 250 处，分布：
  - 模板文本节点 ~132
  - 脚本侧字符串（`ElMessage`/`alert`/`throw` 等）~60
  - HTML 属性（`title`/`placeholder`/`aria`…）~49
  - 绑定属性（`:title="`中文`"`）~9
  - 含中文且已用 `$t`/`t(` 的行：0（几乎所有中文都是硬编码）
- 重灾区（按硬编码中文行数）：`NsWorkloadDetail.vue`(151)、`DeployApp.vue`(60)、`admin/ApiKeyManagement`(57)、`NsServiceDetail.vue`(53)、`admin/AgentConsole`(49)、`admin/UserManagement`(47)、`InteractiveTerminal.vue`(37)、`FileBrowserBody.vue`(34)。
- 集中在**较新特性**（admin 全家桶 / 终端 / 文件浏览器 / `Ns*Detail` 详情页）——这些模块构建时未做 i18n。

## 2. 目标与范围

- **目标**：消除全部用户可见的硬编码中文字符串，使其经 `t()` 走 i18n；`en.json` 保持完整翻译。
- **本轮范围**：全量覆盖 89 个文件，按区域分批提交。
- **纳入翻译**：模板可见文本、UI 属性（`title`/`placeholder`/`aria-label`/`alt`/`label`）、`ElMessage`/`ElNotification`/`ElMessageBox`/`alert`/`confirm`、用户可见的抛出错误。
- **不翻译（排除）**：纯 `console.*` 开发日志、专有名词/品牌词（如 `zh.json` 中已刻意保留英文的 "Nodes"/"Resource Utilization" 等）、代码注释。

## 3. 约定（与现有代码一致，强制基线）

- **键命名**：`namespace.camelCaseLeaf`。新串归入所属视图命名空间（已有则复用，如 `nsWorkloadDetail.*`、`admin.apiKeys.*`）；通用词复用 `common.*`，不重复造。
- **`<script setup>`**：`import { useI18n } from 'vue-i18n'; const { t } = useI18n()`；模板用 `t(...)`（非 `$t`）。
- **插值**：`{var}` 占位 → `t('key', { var })`；值内允许 HTML（现有模式）。
- **双语**：每个新键同时给 zh（中文）与 en（英文）值。
- **去重**：相同语义跨文件复用同一键（尤其 `common.*`），按语义命名（如 `deleteSuccess`、`restartConfirm`）。

## 4. 执行方式：混合 + 验证脚手架

**核心难点**：所有改动都要往同一对 `zh.json`/`en.json` 加键，朴素并行会互相覆盖。

**解法**：

- 子代理**只改 `.vue`**，并以**结构化输出返回 `{key, zh, en}[]`**；由主流程串行合并进两个 JSON。无写冲突，可真并行。
- **每区域验证脚手架**（客观判据）：该区域文件残存 CJK grep（目标 0 或已说明）+ `npm run build`（编译所有 `.vue`）+ `npm run typecheck`。

## 5. 节奏（先样本 · 确认后放行）

- **Phase 0**：写本约定文档 + 残存-CJK 检查脚本（`scripts/i18n-check.mjs`，列出每个 `.vue` 残存中文行）。
- **Phase 1 样本**：主流程亲自转 `common 组件 + layout/nav`，提交。用户 review 风格/质量并放行。
- **Phase 2 批量**：按区域派并行子代理转其余区域；主流程合并 JSON + 每区域跑脚手架 + 审 diff。
- **Phase 3 验收**：全树残存-CJK 扫描、完整 `build`+`typecheck`，可选启动应用切换 EN/中文 走查。

**区域拆分（5 批）**：

1. common 组件 + layout/nav（样本）
2. core 集群/命名空间 views（`Namespace*`、`NsServices`、`NsIngress`、`NsLayers`、`CrdDetail`、`PriorityClasses`、`MonitoringCenter`…）
3. 详情/工作负载 views（`NsWorkloadDetail`[151]、`NsServiceDetail`、`PodDetail`、`WorkbenchLedger`、`DeployApp`）
4. `admin/*`（`ApiKeyManagement`、`AgentConsole`、`UserManagement`、`LlmConfig`、`ClusterManagement`）
5. 终端 + 文件浏览器（`InteractiveTerminal`、`FileBrowserBody`、`TerminalWindow`、`PortSelect`、`ResourceReferences`）

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 子代理键命名不一致 / 漏译 | 紧约定文档 + 残存-CJK grep 客观兜底 + 主流程审每个 diff |
| 动态字符串 / 模板字面量难处理 | 逐处判断，必要时拆键或用插值 |
| 误伤刻意保留英文的专有名词 | 转换时保留既有英文值；以 `zh.json` 现状为准 |
| JSON 合并出错（语法 / 重复键） | 合并后 `node -e` 加载校验 + `typecheck` + `build` |
| 4 个 en 有 zh 无的键 | 顺手补齐 zh（`workload.workloads.*`） |

## 7. 验收标准

- 全树 `scripts/i18n-check.mjs` 报告：用户可见残存中文 = 0（`console`/注释除外）。
- `npm run build` 通过（所有 `.vue` 编译）。
- `npm run typecheck` 通过。
- zh / en 键完全对齐（0 个仅一侧有的键）。
