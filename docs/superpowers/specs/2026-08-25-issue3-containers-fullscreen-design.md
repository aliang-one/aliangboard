# issue #3 收尾两项设计(init/sidecar 容器区解挤 + Secret/ConfigMap 全屏编辑)

日期:2026-08-25 · 来源:[aliang-one/aliangboard#3](https://github.com/aliang-one/aliangboard/issues/3) 第 4/6 点 · 状态:已与用户对齐

## Context

issue #3 第 4 点原文:「初始容器、额外容器区域太小,配置起来很别扭」;第 6 点(配置场景部分):「部分区域的UI太小太窄,不符合配置场景」+ 建议 secret/configs 可全屏操作(参考 Kuboard v4 tab 式)。第 1 点(i18n)由并行会话认领,第 2/3/5 点已修(61e1110 等)。

用户已裁决:④ 纵向堆叠+可折叠;⑥ Modal 加 fullscreen prop、创建流全屏化(表单/YAML 双 tab);⑥b Secret 详情编辑改宽,ConfigMap 详情不动。

## ④ init/sidecar 纵向堆叠 + 可折叠容器卡

### 现状与问题

`DeployApp.vue:1092-1155`:init/sidecar 左右并排(`grid-cols-1 md:grid-cols-2`),每列 ~430px;每卡 8+ 字段挤 grid-cols-2(name/image、command/args rows=2、4×ResourceInput 两层堆叠);无分区层次(对比主容器 62% 宽+分区布局)。

### 设计

**新组件 `src/components/common/InitSideContainerEditor.vue`**(init/sidecar 字段集相同,一组件两用):

- Props:`container: Object`(行对象,字段直接 v-model——仿 IngressRulesEditor 契约)、`kind: 'init'|'sidecar'`(徽章/占位文案差异)、`index: Number`
- Emits:`remove`(携 index 由父级删,父级持有数组)
- **折叠态**(默认;`!container.name` 的空容器自动展开):徽章(Init/Sidecar)+ name(缺省「未命名」)+ image(truncate)+ 资源摘要(非空的 `cpuRequest/cpuLimit/memoryRequest/memoryLimit` 值以 ` · ` 连接,全空则不示)+ 展开/收起箭头(rotate 过渡)+ 删除按钮
- **展开态**编辑器(全宽):
  - 行1:`name`(`w-40`)+ `image`(`flex-1`)
  - 进程执行区:`command` + `args`(**textarea rows=4**,grid-cols-[auto,1fr])
  - 资源区:4×ResourceInput 单行 `grid-cols-2 md:grid-cols-4`
- **折叠/展开用 `v-show`**(非 v-if):`DeployApp.command-args.test.js:69-73` 断言 `[data-testid="init-command-input"]` 等**存在于 DOM**——testid 全部保留原值(init/sidecar 前缀区分),DOM 常驻仅 display 切换
- 字段绑定键与现有一致:`name/image/command/args/cpuRequest/cpuLimit/memoryRequest/memoryLimit`

**DeployApp.vue 改造**(:1092-1155):

- 双列 grid → init 块、sidecar 块**纵向堆叠**(各自标题条+计数徽章保留)
- 两个 v-for 体各换一行 `<InitSideContainerEditor :container="c" :kind="'init'|'sidecar'" :index="idx" @remove="removeInitContainer|removeExtraContainer" />`
- `addInitContainer/addExtraContainer/removeXxx` 与表单模型、Step 6 YAML 预览(previewYAML 读同一数组)**零改动**

### 明确不做

init/sidecar 增加环境变量/卷挂载(能力扩展非空间问题,记 backlog)。

## ⑥a Modal `fullscreen` prop + 创建流全屏化

### Modal.vue 扩展(非 fullscreen 走原 DOM,零回归)

- 新 prop `fullscreen: { type: Boolean, default: false }`
- fullscreen 态 dialog:`w-screen h-screen max-w-none max-h-none rounded-none flex flex-col`,标题栏(`shrink-0` 粘顶)、内容区(`flex-1 overflow-y-auto p-lg`)、actions(`shrink-0 border-t 粘底`)——整卡不再滚动;层级不变(Z.modal,toast 之下)
- backdrop 保留(视觉上被 dialog 全盖,`pointer-events` 不变)

### Secret/ConfigMap 创建弹窗(`NsSecrets.vue`/`NsConfigMaps.vue`)

- Modal 加 `fullscreen`,标题不变;内容顶部加 **「表单 | YAML」tab 条**(局部 ref,无需通用组件)
- 表单 tab = 现有字段原样(全屏空间,docker/tls 多字段不再挤)
- YAML tab = **只读实时预览**:按表单状态手拼 YAML(仿 DeployApp previewYAML 模板串风格,值经 `yamlScalar` 转义):Secret 输出 `apiVersion: v1 / kind: Secret / metadata.name+namespace / type: <type> / stringData: 键值(明文)`;ConfigMap 输出 `kind: ConfigMap / data: 键值`;渲染用 `<pre class="font-mono text-xs whitespace-pre-wrap">`
- 可编辑 YAML 创建已有独立「从 YAML 创建」入口,本 tab 不做编辑(不重复建设)
- i18n 新键:`ns.secrets.tabForm/tabYaml` + `ns.configs.tabForm/tabYaml`(中英,值可复用同一文案「表单/YAML」)

## ⑥b Secret 详情编辑改宽(`NsSecretDetail.vue`)

- data 行内编辑:窄单行 input → `<textarea>`(`flex-1 min-h-[80px] resize-y font-mono bg-surface-container-low border ... text-body-sm`),save/cancel 流程不变
- 加键 Modal:`width="max-w-lg"` → `max-w-2xl`,value 字段同步换 textarea(`min-h-[100px]`)
- ConfigMap 详情页(已有左右分栏)不动

## 测试

- `Modal.test.js` 补 fullscreen 用例(先红):fullscreen 态 dialog 类含 `w-screen`/`rounded-none`、actions 区存在、内容区可滚动类;非 fullscreen 原类不变
- 新 `InitSideContainerEditor.test.js`:折叠摘要渲染(name/image/摘要)+空容器自动展开+点击摘要切换展开+v-model 行对象编辑回写(改 name → 父数组对象变)+`remove` emit+testid 存在性
- `DeployApp.command-args.test.js` 既有断言必须持续绿(v-show 保 DOM)
- 视图接线(NsSecrets/NsConfigMaps/NsSecretDetail)以门禁代行+手测

## 验证

- 门禁四连 + `npm run i18n:check` 全绿
- 手测(需环境):
  1. 向导 Step 容器区:init/sidecar 纵向堆叠;添加容器自动展开全宽编辑;已填容器折叠成摘要行;展开收起流畅;删除正常;Step 6 YAML 预览与容器字段同步不变
  2. 新建 Secret(选 dockerconfigjson/tls 类型):全屏+表单/YAML tab 切换,YAML 随表单实时变;ConfigMap 同
  3. Secret 详情:编辑长值(证书)textarea 舒适;加键弹窗变宽
  4. 其它 Modal(如 Scale/批量删除)不受 fullscreen 改动影响

## 明确不做(范围外)

- 独立全屏编辑路由页;ConfigMap 详情页升级;init/sidecar 环境变量/卷挂载;YAML tab 可编辑

> 注记(2026-08-25 合并时):④ 容器区解挤最终由并行分支的 ContainerEditorDialog 弹窗方案承载(已先合 main,校验单源齐备);本文 ④ 的「纵向堆叠+折叠摘要」布局洞察记 backlog 可后续融合。⑥ 三件套已合(42966e6)。
