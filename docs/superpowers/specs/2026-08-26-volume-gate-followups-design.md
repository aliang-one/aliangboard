# 卷校验补齐(items 半填 + 编辑路径 target 有效性)

日期:2026-08-26 · 来源:存储门禁终审 follow-up 裁决 · 状态:已对齐

## Context

存储门禁(64439c7)后遗留:①CM/Secret 卷 **items 半填**条目(key 有 path 空)在 volumesYaml 生成 `path: ` 空标量 → K8s 422;②WLD 编辑路径 validateEdit(NsWorkloadDetail:1024-1035)已有来源/mountPath 校验,但缺 **target 有效性**(target 悬空→静默不挂载)与 items 检查;③向导门禁同样缺 items 规则。

## 设计

### `src/logic/volumeMountValidation.js` 扩展

- 新导出 `volumeItemsIncomplete(entry) → boolean`:items 中任一条 `(key || path) && !(key && path)`(半填)→ true;全空行忽略
- `firstVolumeMountError` 加第 4 规则(target 之后):`volumeItemsIncomplete(v)` → `{ key: 'deploy.volumeItemsIncomplete', n }`(向导门禁自动获得)

### NsWorkloadDetail `validateEdit` 补两条(:1026 块内, else 分支后)

- target 有效性:`containerTargets.value.map(x => x.value)` 不含 `v.target` → `workload.validation.volumeTargetInvalid`(注意 computed 须 `.value`——全仓守卫红线)
- items:`volumeItemsIncomplete(v)` → `workload.validation.volumeItemsIncomplete`(消息以卷名/序号上下文,复用既有 `w` 变量风格)

### i18n(3 键 × 中英)

- `deploy.volumeItemsIncomplete`:「第 {n} 个存储的键映射(items)有半填行(key/path 须成对)」
- `workload.validation.volumeItemsIncomplete`:「{name} 的键映射(items)有半填行(key/path 须成对)」
- `workload.validation.volumeTargetInvalid`:「{name} 的目标容器不存在或未配置镜像」

## 测试

volumeMountValidation.test.js 追加:key-only/path-only item → volumeItemsIncomplete;全空行+成对行 → null;向导侧由 firstVolumeMountError 第 4 规则覆盖。WLD 接线以门禁+手测代行。

## 验证

门禁四连(退出码为准);手测:编辑工作负载→卷挂到已删容器→保存被拦;CM 卷 items 只填 key→向导/编辑均被拦。

## 明确不做

SOURCE_FIELD 未来类型防御(Minor,不修);api-key LIST_PATH 6/15 不平衡(另议)。
