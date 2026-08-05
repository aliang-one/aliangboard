# ConfigMap 详情页：Data tab 文件浏览器改版

- **日期**：2026-08-05
- **状态**：已确认，待实现
- **范围**：NsConfigMapDetail.vue 的 Data tab 布局重构（纵向堆叠 → 双栏文件浏览器）。

## 1. 背景与动机

当前 ConfigMap Data tab 是**纵向堆叠**：每个 key 一块（key 名在上 + 内容在下），所有 key 从上到下排列。当 key 多、内容长时，页面很长、难以快速定位某个 key 的内容。

用户希望改为**文件夹/文件隐喻**：ConfigMap = 文件夹，key = 文件名，value = 文件内容。类似 VS Code 侧边栏 + 编辑器的交互。

## 2. 目标与非目标

### 目标
1. Data tab 改为**双栏文件浏览器**：左栏 = 文件列表（keys），右栏 = 选中文件的内容查看/编辑。
2. 文件列表：扩展名图标（复用 `detectLang`）+ 文件名（key）+ 行数；选中高亮；hover 显示删除。
3. 内容区：查看模式（代码查看器，暗底等宽字体）+ 编辑模式（textarea + 保存/取消）。
4. 添加 key = 新建文件（左栏底部按钮 → Modal）。
5. 删除 key = 删除文件。

### 非目标（YAGNI）
- 不做文件树/目录嵌套（ConfigMap data 是扁平 key-value）。
- 不改其他 tab（references/annotations/labels/YAML）。
- 不改 ConfigMap 列表页。
- 不新建公共组件（在 NsConfigMapDetail.vue 内改 Data tab 即可）。
- 不做文件搜索/过滤（key 数量通常不多；后续可加）。

## 3. 现状

- `src/views/NsConfigMapDetail.vue`：Data tab（行 218-268）= 纵向堆叠 key-value 块；每块：key 名 + 语言标签 + 行数 + 内容（可折叠）+ 编辑/删除。
- `detectLang(key)` 已有（行 42-53）：按扩展名返回 {label, icon, color}。
- `dataEntries` computed（行 28-31）：`Object.entries(cm.data)`。
- 编辑：`editingKey` ref + `startEdit/saveEdit/deleteKey`（行 89-107）。
- 添加：`showAddKeyModal` + `newKey/newValue` + `addKey`（行 79-87）。
- `store.updateConfigMap(name, ns, {data})` PATCH data。

## 4. 设计

### 4.1 双栏布局（Data tab 模板重构）

替换 Data tab 内容（行 219-268）为双栏：

```html
<div v-if="activeTab === 'data'" class="flex gap-md">
  <!-- 左栏：文件列表 -->
  <div class="w-56 shrink-0 bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
    <div class="px-md py-sm border-b border-outline-variant bg-surface-container-low flex items-center gap-sm">
      <span class="material-symbols-outlined text-secondary text-base">folder</span>
      <span class="text-label-caps text-on-surface-variant truncate">Files ({{ dataEntries.length }})</span>
    </div>
    <div class="max-h-[60vh] overflow-y-auto">
      <button v-for="([key, val], idx) in dataEntries" :key="idx"
        @click="selectedKey = key"
        class="w-full flex items-center gap-sm px-md py-sm text-left transition-colors group"
        :class="selectedKey === key ? 'bg-primary-container/15 text-primary' : 'text-on-surface hover:bg-surface-container-low'">
        <span class="material-symbols-outlined text-base shrink-0" :class="selectedKey === key ? 'text-primary' : 'text-on-surface-variant'">{{ detectLang(key).icon }}</span>
        <span class="text-body-sm font-mono truncate flex-1">{{ key }}</span>
        <span class="text-[10px] text-on-surface-variant shrink-0">{{ lineCount(val) }}</span>
        <button @click.stop="deleteKey(key)" class="opacity-0 group-hover:opacity-100 p-0.5 text-on-surface-variant hover:text-error rounded transition-opacity shrink-0" title="删除">
          <span class="material-symbols-outlined text-sm">close</span>
        </button>
      </button>
      <div v-if="!dataEntries.length" class="px-md py-lg text-center text-on-surface-variant text-body-sm">无文件</div>
    </div>
    <button @click="showAddKeyModal = true" class="w-full flex items-center justify-center gap-sm px-md py-sm border-t border-outline-variant text-body-sm text-primary font-medium hover:bg-primary-container/10 transition-colors">
      <span class="material-symbols-outlined text-sm">add</span> 新建文件
    </button>
  </div>

  <!-- 右栏：文件内容 -->
  <div class="flex-1 bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
    <!-- 有选中文件 -->
    <template v-if="selectedKey && cm.data[selectedKey] != null">
      <div class="px-md py-sm border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-base" :class="detectLang(selectedKey).color.includes('text-') ? detectLang(selectedKey).color.split(' ').find(c => c.startsWith('text-')) : 'text-on-surface-variant'">{{ detectLang(selectedKey).icon }}</span>
          <span class="font-mono text-code-sm text-primary font-semibold">{{ selectedKey }}</span>
          <span class="inline-flex items-center gap-1 px-1.5 py-0 rounded text-label-caps font-medium" :class="detectLang(selectedKey).color">
            <span class="material-symbols-outlined text-xs">{{ detectLang(selectedKey).icon }}</span>{{ detectLang(selectedKey).label }}
          </span>
          <span class="text-label-caps text-on-surface-variant">{{ lineCount(cm.data[selectedKey]) }} 行</span>
        </div>
        <div class="flex gap-xs">
          <button v-if="editingKey !== selectedKey" @click="startEdit(selectedKey)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="编辑"><span class="material-symbols-outlined text-lg">edit</span></button>
          <button @click="deleteKey(selectedKey); selectedKey = dataEntries[0]?.[0] || ''" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="删除"><span class="material-symbols-outlined text-lg">delete</span></button>
        </div>
      </div>
      <!-- 编辑模式 -->
      <div v-if="editingKey === selectedKey" class="p-md">
        <textarea v-model="editValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono min-h-[300px] resize-y focus:ring-2 focus:ring-primary focus:border-primary"></textarea>
        <div class="flex justify-end gap-sm mt-sm">
          <button @click="editingKey = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">取消</button>
          <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">保存</button>
        </div>
      </div>
      <!-- 查看模式 -->
      <div v-else class="p-md">
        <pre class="bg-[#0b1c30] text-[#cfe3ff] rounded-lg p-md font-mono text-code-sm whitespace-pre overflow-auto max-h-[55vh]">{{ cm.data[selectedKey] }}</pre>
      </div>
    </template>
    <!-- 未选中 / 无文件 -->
    <div v-else class="flex items-center justify-center h-full min-h-[300px] text-on-surface-variant">
      <div class="text-center">
        <span class="material-symbols-outlined text-3xl text-surface-container-high">description</span>
        <p class="mt-sm text-body-sm">选择左侧文件查看内容</p>
      </div>
    </div>
  </div>
</div>
```

### 4.2 新增状态

```js
const selectedKey = ref('')   // 当前选中的文件（key）
```

`openYaml`/进入 Data tab 时自动选中第一个 key：
```js
watch([() => cm.value?.name, () => activeTab.value], () => {
  if (activeTab.value === 'data' && dataEntries.value.length && !selectedKey.value) {
    selectedKey.value = dataEntries.value[0][0]
  }
}, { immediate: true })
// 切换 ConfigMap 时重置
watch(() => cm.value?.name, () => { selectedKey.value = ''; editingKey.value = null })
```

### 4.3 编辑/删除交互

- `startEdit(key)` 不变（设 editingKey + editValue）。
- `saveEdit()` 不变（PATCH data + 清 editingKey）。
- `deleteKey(key)` 不变（PATCH data）；删除后 selectedKey 跳到第一个剩余 key。
- 添加 key（addKey）后自动选中新 key。

### 4.4 视觉细节

- 左栏文件列表：folder 图标 header + scrollable list + 新建按钮 footer。
- 文件图标：复用 `detectLang(key).icon`（description/data_object/settings/terminal/code/lock 等）。
- 选中高亮：`bg-primary-container/15 text-primary`。
- hover 删除：`opacity-0 group-hover:opacity-100`（仅 hover 时显示 × 按钮）。
- 右栏内容查看：暗底 `bg-[#0b1c30] text-[#cfe3ff]`（与 YamlEditor 一致的代码配色）。
- 右栏编辑：textarea（与现有编辑一致）。

## 5. 测试

- 项目无前端测试框架 → 手动验证（`npm run dev` + 集群有 ConfigMap）：
  - Data tab 显示双栏：左文件列表 + 右内容。
  - 点击文件 → 右栏显示内容（暗底代码）。
  - 编辑 → textarea + 保存 → 内容更新。
  - 删除文件 → 列表更新 + 自动选中下一个。
  - 新建文件 → 列表新增 + 自动选中。
  - 切换 ConfigMap → selectedKey 重置 + 自动选中第一个。
- `npm run typecheck && npm run build`：无新增错误。

## 6. 涉及文件清单

**修改**
- `src/views/NsConfigMapDetail.vue` — Data tab 模板重构（双栏文件浏览器）+ 新增 selectedKey 状态 + watch 自动选中。
