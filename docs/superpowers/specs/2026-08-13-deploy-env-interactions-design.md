# DeployApp 环境变量交互修复(①-⑦)

## 背景

对创建 workload 向导 Step 2 的「整体引用(envFrom)」与「单 Key 引用」两块交互做了审计,发现 7 个问题(3 个值得修的交互缺陷 + 4 个低优先瑕疵),用户裁决:**全部处理**。

审计发现(编号沿用审计报告):

1. **重复 env 名无校验**:`envVars`/`envCMKeys`/`envSecretKeys` 三处(及各自内部)可填出同名 ENV_NAME;`validate()` 只查每行完整性。K8s API server 对 `env` 重复名直接拒绝 → 用户在 apply 时才收到难懂的服务端报错。
2. **换资源后旧 key 残留**:`EnvSourceField` 的 `dataKey` 是自由文本;换了 ConfigMap/Secret 后旧 key 静默保留 → 生成的 `valueFrom` 指向不存在的 key → Pod `CreateContainerConfigError`。
3. **空行卡部署 + 与 YAML 生成不一致**:加了行又不想填 → 校验报错卡住部署;而 YAML 生成端是静默 `.filter()` 跳过。两端行为矛盾。
4. **ns 漂移无提示**:回 Step 1 改 namespace 后,Step 2 已选资源名残留、key 候选消失,无任何提示。
5. **envFrom 覆盖优先级无提示**:env 覆盖 envFrom、Secret 同 key 覆盖 ConfigMap,均为 K8s 文档化行为,UI 无 hint。
6. **combobox 键盘交互缺失**:Tab 聚焦弹面板但 Tab 离开不关;无 ↑/↓/Enter/Esc 导航。
7. **query key 非响应式**:`EnvSourceField.vue:26-27` 等 ~12 处 `key: ['cluster', xxx.value, ...]` 在 setup 时快照集群 id;当前被「切集群重挂页面 + queryClient.clear()」掩盖,属全库潜在缓存一致性地雷。

## 已裁决决策(用户拍板)

- ② → **换资源即清空 key**(用户交互触发;程序化赋值不清,保护「复制 workload」回填)。
- ④ → **字段下警示文案**(不拦提交,尊重跨 ns 手输)。
- 全部 7 项都修(含 ⑦ 全库清点)。

## 设计

### A. 校验层(①③)— `src/views/DeployApp.vue` `validate()`

- **重复名**:收集三处非空名(`envVars[].key`、`envCMKeys[].name`、`envSecretKeys[].name`),发现重复报 `{step: 1, msg: t('deploy.envDuplicateName', {name})}`,报第一个。
- **空行跳过**:整行全空 → 跳过(`envVars`:key+value 皆空;`envCMKeys`/`envSecretKeys`:name+资源名+key 皆空);半填 → 沿用现有报错键。
- 抽纯函数 `src/utils/envRows.js`:`isEmptyEnvRow(row, fields)` 与 `firstDuplicateEnvName(envVars, envCMKeys, envSecretKeys)`。测试走 node:test 纯逻辑通道:`src/utils/envRows.test.mjs`(.mjs / node:test 语法,vitest 不收 .mjs),并在 `package.json` 的 `test:server` 链显式追加 `node --test src/utils/envRows.test.mjs`(仓库惯例:纯逻辑测试须注册)。`validate()` 留在组件内调用它们。

### B. EnvSourceField 交互(②④⑥)— `src/components/common/EnvSourceField.vue`

- **②**:name 输入框 `@input` 时清 `dataKey`(仅 `withKey` 模式);`pickName()` 选中后也清。input 事件只由用户键入触发 → 程序化 v-model 赋值(复制 workload 回填)不清。
- **④**:`computed` 判定「name 非空 && 资源列表已成功加载 && 当前 ns 无精确匹配」→ 模板在输入行下渲染一行淡红小字 `$t('envSource.nsMissing')`,不拦提交。
- **⑥**:name/key 两个 combobox 增加 ↑/↓ 移动高亮项、Enter 选中、Esc 关闭、`@blur` 关闭(下拉选项 `mousedown.prevent` 保焦,不受 blur 影响)。

### C. envFrom 优先级提示(⑤)— DeployApp.vue

envFrom 区块(grid)下方一行灰字 hint:`$t('deploy.envFromHint')`,内容:「同名时独立环境变量优先于整体引用;ConfigMap 与 Secret 同名 key 时 Secret 生效」。

### D. query key 响应式化(⑦)

全部 `key: ['cluster', xxx.value, ...]` → `key: ['cluster', xxx, ...]`(传 ref 本体;@tanstack/vue-query v5 支持 key 内 ref,响应式解包)。改动点以 `grep -rn "useResourceList({ key: \[.*\.value" src/` 全量清点,已知 ≥ `EnvSourceField`×2、`TagInput`、`CreatePvcDialog`、`TopNavBar`×8。集群不切时零行为变化。

### E. i18n

`src/locales/zh.json` + `en.json` 同步新增:
- `deploy.envDuplicateName`(① 报错文案)
- `deploy.envFromHint`(⑤)
- `envSource.nsMissing`(④)

门禁:`npm run i18n:check`。

## 测试

- **纯逻辑(A)**:`scripts/test.mjs` 零依赖运行器,覆盖空行判定(全空/半填/合法)与重复名(跨三处、各自内部、无重复)。
- **EnvSourceField(②④)**:vitest 组件测试(`npm run test:unit`,mock `useClusterStore` + `useResourceList`):用户键入清 key、`pickName` 清 key、程序化赋值不清、ns 不匹配显警示/匹配不显。
- **⑥⑦**:⑥ 手测/browse;⑦ 静态审查(grep 无残留 `.value` 快照)+ 全量门禁。
- 全量:`npm test` + `npm run test:unit` + `npm run typecheck` + `npm run build` + `npm run i18n:check`。

## 非目标

- 不改 envFrom「单 CM + 单 Secret」的结构(K8s 允许多 ref,UI 保持现状)。
- 不改 YAML 生成格式(除校验行为变化带来的输入侧影响外,生成端逻辑不动)。
- 不动 ports 等其他区块的同款「空行卡部署」模式(同 pattern,另行处理)。
- 不重写 EnvSourceField 为通用 combobox 组件(仅就地补交互)。

## 影响面

- `src/views/DeployApp.vue`(validate + envFrom hint 模板)
- `src/components/common/EnvSourceField.vue`(②④⑥)
- `src/components/common/TagInput.vue`、`src/components/common/CreatePvcDialog.vue`、`src/components/layout/TopNavBar.vue` + grep 清点的其余调用点(⑦)
- `src/utils/envRows.js`(新)+ `src/utils/envRows.test.mjs`(新)+ `package.json`(`test:server` 注册一行)
- `src/locales/zh.json`、`src/locales/en.json`(3 键 ×2)
