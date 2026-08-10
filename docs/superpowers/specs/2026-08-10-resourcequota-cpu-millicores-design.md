# ResourceQuota CPU 配额改毫核原生

- **日期**: 2026-08-10
- **类型**: 数据格式 / 编辑往返修复 + 单位统一
- **状态**: 已通过 brainstorming,待写实现计划
- **涉及文件**: `src/composables/useResourceFormat.js`、`src/views/NsResourceQuotaDetail.vue`、`src/views/NsResourceQuotas.vue`

## 背景

ResourceQuota 的 CPU 配额(`limits.cpu`)目前是**裸字符串透传**:编辑/创建表单直接把输入值原样发给 K8s,回显也原样读 K8s 返回值。K8s 会对 resource quantity 做**规范化**:提交 `"20000m"`(20000 毫核 = 20 核)后,GET 可能返回 `"20"`(cores)。于是:

- 用户输入 `20000`(本意 20000m)→ 经 K8s 规范化 → 重新打开回显成 `20` → 毫核精度丢失。
- 列表/概览的百分比计算用 `parseCpu = parseFloat`(忽略 `m` 后缀):`parseCpu("20")=20` 与 `parseCpu("20000m")=20000`,**同一 CPU 两个值**;当 hard/used 单位不一致(cores vs millicores)时百分比直接错乱。

## 目标

把 ResourceQuota 的 `limits.cpu`(`cpuHard` 字段)全链路改为**毫核原生**:输入/回显用毫核整数(语义:`1 = 1000m = 1 核`),保存为 `"${m}m"`,往返稳定(`20000 → "20000m" → 回显 20000`),百分比也按毫核正确计算。

## 非目标

- 不改 `requests.cpu`(当前编辑表单未暴露,不在范围)。
- 不改 memory/pods/services 等非 CPU 配额(单位逻辑不同)。
- 不改 LimitRange / 工作负载的 CPU(本轮只 ResourceQuota)。

## 设计

### 新增 helper:`milliToCpu`(`src/composables/useResourceFormat.js`)

与已有 `cpuToMilli`(quantity → 毫核整数)配对,补**逆向**(毫核整数 → K8s quantity):

```js
// 毫核整数 → K8s quantity 字符串(保存时用)。空值返回 ''(由调用方决定是否下发)。
export const milliToCpu = m => (m == null || m === '' ? '' : `${m}m`)
```

> `cpuToMilli("20") = 20000`、`cpuToMilli("20000m") = 20000`、`milliToCpu(20000) = "20000m"`。往返:`cpuToMilli(milliToCpu(m)) === m`,`milliToCpu(cpuToMilli(q))` 与 q 等量(可能 `"20"`↔`"20000m"`,但数值一致)。

### `NsResourceQuotaDetail.vue`(编辑 + 概览)

1. **加载(打开编辑弹窗)**:`cpuHard` 由裸字符串改为毫核整数:
   ```js
   cpuHard: String(cpuToMilli(rq.value.hard?.['limits.cpu']) || '')
   ```
   K8s 返回 `"20"` 或 `"20000m"` 都回显为 `20000`。

2. **保存(handleEdit)**:输入的毫核整数 → quantity:
   ```js
   if (f.cpuHard) hard['limits.cpu'] = milliToCpu(Number(f.cpuHard))
   ```
   发 `"20000m"`。

3. **输入框**:加单位提示「millicores(1=1000m)」,语义清晰。

4. **概览表格百分比**:cpu 类 key 的 hard/used 须经 `cpuToMilli` 后再算 `getPercent`,避免 cores/millicores 单位错配。`getPercent` 现用 `parseNumeric`(parseFloat),对 cpu 不正确 —— 调用处按 key 类型选解析器:cpu → `cpuToMilli`,memory → `memToKi`,count → `parseInt`。

### `NsResourceQuotas.vue`(创建表单 + 列表)

1. **创建表单 `cpuHard`**:
   - 默认值 `'8'` → `'8000'`(毫核下 8 核 = 8000m)。
   - 保存:`'limits.cpu': milliToCpu(Number(f.cpuHard))`(发 `"8000m"`)。

2. **列表**:
   - `parseCpu`(当前 `parseFloat`,忽略 `m`)改用 `cpuToMilli`(正确处理 `m`/cores/nanocores)。
   - hard/used 显示按毫核格式化(`formatCpu` → `"20000m"`)。
   - 百分比用 `cpuToMilli` 解析后算。

## 验证

- `typecheck`(`node --check` 全 .js/.mjs)+ `build`(覆盖 .vue)+ `i18n:check`。
- 单测(`useResourceFormat` 纯函数,可用自研零依赖运行器或 vitest):
  - `milliToCpu(20000) === "20000m"`、`milliToCpu(0) === "0m"`、`milliToCpu('') === ''`。
  - 往返:`cpuToMilli(milliToCpu(20000)) === 20000`;`cpuToMilli("20") === 20000`、`cpuToMilli("20000m") === 20000`。
- 视图行为(vitest + @vue/test-utils):
  - NsResourceQuotaDetail:加载 hard `limits.cpu="20"` → 编辑框显示 `20000`;输入 `20000` 保存 → 下发 `hard['limits.cpu'] === "20000m"`。
  - 概览/列表:hard=`"20"`、used=`"5000m"` → 百分比 = 25%(5000/20000),而非 parseFloat 错算。
- 手测:创建/编辑 ResourceQuota,输入 `20000` → 保存 → 重新打开应回显 `20000`(不再变 20);列表/概览百分比合理。

## 风险

- 低。纯前端量值转换,不涉网关/K8s 侧改动。
- 默认值 `'8' → '8000'` 是行为变更(老用户习惯输 cores):已在编辑框加单位提示缓解。
- 百分比计算改 cpuToMilli 后,既有 cores 语义的数据(如 `"20"`)会被正确当 20 核(=20000m)处理,数值结果更准。
