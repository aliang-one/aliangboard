# DeployApp 容器配置排版优化

## 背景

`src/views/DeployApp.vue`(创建 workload 向导,6 步)的 **Step 2「容器配置」** 当前排版有两个问题:

1. **主容器字段摊在一个扁平 2 列网格里,顺序混杂**:拉取策略紧挨 `command`;工作目录与 `command`/`args` 被拆开;`imagePullSecrets` 与拉取策略不相邻。逻辑上不整洁。
2. **初始化容器 / 额外容器(sidecar)各占一个全宽堆叠区块**,纵向冗长,且与主容器配置在视觉上没有区分,看不出它们都是「附加容器」。

## 目标

- 主容器配置按逻辑分组(**身份 → 镜像获取 → 进程执行**),可读性更高。
- 初始化/额外容器改为**左右并排**,表明二者都是「附加容器」,并省纵向空间。

## 非目标(显式排除)

- 不改字段集合、不改表单状态(`form.*`)、不改校验逻辑、不改 YAML 生成。
- **不新增 i18n 键**(全部复用现有 `deploy.*` 键)。
- 不动 Step 2 其余区块:端口 / 资源 / 环境变量 / envFrom / 单 Key 引用 / 高级设置内部(健康探针、安全上下文、生命周期钩子)的内部结构。

## 设计

### 1. 主容器配置网格重排(`md:grid-cols-2`)

新顺序(唯一改动是行的重新分组与排序,字段本身不动):

| 行 | 左 | 右 |
|----|----|----|
| 1 | 容器名 `containerName` | 容器镜像 `image` |
| 2 | **拉取策略 `pullPolicy`** | **拉取凭证 `imagePullSecrets`** |
| 3 | **工作目录 `workingDir`** | **`command`** |
| 4 | `args`(整行 `md:col-span-2`,`font-mono`) | |
| 5 | `stdin` / `tty` 复选框(整行,紧邻执行组) | |

要点:
- `pullPolicy` 与 `imagePullSecrets` 同行(用户明确要求)。
- `workingDir` + `command` 同行,`args` 整行 —— 三者构成「进程执行」组。
- `stdin`/`tty` 是进程交互开关,紧贴执行组。

### 2. `ServiceAccount` 移入「高级设置」

重排后 `serviceAccountName` 在主网格里没有逻辑伙伴(成为孤儿)。决策:**移入 `advancedSettings` 折叠区**。理由:

- 主网格正好剩 8 个核心字段,最整洁。
- `serviceAccountName` 是 pod 级身份,与高级区已有的 `securityContext` 同属「安全/身份」类,位置一致。
- `v-model` 不变(`form.serviceAccountName`),仅迁移模板位置。

代价:高级区默认折叠,需点开才能改 —— 与 `securityContext` 等同级,可接受。

### 3. 初始化 + 额外容器:左右并排

主容器配置下方,把原来的两个全宽堆叠区块改成一个 2 列容器:

```
<div class="grid grid-cols-1 md:grid-cols-2 gap-md">
  <div> ← 初始化容器侧栏
  <div> ← 额外容器侧栏
```

- **左列**:初始化容器 —— 复用现有标题键 `deploy.initContainers` + 卡片列表 + `deploy.addInitContainer` 按钮。
- **右列**:额外容器 —— 复用 `deploy.sidecarContainers` + 卡片列表 + `deploy.addSidecarContainer` 按钮。
- 每个侧栏用淡色边框面板(`rounded-lg border border-outline-variant p-md`)与主网格区分,视觉上明确「这是附加容器」。
- **卡片字段集合不变**:
  - init 卡片:`name` / `image` / `command` / `args` / `cpuRequest`·`cpuLimit` / `memoryRequest`·`memoryLimit` + 移除按钮。
  - sidecar 卡片:`name` / `image` / `cpuRequest`·`cpuLimit` / `memoryRequest`·`memoryLimit` + 移除按钮(sidecar 本就没有 command/args)。
- **资源行从 4 列(`md:grid-cols-4`)降为 2 列(`grid-cols-2`)**,以适配窄列宽度。
- 为空时:只显标题 + 添加按钮(干净,无空状态噪音)。
- 移动端(`grid-cols-1`):两侧栏自动上下堆叠。

## 影响面

- **单文件**:`src/views/DeployApp.vue`。
  - Step 2 主网格模板:约 883–927 行(重排 + 删 ServiceAccount 块)。
  - init/sidecar 区块:约 929–971 行(包成 2 列容器,卡片资源行降列)。
  - 高级设置区:约 1057 行附近新增 `serviceAccountName` 区块。
- **无 JS / i18n / YAML 逻辑变更。** 全部复用现有键与现有 `form.*` 字段。

## 测试

- `npm run typecheck` —— 语法基线(`node --check`)。
- `npm run build` —— 覆盖 `.vue` 编译。
- 手测:走一遍创建 workload 流程,确认:
  - 主容器各字段填写正常;
  - init / sidecar 增删正常;
  - ServiceAccount 在高级区可设置;
  - Step 最后的 YAML 预览与改动前**逐字一致**(因为只动模板,不动数据)。
- 视觉:窄屏两栏堆叠正常;宽屏左右并排;窄列内资源字段不溢出。
