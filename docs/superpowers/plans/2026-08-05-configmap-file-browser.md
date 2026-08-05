# ConfigMap Data tab 文件浏览器改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ConfigMap Data tab 从纵向堆叠改为双栏文件浏览器（左文件列表 + 右内容查看/编辑）。

**Architecture:** NsConfigMapDetail.vue 内改 Data tab 模板（双栏 flex 布局）+ 新增 selectedKey ref + watch 自动选中第一个文件。复用现有 detectLang/startEdit/saveEdit/deleteKey/addKey 逻辑。

**Tech Stack:** Vue 3 `<script setup>`、Tailwind CSS。

## Global Constraints

- 只改 Data tab（references/annotations/labels/YAML 不动）。
- 不新建组件（在 NsConfigMapDetail.vue 内改）。
- 复用现有 detectLang(key) / startEdit / saveEdit / deleteKey / addKey 逻辑。
- 禁新增依赖。

---

### Task 1: Data tab 双栏文件浏览器 + selectedKey 状态

**Files:**
- Modify: `src/views/NsConfigMapDetail.vue`（script ~行 20 加 selectedKey + watch；template ~行 219-268 Data tab 替换）

- [ ] **Step 1: script 加 selectedKey + watch**

把 NsConfigMapDetail.vue 的 `<script setup>` 中（约行 20，`const activeTab = ref('data')` 之后）：

```js
const activeTab = ref('data')
const showDeleteModal = ref(false)
```

替换为（加 selectedKey + watch 自动选中）：

```js
const activeTab = ref('data')
const selectedKey = ref('')
const showDeleteModal = ref(false)
```

然后在 `dataEntries` computed（约行 28-31）之后追加：

```js
// 进入 Data tab / 切换 ConfigMap 时自动选中第一个文件
watch([() => cm.value?.name, () => activeTab.value, () => dataEntries.value.length], () => {
  if (activeTab.value === 'data' && dataEntries.value.length && !selectedKey.value) {
    selectedKey.value = dataEntries.value[0][0]
  }
}, { immediate: true })
watch(() => cm.value?.name, () => { selectedKey.value = ''; editingKey.value = null })
```

还需在 import 行加 `watch`（约行 2，已有 `computed, ref`）：

```js
import { computed, ref, watch } from 'vue'
```

- [ ] **Step 2: 添加 key 后自动选中新 key**

把 `addKey` 函数（约行 79-87）：

```js
function addKey() {
  if (!newKey.value) return
  const data = { ...(cm.value.data || {}) }
  data[newKey.value] = newValue.value
  store.updateConfigMap(route.params.name, route.params.namespace, { data, keys: Object.keys(data).length })
  newKey.value = ''
  newValue.value = ''
  showAddKeyModal.value = false
}
```

替换为（末尾加 `selectedKey.value = newKey.value` 前保存）：

```js
function addKey() {
  if (!newKey.value) return
  const data = { ...(cm.value.data || {}) }
  const addedKey = newKey.value
  data[addedKey] = newValue.value
  store.updateConfigMap(route.params.name, route.params.namespace, { data, keys: Object.keys(data).length })
  newKey.value = ''
  newValue.value = ''
  showAddKeyModal.value = false
  selectedKey.value = addedKey
}
```

- [ ] **Step 3: 替换 Data tab 模板为双栏文件浏览器**

把 Data tab 整段（从 `<!-- Data Tab -->` 到其闭合 `</div>`，约行 218-268）：

```html
    <!-- Data Tab -->
    <div v-if="activeTab === 'data'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
          <h3 class="text-headline-sm">Data Keys ({{ dataEntries.length }})</h3>
          <button @click="showAddKeyModal = true" class="flex items-center gap-sm px-md py-xs bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">add</span> Add Key
          </button>
        </div>
        <div class="divide-y divide-outline-variant/30">
          <div v-for="([key, val], idx) in dataEntries" :key="idx" class="px-lg py-md">
            <div class="flex items-center justify-between mb-sm">
              <div class="flex items-center gap-sm">
                <span class="font-mono text-code-sm text-primary font-semibold">{{ key }}</span>
                <span class="inline-flex items-center gap-1 px-1.5 py-0 rounded text-label-caps font-medium" :class="detectLang(key).color">
                  <span class="material-symbols-outlined text-xs">{{ detectLang(key).icon }}</span>{{ detectLang(key).label }}
                </span>
                <span class="text-label-caps text-on-surface-variant">{{ lineCount(val) }} 行</span>
              </div>
              <div class="flex gap-xs">
                <button v-if="editingKey !== key" @click="startEdit(key)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
                  <span class="material-symbols-outlined text-lg">edit</span>
                </button>
                <button @click="deleteKey(key)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg">
                  <span class="material-symbols-outlined text-lg">delete</span>
                </button>
              </div>
            </div>
            <div v-if="editingKey === key" class="flex gap-sm">
              <textarea v-model="editValue" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono min-h-[180px] resize-y focus:ring-2 focus:ring-primary focus:border-primary"></textarea>
              <div class="flex flex-col gap-xs">
                <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">Save</button>
                <button @click="editingKey = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">Cancel</button>
              </div>
            </div>
            <div v-else>
              <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm text-on-surface-variant whitespace-pre overflow-auto transition-all"
                :class="isCollapsible(key, val) && !isExpanded(key) ? 'max-h-40' : 'max-h-[480px]'">{{ val }}</div>
              <button v-if="isCollapsible(key, val)" @click="toggleExpand(key)" class="mt-xs flex items-center gap-xs text-body-sm text-primary font-medium hover:underline">
                <span class="material-symbols-outlined text-base">{{ isExpanded(key) ? 'expand_less' : 'expand_more' }}</span>
                {{ isExpanded(key) ? '收起' : `展开全部 (${lineCount(val)} 行)` }}
              </button>
            </div>
          </div>
          <div v-if="!dataEntries.length" class="px-lg py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl">description</span>
            <p class="mt-sm">No data keys</p>
          </div>
        </div>
      </div>
    </div>
```

替换为（双栏文件浏览器）：

```html
    <!-- Data Tab：文件浏览器（左文件列表 + 右内容查看/编辑）-->
    <div v-if="activeTab === 'data'" class="flex gap-md">
      <!-- 左栏：文件列表 -->
      <div class="w-56 shrink-0 bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden flex flex-col">
        <div class="px-md py-sm border-b border-outline-variant bg-surface-container-low flex items-center gap-sm">
          <span class="material-symbols-outlined text-secondary text-base">folder</span>
          <span class="text-label-caps text-on-surface-variant truncate">Files ({{ dataEntries.length }})</span>
        </div>
        <div class="flex-1 overflow-y-auto max-h-[60vh]">
          <button v-for="([key, val], idx) in dataEntries" :key="idx"
            @click="selectedKey = key; editingKey = null"
            class="w-full flex items-center gap-sm px-md py-sm text-left transition-colors group"
            :class="selectedKey === key ? 'bg-primary-container/15 text-primary' : 'text-on-surface hover:bg-surface-container-low'">
            <span class="material-symbols-outlined text-base shrink-0" :class="selectedKey === key ? 'text-primary' : 'text-on-surface-variant'">{{ detectLang(key).icon }}</span>
            <span class="text-body-sm font-mono truncate flex-1">{{ key }}</span>
            <span class="text-[10px] text-on-surface-variant shrink-0">{{ lineCount(val) }}</span>
            <span @click.stop="deleteKey(key); selectedKey = dataEntries.find(([k]) => k !== key)?.[0] || ''" class="opacity-0 group-hover:opacity-100 p-0.5 text-on-surface-variant hover:text-error rounded transition-opacity shrink-0 cursor-pointer" title="删除">
              <span class="material-symbols-outlined text-sm">close</span>
            </span>
          </button>
          <div v-if="!dataEntries.length" class="px-md py-lg text-center text-on-surface-variant text-body-sm">无文件</div>
        </div>
        <button @click="showAddKeyModal = true" class="flex items-center justify-center gap-sm px-md py-sm border-t border-outline-variant text-body-sm text-primary font-medium hover:bg-primary-container/10 transition-colors">
          <span class="material-symbols-outlined text-sm">add</span> 新建文件
        </button>
      </div>

      <!-- 右栏：文件内容 -->
      <div class="flex-1 bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden flex flex-col">
        <!-- 有选中文件 -->
        <template v-if="selectedKey && cm.data[selectedKey] != null">
          <div class="px-md py-sm border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-base text-on-surface-variant">{{ detectLang(selectedKey).icon }}</span>
              <span class="font-mono text-code-sm text-primary font-semibold">{{ selectedKey }}</span>
              <span class="inline-flex items-center gap-1 px-1.5 py-0 rounded text-label-caps font-medium" :class="detectLang(selectedKey).color">
                <span class="material-symbols-outlined text-xs">{{ detectLang(selectedKey).icon }}</span>{{ detectLang(selectedKey).label }}
              </span>
              <span class="text-label-caps text-on-surface-variant">{{ lineCount(cm.data[selectedKey]) }} 行</span>
            </div>
            <div class="flex gap-xs">
              <button v-if="editingKey !== selectedKey" @click="startEdit(selectedKey)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="编辑"><span class="material-symbols-outlined text-lg">edit</span></button>
              <button @click="deleteKey(selectedKey); selectedKey = dataEntries.find(([k]) => k !== selectedKey)?.[0] || ''" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="删除"><span class="material-symbols-outlined text-lg">delete</span></button>
            </div>
          </div>
          <!-- 编辑模式 -->
          <div v-if="editingKey === selectedKey" class="p-md flex-1">
            <textarea v-model="editValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono min-h-[300px] resize-y focus:ring-2 focus:ring-primary focus:border-primary"></textarea>
            <div class="flex justify-end gap-sm mt-sm">
              <button @click="editingKey = null" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm">取消</button>
              <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">保存</button>
            </div>
          </div>
          <!-- 查看模式 -->
          <div v-else class="p-md flex-1">
            <pre class="bg-[#0b1c30] text-[#cfe3ff] rounded-lg p-md font-mono text-code-sm whitespace-pre overflow-auto max-h-[55vh]">{{ cm.data[selectedKey] }}</pre>
          </div>
        </template>
        <!-- 未选中 / 无文件 -->
        <div v-else class="flex items-center justify-center flex-1 min-h-[300px] text-on-surface-variant">
          <div class="text-center">
            <span class="material-symbols-outlined text-3xl text-surface-container-high">description</span>
            <p class="mt-sm text-body-sm">选择左侧文件查看内容</p>
          </div>
        </div>
      </div>
    </div>
```

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误。若 build 报 `isCollapsible/isExpanded/toggleExpand/expandedKeys/COLLAPSE_THRESHOLD` 未使用——这些是旧折叠逻辑，新双栏不需要它们；保留在 script 中无害（不会被 tree-shake 报错），或可删除（可选，不影响 build）。

- [ ] **Step 5: 提交**

```bash
git add src/views/NsConfigMapDetail.vue
git commit -m "feat(configmap): Data tab 改为双栏文件浏览器（左文件列表 + 右内容查看/编辑）"
```

---

## Self-Review（计划编写后自检，已修正）

- **Spec coverage**：① 双栏文件浏览器（Task 1 Step 3）② selectedKey + watch 自动选中（Step 1）③ 添加后自动选中（Step 2）④ 删除后自动跳转（Step 3 模板内 deleteKey 后 selectedKey 跳转）⑤ 编辑/查看切换（Step 3 模板 editingKey === selectedKey）——全覆盖。
- **Placeholder scan**：无 TBD/TODO；每步含可执行 old→new。
- **Type consistency**：`selectedKey` ref（Step 1）→ 模板 `selectedKey === key` / `cm.data[selectedKey]`（Step 3）；`dataEntries` computed（既有）→ 模板 `v-for="([key, val], idx) in dataEntries"`（Step 3）；`detectLang(key)`（既有）→ 模板（Step 3）。字段名一致。
- **旧折叠逻辑**：isCollapsible/isExpanded/toggleExpand/expandedKeys/COLLAPSE_THRESHOLD 在新双栏中不再使用——保留在 script 中（无害，不报 build 错）；可选清理但不阻塞。
