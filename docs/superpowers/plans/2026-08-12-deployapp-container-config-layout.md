# DeployApp 容器配置排版优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把创建 workload 向导 Step 2「容器配置」的主容器字段按逻辑重排、ServiceAccount 移入高级设置、Init/Sidecar 改左右并排 —— 纯模板改动,无逻辑/数据/i18n 变更。

**Architecture:** 只动 `src/views/DeployApp.vue` 的 `<template>`(Step 2 区块约 880–975 行 + 高级设置入口约 1060 行)。不触碰 `<script setup>` 任何一行 → `form.*` 字段、校验、`generateYaml` 全部不变 → YAML 预览逐字不变。复用全部现有 `deploy.*` i18n 键,不新增键。

**Tech Stack:** Vue 3 SFC(`<script setup>`)、Tailwind(Material Design 3 surface token)、vue-i18n。

## Global Constraints

- 仓库默认**不新增外部依赖**(本任务也不需要)。
- **不新增 i18n 键**;全部复用现有 `deploy.*` 键;`npm run i18n:check` 须通过(残存中文 / 键对齐 / 引用键缺失三合一)。
- **只改 `<template>`**,不改 `<script setup>`(`form.*` / 校验 / `generateYaml` / `availableSecrets` / `availableServiceAccounts` 等全部不动)→ 生成 YAML 逐字不变。
- **无单元测试**:本任务为纯模板排版,无行为变化;在 vitest 里 mount 这个 1200+ 行、依赖大量 store/i18n 的向导属过度工程且违背仓库测试哲学(CLAUDE.md:纯逻辑才用自研零依赖运行器覆盖)。验证靠 `typecheck` + `build` + 视觉 + YAML 不变。
- 复用现有样式约定:边框面板用 `rounded-lg border border-outline-variant p-md bg-surface-container-low/30`(与 `VolumeMountCard.vue` 一致);输入框类名保持原样。
- 工作分支:`feat/deploy-container-layout`(已基于 main 创建)。

---

## File Structure

- **Modify:** `src/views/DeployApp.vue`(单文件)
  - Task 1:Step 2 主网格(883–928 行)重排 + 删 ServiceAccount 块;高级设置区(1060 行后)插入 ServiceAccount 块。
  - Task 2:Step 2 init/sidecar 区块(930–974 行)包成左右并排。

无新建文件。无其他文件改动。

---

## Task 1: 主容器网格按逻辑重排 + ServiceAccount 移入高级设置

**Files:**
- Modify: `src/views/DeployApp.vue:883-928`(主网格整块替换)
- Modify: `src/views/DeployApp.vue:1060`(高级设置内容区开头插入 SA 块)

**Interfaces:** 无(纯模板;`form.containerName/image/pullPolicy/imagePullSecrets/workingDir/command/args/stdin/tty/serviceAccountName` 等 v-model 绑定全部保留不变)。

**Why no unit test:** 纯 DOM 重排,无行为;`<script>` 不变 → `generateYaml` 输出不变。验证 = 编译 + 视觉 + YAML 预览对照。

- [ ] **Step 1: 替换主网格块(重排 + 移除 ServiceAccount)**

用 Edit 把 `src/views/DeployApp.vue` 中 883–928 行的整个主网格 `<div class="grid grid-cols-1 md:grid-cols-2 gap-sm"> ... </div>`(从 `<div class="grid grid-cols-1 md:grid-cols-2 gap-sm">` 到对应的闭合 `</div>`,即包含 containerName/image/pullPolicy/command/args/workingDir/stdin-tty/imagePullSecrets/serviceAccountName 九块的那个网格)替换为下面这块(注意:imagePullSecrets 上移与 pullPolicy 同行;workingDir 上移与 command 同行;args 保持整行;stdin/tty 改整行;**删除 ServiceAccount 块**):

```
        <div class="grid grid-cols-1 md:grid-cols-2 gap-sm">
          <!-- 身份 -->
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.containerName') }}</label>
            <input v-model="form.containerName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary" placeholder="main" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.imageUrl') }}</label>
            <input v-model="form.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary" placeholder="nginx:latest" />
          </div>
          <!-- 镜像获取 -->
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.pullPolicy') }}</label>
            <select v-model="form.pullPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
              <option>IfNotPresent</option><option>Always</option><option>Never</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.imagePullSecrets') }}</label>
            <select v-model="form.imagePullSecrets" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
              <option value="">None</option>
              <option v-for="s in availableSecrets" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <!-- 进程执行 -->
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.workingDir') }}</label>
            <input v-model="form.workingDir" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/app" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.command') }}</label>
            <input v-model="form.command" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="/bin/sh -c" />
          </div>
          <div class="md:col-span-2">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.args') }}</label>
            <input v-model="form.args" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="--port 8080 --debug" />
          </div>
          <div class="md:col-span-2 flex items-center gap-md pt-sm">
            <label class="flex items-center gap-sm cursor-pointer"><input type="checkbox" v-model="form.stdin" class="rounded text-primary h-4 w-4" /><span class="text-xs">stdin</span></label>
            <label class="flex items-center gap-sm cursor-pointer"><input type="checkbox" v-model="form.tty" class="rounded text-primary h-4 w-4" /><span class="text-xs">{{ $t('deploy.ttyLabel') }}</span></label>
          </div>
        </div>
```

- [ ] **Step 2: 高级设置区插入 ServiceAccount 块**

用 Edit,把高级设置内容区的开头:

```
          <div v-show="showAdvanced" class="p-md border-t border-outline-variant">
        <!-- 健康探针 -->
```

替换为(在内容区最前面加 SA 块):

```
          <div v-show="showAdvanced" class="p-md border-t border-outline-variant">
        <!-- Service Account (pod 级身份) -->
        <div class="mb-md">
          <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.serviceAccountLabel') }}</label>
          <select v-model="form.serviceAccountName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
            <option value="">Default</option>
            <option v-for="sa in availableServiceAccounts" :key="sa" :value="sa">{{ sa }}</option>
          </select>
        </div>

        <!-- 健康探针 -->
```

- [ ] **Step 3: 语法基线**

Run: `npm run typecheck`
Expected: PASS(`node --check` 全过;`.vue` 由 build 覆盖,这里至少 .js/.mjs 不受影响,应仍绿)。

- [ ] **Step 4: 构建(覆盖 .vue 编译)**

Run: `npm run build`
Expected: PASS,无 Vue 模板编译错误。

- [ ] **Step 5: i18n 门禁**

Run: `npm run i18n:check`
Expected: PASS(未新增/删除键,无残存中文,键对齐 ✓)。

- [ ] **Step 6: 视觉 + YAML 不变确认(手测或 browse)**

打开创建 workload 向导到 Step 2:
- 主网格顺序为:名/镜像 → 拉取策略/拉取凭证 → 工作目录/command → args → stdin/tty;**主网格无 ServiceAccount**。
- 展开「高级设置」:ServiceAccount 下拉在最上方,可正常选择。
- 填一遍字段(含 SA),看最后一步 YAML 预览:`serviceAccountName` 仍出现在 yaml 中,且其余字段输出与改动前一致(因为 `<script>` 未动,逻辑上保证)。

- [ ] **Step 7: Commit**

```bash
git add src/views/DeployApp.vue
git commit -m "$(cat <<'EOF'
feat(deploy): 主容器配置按逻辑重排,ServiceAccount 移入高级设置

拉取策略与拉取凭证同行、工作目录与 command/args 同组;SA 作为
pod 级身份归入高级设置。纯模板改动,YAML 输出不变。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 初始化 / 额外容器改左右并排

**Files:**
- Modify: `src/views/DeployApp.vue:930-974`(init + sidecar 两个堆叠区块 → 一个 2 列容器)

**Interfaces:** 无(v-model 绑定 `form.initContainers` / `form.extraContainers` 及其字段、`addInitContainer`/`removeInitContainer`/`addExtraContainer`/`removeExtraContainer` 全部不变)。

**Why no unit test:** 同 Task 1 —— 纯布局,卡片字段集合不变。

- [ ] **Step 1: 替换 init + sidecar 区块为左右并排**

用 Edit,把 930–974 行这一段(从 `<!-- 初始容器 (Init) -->` 的 `<h4 ...>` 行,到 sidecar 区块闭合 `</div>` 结束,即两个独立的 `<h4>+<div class="flex flex-col gap-sm mb-md">...</div>` 堆叠区块)整体替换为下面这块(外层 2 列容器,每列一个淡色边框侧栏;卡片资源行从 `grid-cols-2 md:grid-cols-4` 降为 `grid-cols-2`;卡片 padding 改 `p-sm`):

```
        <!-- 初始化 / 额外容器:左右并排 -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-md mt-md">
          <!-- 初始容器 (Init) -->
          <div class="rounded-lg border border-outline-variant p-md bg-surface-container-low/30">
            <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.initContainers') }}</h4>
            <div class="flex flex-col gap-sm">
              <div v-for="(c, idx) in form.initContainers" :key="'ic'+idx" class="border border-outline-variant rounded-lg p-sm">
                <div class="grid grid-cols-2 gap-sm mb-xs">
                  <input v-model="c.name" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="init name" />
                  <input v-model="c.image" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="image" />
                </div>
                <div class="grid grid-cols-2 gap-sm mb-xs">
                  <input v-model="c.command" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="command" />
                  <input v-model="c.args" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="args" />
                </div>
                <div class="grid grid-cols-2 gap-sm">
                  <input v-model="c.cpuRequest" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs" placeholder="cpu req" />
                  <input v-model="c.cpuLimit" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs" placeholder="cpu limit" />
                  <input v-model="c.memoryRequest" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs" placeholder="mem req" />
                  <input v-model="c.memoryLimit" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs" placeholder="mem limit" />
                </div>
                <button @click="removeInitContainer(idx)" class="mt-sm text-xs text-error hover:underline">{{ $t('deploy.removeContainer') }}</button>
              </div>
              <button @click="addInitContainer" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
                <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addInitContainer') }}
              </button>
            </div>
          </div>

          <!-- 额外工作容器 (Sidecar) -->
          <div class="rounded-lg border border-outline-variant p-md bg-surface-container-low/30">
            <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.sidecarContainers') }}</h4>
            <div class="flex flex-col gap-sm">
              <div v-for="(c, idx) in form.extraContainers" :key="'ec'+idx" class="border border-outline-variant rounded-lg p-sm">
                <div class="grid grid-cols-2 gap-sm mb-xs">
                  <input v-model="c.name" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="sidecar name" />
                  <input v-model="c.image" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="image" />
                </div>
                <div class="grid grid-cols-2 gap-sm">
                  <input v-model="c.cpuRequest" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs" placeholder="cpu req" />
                  <input v-model="c.cpuLimit" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs" placeholder="cpu limit" />
                  <input v-model="c.memoryRequest" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs" placeholder="mem req" />
                  <input v-model="c.memoryLimit" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs" placeholder="mem limit" />
                </div>
                <button @click="removeExtraContainer(idx)" class="mt-sm text-xs text-error hover:underline">{{ $t('deploy.removeContainer') }}</button>
              </div>
              <button @click="addExtraContainer" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
                <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addSidecarContainer') }}
              </button>
            </div>
          </div>
        </div>
```

- [ ] **Step 2: 语法基线**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: PASS。

- [ ] **Step 4: i18n 门禁**

Run: `npm run i18n:check`
Expected: PASS。

- [ ] **Step 5: 视觉 + 功能确认**

打开 Step 2:
- Init 与 Sidecar 左右并排(宽屏);窄屏(缩窗到 < md)上下堆叠。
- 「+ 添加 init」/「+ 添加 sidecar」各自增删卡片正常;卡片内 name/image/command/args/资源填写正常。
- 资源 4 个字段在窄列里 2×2 排列不溢出。

- [ ] **Step 6: Commit**

```bash
git add src/views/DeployApp.vue
git commit -m "$(cat <<'EOF'
feat(deploy): 初始化/额外容器改左右并排侧栏

Init 与 Sidecar 各占一侧淡色面板,卡片资源行降为 2 列适配窄列。
纯模板改动。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review(写完后自检)

1. **Spec 覆盖**:
   - 主网格重排(名/镜像、拉取策略+凭证、工作目录+command+args、stdin/tty)→ Task 1 Step 1 ✓
   - ServiceAccount 移高级设置 → Task 1 Step 2 ✓
   - Init/Sidecar 左右并排 + 资源行降列 → Task 2 Step 1 ✓
   - 不改字段集合/逻辑/YAML/i18n → Global Constraints + 各 Task "Why no unit test" ✓
2. **占位符扫描**:无 TBD/TODO;每个 Step 都有完整代码块 ✓
3. **类型/命名一致**:所有 v-model(`form.containerName/image/pullPolicy/imagePullSecrets/workingDir/command/args/stdin/tty/serviceAccountName`、`form.initContainers[*].*`、`form.extraContainers[*].*`)、方法名(`addInitContainer`/`removeInitContainer`/`addExtraContainer`/`removeExtraContainer`)、i18n 键与现网一致 ✓
