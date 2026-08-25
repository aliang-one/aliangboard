# issue #3 后续三项修复设计(TLS Secret 下拉 / 顶栏溢出 / Pod 批量删除)

日期:2026-08-25 · 来源:[aliang-one/aliangboard#3](https://github.com/aliang-one/aliangboard/issues/3) 第 2/5/6 点 · 状态:已与用户对齐

## Context

issue #3(2026-08-25)反馈六点,第 3 点(toast 被弹框糊化)已修(d5eb95d,zScale 单一事实源)。本设计覆盖其余三点中被裁决的三项:

- **第 5 点**:「tls不支持直接下拉选择…只能输入名字,很容易出错」「给了个下拉图标,但是又不能下拉选择」
- **第 6 点(部分)**:「部分UI效果,展示跨界了」——用户确认现象为顶栏整行横向挤出
- **第 2 点**:「pod不支持批量删除,批量删除需求很高」

用户已裁决:溢出按「整行横向挤出」假设修;Secret 下拉复用 PortSelect;批量删除走卡片选择模式。

## A. 顶栏整行横向溢出修复

### 根因

`TopNavBar.vue` 集群按钮名字区早有 `max-w-[180px] + truncate`(2026-06 起),单靠名字撑不破按钮;但左组 `flex-1` **无 `min-w-0`**、搜索框包裹层 `min-width:auto` 阻断收缩——搜索框(max-w-md=448px)+ 集群按钮(名字封顶后 ~276px)+ ns 按钮(~256px)+ 右侧用户区(~280px),集群/ns 名字长或窗口窄时**整行横向挤出屏幕**。

### 改法(纯 CSS 类级,零逻辑改动)

`src/components/layout/TopNavBar.vue`:

1. 左组(:142)加 `min-w-0`;搜索框包裹层(:143)加 `min-w-0` → **搜索框优先收缩**
2. 集群(:166)/ns(:225)按钮包裹层加 `shrink-0`(名字已封顶,宽度有界,不再被压)
3. 集群(:177)/ns(:238)名字 span 加 `:title`(截断后悬停见全名)
4. 集群下拉列表 `version · distribution` 行(:212)加 `truncate`;右侧用户名(:279)加 `max-w-[120px] truncate` + `:title`(同族隐患)

### 测试

新 `src/components/layout/__tests__/TopNavBar.test.js`:断言搜索框包裹层含 `min-w-0`、名字 span 带 title 属性、用户名 span 含 truncate(锁住类契约,防回归)。

## B. TLS Secret 下拉(复用 PortSelect)

### 根因

TLS Secret 两种现状都不合格:创建表单(`IngressRulesEditor.vue:149`)纯手输——「只能输入名字,很容易出错」;详情页编辑(`NsIngressDetail.vue:508`)用原生 `<datalist>`——候选为空时 Chrome 仍渲染 ▾ 图标但点开无项,即「给了个下拉图标,但是又不能下拉选择」。

### 改法

- `IngressRulesEditor.vue`:新增 prop `secrets: Array`(候选 Secret **名**数组,父级已过滤),:149 的 input → `PortSelect`(平铺模式,可下拉可手输兜底,`empty-hint` 空态提示)
- 三处父级接入(候选均按 `type === 'kubernetes.io/tls'` 过滤后传名):
  - `NsIngress.vue`(③独立创建)、`DeployApp.vue`(①向导):新增 `useResourceList(['cluster', cid, 'secrets'], () => store.fetchSecrets())`(仓库既有模式)
  - `NsIngressDetail.vue`:④规则编辑传入既有 `_secQ`;②TLS 编辑弹窗 :508 的 datalist input → `PortSelect`
- 新 i18n 键 `ns.ingressDetail.noTlsSecretsHint`(中英双语,过 `i18n:check` 门禁)

### 测试

新 `src/components/common/__tests__/IngressRulesEditor.test.js`:mount withTls + host(tls:true) → 断言 PortSelect 接到 `options`=候选名、`empty-hint`=i18n 键渲染。

## C. Pods 批量删除(卡片选择模式)

### 现状

`NsPods.vue` 是 PodCard 卡片网格 + 搜索/状态/节点筛选 + 分页;单删走 PodCard `show-delete` → Modal 确认 → `store.deletePod`。全仓批量先例(NsSecrets/NsConfigMaps)是 DataTable checkbox,但 NsPods 无表格形态;**保留卡片 UX,加选择模式**。

### 改法

- `PodCard.vue`:新 prop `selectable: Boolean` → 行1健康点前渲染 checkbox 视觉(`check_box`/`check_box_outline_blank`,随 `selected` prop 态);`pointer-events-none`,由卡片统一 `@click` 触发(避免双击发)
- `NsPods.vue`:
  - 工具栏加「批量删除」按钮(`delete_sweep` 图标)进入/退出批量模式;退出清空选中
  - 批量模式下:卡片 `@click` = 切换选中(替代导航);筛选行右侧出现操作条:`已选 {n}` + `全选`(当前 `filtered` 全集,跨页)+ `清空` + `删除所选`(红,n=0 禁用)
  - 选中集 `Set<podName>`(普通 ref,`.has/.add/.delete`),跨分页/筛选变更保留;列表数据刷新后对已消失的名字自动无效(删除前以当前 `nsPods` 校验存在性)
  - 确认 Modal(消费 Z.modal):显示数量 + 前 10 个名字(余 `…等 N 个`)+ 警告「Deployment 等控制器管理的 Pod 删除后会被自动重建」
  - 执行:`Promise.allSettled(selected.map(p => store.deletePod(p.name, ns)))` → 纯函数 `summarizeResults`(新 `src/utils/batchDelete.js`)汇总 → 全成 notify success「已删除 N 个 Pod」/有败 notify error「成功 X,失败 Y:name1, name2」;失败项保留选中便于重试,全成清空并退出批量模式
- 新 i18n 键 ~8 个(`ns.pods.batch*`,中英双语)
- WorkloadDetail/ServiceDetail 的 PodCard **不加**批量(仅 NsPods)

### 测试

- `PodCard.test.js` 补:`selectable` 渲染 checkbox、`selected` 态图标切换、点击仍 emit click
- 新 `src/utils/__tests__/batchDelete.test.js`:`summarizeResults` 全成/部分败/全败三态
- NsPods 交互挂载测试成本高(需 mock query/pinia),靠 PodCard+纯函数覆盖 + 手测

## 验证

- 门禁四连:`npm run test:unit` + `npm test`(含 server)+ `npm run typecheck` + `npm run build`;`npm run i18n:check` 过
- 手测(需集群):
  1. 顶栏:注册长名集群(>30 字符)+ 窄窗口 → 整行不横向滚动,搜索框先缩,悬停名字见全名
  2. Ingress 创建向导/独立创建勾 TLS → 下拉出 TLS 类型 Secret;空命名空间显示空态提示;手输仍可
  3. 详情页 TLS 编辑:下拉可选(datalist 假图标消失)
  4. Pods:进批量模式 → 点卡片多选(跨翻页保留)→ 全选/清空 → 确认弹窗名单 → 删除 → toast 汇总;断网/无权场景部分失败提示

## 明确不做(范围外)

- issue #3 第 1 点(中文模式残留英文)、第 4 点(init/sidecar 容器区拥挤)、第 6 点另一半(Secrets/ConfigMaps 全屏/tab 化编辑)——另行任务
- Pods 卡片/表格双视图切换
- 跨命名空间批量删除、服务端批量删除端点
