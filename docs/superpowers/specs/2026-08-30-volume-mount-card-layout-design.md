# VolumeMountCard 布局重构设计——合并问题区 + defaultMode 收编

日期:2026-08-30
状态:已经用户裁决选型
关联:`docs/superpowers/specs/2026-08-28-mount-validation-design.md`(校验单源,本设计只动呈现层)

## 0. 背景与用户反馈

2026-08-30 用户报障卷挂载卡片交互,三点:

1. **同行输入框错位**:有错误提示时,同一行两个输入框上下错开。
   根因:底行(挂载到|subPath|只读)为 `grid items-end`,错误文案 `<p>` 渲染在**各自字段格子内**——
   一边有文案一边没有 → 格子高差 → `items-end` 把矮格压底,输入框错开。
2. **subPath「卷内不存在」判定疑问**(已当面解释,记录在案):
   ConfigMap/Secret 卷的内容 = 每 key 一个文件(配 items 则仅投影文件);subPath 语义 = 从卷内挑
   单文件/目录挂到挂载点,故合法值只能是「无 items 时的 key 名」或「有 items 时的 item path」。
   校验器以同集群同名空间该 CM 的 `data ∪ binaryData` 键集比对;不在其中 → 提示。kubelet 对此
   **不报错**而静默建空目录(kubernetes#62156),运行时才暴露,故值得提醒;键集未加载不判。
   级别已裁 warn(2026-08-30,见关联 spec 规则 7),本设计不再改判定逻辑。
3. **defaultMode 独占一行浪费**:应收编。

## 1. 用户裁决(2026-08-30)

| 取舍点 | 裁决 | 落选方案 |
|--------|------|----------|
| 错误/警告文案呈现 | **行下合并问题区**(每区块底部一条全宽问题区,有问题才渲染) | 字段下固定槽位(常驻留白、长文案溢出) |
| defaultMode 位置 | **收进键映射头行**(与「＋添加」同行右置) | 底行第四项(四列拥挤、custom 输入无处放) |
| subPath 判定 | 维持现状:自由文本 + warn,逻辑零改动 | 下拉选择(用户已裁,不再议) |

## 2. 错误呈现:三区块各一条全宽问题区

### 2.1 区块划分与收编字段

校验器 `validateEntry` 产出的 field 共 10 类 + 跨卡注入,按视觉区块归口:

| 区块 | 收编的 issue field | 说明 |
|------|--------------------|------|
| 头部(卷名行) | `name` | 本就独占一行全宽,维持现状不收编 |
| 顶行(挂到容器\|来源) | `target`、`source`、`hostPath`、`nfsPath` | hostPath/NFS 的右侧双控件堆叠为固有差异,与错误无关 |
| 键映射区(含权限/预览) | `items`、`defaultMode` | `itemsPath:<i>` 行级文案**维持行内**——item 行为纵向独立块无错位问题,且文案不含行号、收编后多行出错无法定位 |
| 底行(挂载到\|subPath\|只读) | `mountPath`、`subPath`、`readOnly` | readOnly 的行内 hint 一并移入;底行是错位 bug 的唯一现症行(`items-end` + 字段级 `<p>`) |

### 2.2 渲染规则

- 问题区 = 区块底部全宽容器,**有问题才渲染**(无问题零占位,行高恒定);三区块 testid 依次
  `data-testid="issues-source-row"` / `"issues-items"` / `"issues-mount-row"`(单测锚定用)。
- 多条问题依次列出,顺序 = 校验器产出顺序(稳定);样式沿用现 `text-[10px]` + `issueTextCls` 三档配色。
- **字段级红/黄框(`issueCls`)与 `aria-invalid` 不动**——框定位「错在哪个字段」,问题区解释「为什么」。
- i18n:零新增键(文案全复用 `ISSUE_KEYS` 既有映射)。

## 3. defaultMode 收进键映射头行

- 头行:`键映射 —————— 权限[默认▼] [＋添加]`;权限 select(三预设+自定义)右置与「＋添加」同行,`flex-wrap` 兜底窄宽。
- 选「自定义」:小号八进制输入框(w-16 级)就地展开于 select 旁。
- 原 `grid-cols-[1fr_auto]` 独占权限行删除;`defaultMode` 的 issue 移入键映射区问题区。
- 语义依据:defaultMode 仅对 configMap/secret 有意义,键映射区也仅在这两种类型渲染——天然同域。

## 4. 不变式

- **组件接口零变化**:props(`containers/pvcs/availableConfigMaps/availableSecrets/namespace/issues`)、
  `v-model`、`remove` 事件、`issues` 数据结构全部不动;DeployApp(创建)与 NsWorkloadDetail(编辑)
  两消费方无感知,自动受益。
- **校验逻辑零变化**:`volumeMountValidation.js` 纯逻辑与既有测试保持绿。
- 落点预览、类型胶囊、unknown 锁定、PVC 内联创建、头部结构:全部不动。

## 5. 测试策略

### 5.1 单测(vitest + happy-dom)

- `volumeMountValidation.test.js`:零改动,须保持绿。
- `VolumeMountCard.test.js`:
  - 改锚定:字段旁 `<p>` 断言 → 区块问题区容器(§2.2 三个 testid);
  - 新增:defaultMode select 渲染于键映射头行、独占权限行不存在;
  - 新增:无 issue 时问题区不渲染(零占位);有 issue 时字段框类(`!border-error` 等)仍在;
  - 保留:`itemsPath:<i>` 行级文案仍在行内(§2.1 裁决)。
  - 已知边界:happy-dom 测不出真实 rect(教训在案),对齐性靠手测矩阵。

### 5.2 手测矩阵(真浏览器,双入口)

| # | 场景 | 预期 |
|---|------|------|
| 1 | step2 CM 卷填不存在的 subPath | 黄框在 subPath + 底行问题区黄字;「下一步」可点 |
| 2 | mountPath 填 `/` | 红框 + 底行问题区红字;挂载到与 subPath 输入框**等高** |
| 3 | 来源不选 | 顶行问题区红字;挂到容器与来源两控件等高 |
| 4 | items 行只填 key | 键映射区问题区红字(itemsIncomplete) |
| 5 | 权限选自定义填 999 | 自定义输入框就地展开;红字在键映射区问题区 |
| 6 | items 行 key 缺失 | 行级文案**仍在该行下方**(§2.1 裁决),红框在该行输入框 |
| 7 | NsWorkloadDetail 编辑弹窗抽查 1/2/5 | 同表现 |
| 8 | 弹窗缩窄至 ~480px | 头行 flex-wrap 正常换行,无横向溢出 |

## 6. 非目标

- subPath 下拉/合法值辅助(已裁决不做)。
- 其他组件(如 ContainerEditorDialog)的同类「字段级文案」模式——如需治理另立任务。
- 校验规则/级别任何变动(上一轮已完成 subPathNotInVolume 降 warn)。
