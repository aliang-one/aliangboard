# Init/Sidecar 容器编辑弹窗设计(2026-08-25)

## 背景与目标

创建 workload 向导(`DeployApp.vue` 步骤 2)中,init 容器与 sidecar 容器左右并排半宽卡片,每容器 8 字段(name/image/command/args/CPU·内存 req/lim)挤在 2 列小格中,用户反馈空间太小、不便输入。

**目标**:维持现有页面布局不变,每个容器卡片加一个「最大化」图标,点击弹出 modal 提供完整排版编辑;全程自动输入校验。

**非目标**:不扩充字段集(仍为现有 8 字段)、不改复制回填映射、不动主容器表单。YAML 生成仅修一处既有缺陷(见「顺带修一个真 bug」:派生名去重播种漏显式名),8 字段的生成语义不变。

## 已裁决决策(与用户逐项确认)

| 决策点 | 结论 |
|--------|------|
| 图标粒度 | 每个容器卡片一个,modal 编辑单个容器 |
| 字段范围 | 仅现有 8 字段 + 完整排版(分组/真实 label/全宽输入) |
| 校验时机 | modal 内实时校验 + 确认拦截;提交时统一校验同步接入 |
| 名字查重 | 包含:显式名 vs 主容器有效名/其他显式名 |

## 方案(已选 A:独立弹窗组件 + 纯函数校验模块)

对比过的备选:B(卡片与弹窗合并双模式组件——迁移现有卡片模板,回归风险高)、C(页内全宽展开——非 modal 形态,布局跳动)。均否决。

## 架构与组件

- **新组件 `src/components/common/ContainerEditorDialog.vue`**
  - 复用共享 `Modal.vue` 壳(`Z.modal` z 层、ESC、遮罩),宽 `max-w-2xl`。
  - Props:`modelValue: Boolean`、`container: Object`、`kind: 'init'|'sidecar'`、`index: Number`、`otherNames: String[]`(查重用,含主容器有效名 `containerName || name` 与其他容器显式名)。
  - 自带 `actions` 插槽底部按钮(不用 Modal 默认 confirm——需非法时禁用确认)。
- **入口图标**:每个 init/sidecar 卡片顶部加一行小头部:左侧 `容器 #N` 徽标 + 右侧 `open_in_full` 图标按钮(title/aria-label 走 i18n)。紧凑卡片其余部分一行不动(现有 `data-testid` 全保留)。
- **新纯函数模块 `src/logic/containerValidation.js`**(与 workloadMeta 同目录,无 Vue 依赖,零依赖可测)。
- **新 util `src/utils/containerNames.js`**:从 DeployApp 抽出 `derivedContainerName` 的字符串清洗部分,单一事实源;DeployApp YAML 生成、modal 派生名预览、校验三处共用。

### modal 内排版

- 标题:「编辑 Init 容器 / 编辑 Sidecar 容器」+ 容器名或 `#序号` 副标(mono)。
- 分组小节:
  - 基本信息:name(选填,留空自动派生)、image(必填)
  - 启动命令:command(全宽,提示 shell token 语义)、args(textarea rows≈6,提示每行一条)
  - 资源:CPU/内存 req/lim 各一行(复用 `ResourceInput`,数字+单位下拉天然防脏串)

## 数据流

- 打开:`draft = { ...container }`(8 字段全是字符串,浅拷贝即深拷贝)。
- 确认(合法才可点):`emit('confirm', { ...draft })` → DeployApp `Object.assign(form.initContainers[idx], payload)`。原数组槽位身份不变,步骤 2 卷挂载 `init:idx`/`sidecar:idx` target 引用天然稳定。
- 取消/X/ESC/遮罩:丢弃 draft 直接关,不写回。
- 原地小卡片仍可直接编辑(维持布局):两入口写同一对象,校验靠单源函数兜底。

## 校验规则(单源:`containerValidation.js`)

作用于「非空行」容器(与现有 `isEmptyEnvRow` 语义一致;空行整体跳过,YAML 生成同样跳过):

1. **image 必填**(无 image 的容器 YAML 生成本来就会丢弃)。
2. **name 选填;填了必须 DNS-1123**(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)。
3. **CPU/内存 request ≤ limit**(新增强约束;`compareQuantity` 基于已有 `parseQuantity` 归一:cpu 折毫核、内存折 Ki)。
4. **名字查重**:显式名 ≠ 主容器有效名、≠ 其他容器显式名(init+sidecar 全集)。

**顺带修一个真 bug**:现 YAML 生成 `usedContainerNames` 只播种主容器名,不含显式名——显式 "nginx" + 另一容器镜像 nginx → 派生 "nginx" 撞车,K8s 硬拒。修法:播种集合加入全部显式名,修后派生名永不与显式名撞车(校验只需管显式名冲突)。

**返回形态**:仿 `validateIngressAdv` 惯例返回 `{ field, msgKey, params? }[]`,调用方翻译。

## 错误呈现

- modal 内每字段实时计算错误;**blur 过或点过确认后才显示**(避免新容器一打开满屏红)。红边框 + 下方 `text-xs text-error` 消息。
- 确认按钮非法时禁用,附近一句禁用原因提示。
- **派生名预览**:name 为空时提示「留空将自动命名:`xxx`」(共享清洗函数);若与现有名冲突注明「生成时自动去重(如 xxx-2)」。
- 提交时 `validate()` 接入同一校验函数(覆盖原地编辑路径),错误仍走现有 `{step:1}` 跳步 + toast。

## i18n 与无障碍

- 新键全走 `deploy.*`,en.json + zh.json 同步(过 `npm run i18n:check` 门禁)。
- 消息值不含 `@`(规避 vue-i18n 转义坑)、不含 HTML(不需要 v-html)。
- 图标按钮带 title/aria-label。

## 测试

- **纯逻辑(零依赖运行器)** `containerValidation.test.mjs`:数量比较(cpu cores vs m、Ki/Gi 换算)、四条规则正反例、显式名播种去重修复回归例。
- **组件(vitest)** `ContainerEditorDialog.test.js`:打开回显、blur 显错、非法禁确认、确认 emit 完整 payload、取消不写回;DeployApp 集成:点图标打开正确容器、确认写回正确索引。
- 存量测试(`DeployApp.container-names` / `command-args` 等)保持绿。

## 改动文件清单

新增:`ContainerEditorDialog.vue`、`src/logic/containerValidation.js`(+test)、`src/utils/containerNames.js`、组件测试。
编辑:`DeployApp.vue`(卡片头部+图标、弹窗接线、validate() 扩展、usedContainerNames 播种修复、derivedContainerName 改引共享 util)、`en.json`/`zh.json`。
