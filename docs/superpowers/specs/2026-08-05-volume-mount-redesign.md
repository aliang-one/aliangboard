# 卷挂载重构（scope C：重设计 + 多容器挂载 + items/readOnly）

- 日期：2026-08-05
- 分支：`feat/container-volume-flow`
- 范围：`src/components/common/VolumeMountCard.vue`（新建）、`src/views/DeployApp.vue`、`src/views/NsWorkloadDetail.vue`。

## 背景
卷挂载流程审计发现：B1 卷名空→静默丢弃（已修）；B2 编辑处来源是文本输入（创建是下拉）；B3 只挂主容器、多容器挂载在编辑回填时丢失；另有 items/readOnly 等缺失。本设计一次性重构。

## 数据模型（每条挂载 entry）
```
{ name,           // 自动生成（关联键）
  target,         // 'main' | 'init:<i>' | 'sidecar:<i>' —— 挂到哪个容器
  type,           // 'emptyDir'|'pvc'|'hostPath'|'configMap'|'secret'
  mountPath, subPath, readOnly,
  pvcName, hostPath, cmName, secretName,
  items: [{key, path}] }   // 仅 configMap/secret：键→文件名投影（可选）
```
语义：一条 entry = 一个卷定义 + 挂到某个容器。同卷挂两容器→加两条。

## 新组件 VolumeMountCard.vue
- v-model 整个 entry；props：`containers`（target 选项 [{value,label}]）、`availablePVCs/ConfigMaps/Secrets`、`namespace`。
- 卡片布局（形象）：
  - 头：类型图标 + 卷名（自动，弱化）+ 删除(emit remove)。
  - 类型：图标胶囊（📁emptyDir/💾PVC/🖥hostPath/📋ConfigMap/🔑Secret）。
  - 挂到容器：`<select>`（options=containers，默认 main）。
  - 来源：configMap/secret 用 EnvSourceField(name-only) 复用（picker，顺带修 B2）；pvc 用 select(availablePVCs)；hostPath 用 input；emptyDir 提示。
  - 挂载到：mountPath input + subPath input + readOnly checkbox。
  - configMap/secret 时展开「键映射 items」：[key][→path] 列表，可增删。

## 生成 YAML（DeployApp + NsWorkloadDetail）
- pod 级 `volumes[]`：按 name 去重的卷定义；configMap/secret 在有 items 时附加 `items:[{key,path}]`。
- 每容器 `volumeMounts`：按 target 分组 → 主/init:i/sidecar:i 各自挂载，含 subPath、readOnly:true（勾选时）。

## 编辑回填（NsWorkloadDetail mergeVolumes 重写）
- 遍历 pod `volumes[]` 建 entry 骨架（name/type/source/items）。
- 遍历每个容器（main/init/sidecar）的 `volumeMounts`，按 name 配对填 mountPath/subPath/readOnly 并设 target；同一卷被多容器挂载→多条 entry。
- 修 B3：多容器挂载不再丢失。

## 两处统一
DeployApp（Step 3）与 NsWorkloadDetail（编辑「卷与挂载」卡）均渲染 `VolumeMountCard` 列表。

## 不做（YAGNI）
optional / defaultMode / subPathExpr；共享单卷挂多容器的高级语义（用多条 entry 代替）。

## 验证
- typecheck + build 通过。
- 人工：创建/编辑里加 ConfigMap 卷→选 ConfigMap、设 mountPath→保存生效（内容以文件挂出）；init/sidecar 也能挂卷；readOnly/items 可设；编辑回填保留多容器挂载。
