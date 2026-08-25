# 部署向导存储步骤门禁设计(卷必须映射到容器)

日期:2026-08-25 · 来源:用户报障「挂载的存储应该映射到容器内部,但现在不映射也能下一步」· 状态:已对齐

## Context / 根因(systematic-debugging 已完成)

DeployApp 向导 step 2(存储):`addVolume()`(:241)生成 `mountPath:''`、来源空的条目;`stepBlockReason`(:267-306)**无 step 2 分支**;下游 `mountsForTarget`(subContainer.js:116,过滤 `v.name && v.mountPath`)与 pod 级 `volumesYaml`(:487-500,按类型查来源)都**静默丢弃不完整条目**——未映射的卷在最终 YAML 里整个消失,用户无感知。

## 设计

### `src/logic/volumeMountValidation.js`(新,纯函数,仿 containerValidation 单源先例)

```js
firstVolumeMountError(volumeMounts, validTargets) → { key, n } | null
```

逐条检查(返回首个坏条目,1-based 序号):
1. **来源必填**(按类型):pvc→pvcName;hostPath→hostPath;nfs→server;configMap→cmName;secret→secretName;emptyDir→免 → `deploy.volumeSourceRequired`
2. **挂载路径**:`mountPath` 非空且以 `/` 开头 → `deploy.volumeMountRequired`
3. **目标容器有效**:`target` ∈ validTargets → `deploy.volumeTargetInvalid`(堵「容器已删/无镜像 → target 悬空静默不挂载」的隐藏洞)

### DeployApp 接线

`stepBlockReason` 加分支:

```js
if (currentStep.value === 2) {
  const e = firstVolumeMountError(f.volumeMounts, containerTargets.map(x => x.value))
  if (e) return t(e.key, { n: e.n })
}
```

(validTargets 即卡片 target 下拉同源 `containerTargets` 的 value 集;'main' + 有镜像的 `init:i`/`sidecar:i`。)提示走既有「下一步旁内联 error」机制(:1663),无静默禁用。

### i18n(3 键 × 中英,`deploy` 对象内)

- `volumeSourceRequired`:「第 {n} 个存储缺少来源(按类型填 PVC/路径/服务器/名称)」
- `volumeMountRequired`:「第 {n} 个存储缺少容器内挂载路径(须以 / 开头)」
- `volumeTargetInvalid`:「第 {n} 个存储的目标容器不存在或未配置镜像」

## 测试

- 新 `src/logic/__tests__/volumeMountValidation.test.js`(vitest,先红):五类型来源检查/空+非斜杠 mountPath/悬空 target/全好返回 null
- DeployApp 既有套件回归(接线处);门禁代行

## 验证

门禁四连;手测:向导 step 2 添加卷不填挂载路径 → 下一步被拦并提示;填好后放行;YAML 预览含 mounts。

## 明确不做

NsWorkloadDetail 编辑路径同款门禁(另记 follow-up);卡片字段级红框;批量修复所有历史静默过滤点。
