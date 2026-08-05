<script setup>
import { computed } from 'vue'
import EnvSourceField from './EnvSourceField.vue'

// 单个卷挂载卡片（形象排版）：类型图标胶囊 + 挂到容器 + 来源(picker) + 挂载到/subPath/只读 + 键映射 items。
// v-model 整个 entry 对象（直接改其字段）；emit('remove') 由父删行。
// props.containers: [{value,label}] 挂载目标选项（主容器 + 各 init/sidecar）。
const props = defineProps({
  containers: { type: Array, default: () => [{ value: 'main', label: '主容器' }] },
  pvcs: { type: Array, default: () => [] },
  namespace: { type: String, default: '' },
})
const entry = defineModel({ required: true })
const emit = defineEmits(['remove'])

const TYPES = [
  { value: 'emptyDir', label: 'emptyDir', icon: 'folder' },
  { value: 'pvc', label: 'PVC', icon: 'save' },
  { value: 'hostPath', label: 'hostPath', icon: 'dns' },
  { value: 'configMap', label: 'ConfigMap', icon: 'description' },
  { value: 'secret', label: 'Secret', icon: 'key' },
]
const typeIcon = computed(() => TYPES.find(t => t.value === entry.value.type)?.icon || 'folder')
const showItems = computed(() => entry.value.type === 'configMap' || entry.value.type === 'secret')
if (!Array.isArray(entry.value.items)) entry.value.items = []
if (entry.value.readOnly == null) entry.value.readOnly = false
if (!entry.value.target) entry.value.target = 'main'

const fld = 'w-full bg-surface-container-lowest border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors'
</script>

<template>
  <div class="rounded-lg border border-outline-variant p-md bg-surface-container-low/30 flex flex-col gap-sm">
    <!-- 头：类型图标 + 卷名(自动) + 删除 -->
    <div class="flex items-center gap-xs">
      <span class="material-symbols-outlined text-primary text-base">{{ typeIcon }}</span>
      <span class="font-mono text-xs text-on-surface-variant truncate">{{ entry.name }}</span>
      <button @click="emit('remove')" class="ml-auto p-0.5 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button>
    </div>

    <!-- 类型：图标胶囊 -->
    <div class="flex flex-wrap gap-xs">
      <button v-for="t in TYPES" :key="t.value" type="button" @click="entry.type = t.value"
        class="flex items-center gap-0.5 px-sm py-0.5 rounded-full border text-xs transition-colors"
        :class="entry.type === t.value ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:border-primary'">
        <span class="material-symbols-outlined text-sm">{{ t.icon }}</span>{{ t.label }}
      </button>
    </div>

    <!-- 挂到容器 + 来源 -->
    <div class="grid grid-cols-2 gap-xs">
      <div>
        <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">挂到容器</label>
        <select v-model="entry.target" :class="fld">
          <option v-for="c in containers" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </div>
      <div>
        <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">来源</label>
        <select v-if="entry.type === 'pvc'" v-model="entry.pvcName" :class="fld">
          <option value="">选择 PVC</option>
          <option v-for="p in pvcs" :key="p" :value="p">{{ p }}</option>
        </select>
        <input v-else-if="entry.type === 'hostPath'" v-model="entry.hostPath" :class="fld" placeholder="/var/lib/data" />
        <EnvSourceField v-else-if="entry.type === 'configMap'" kind="configmap" :namespace="namespace" :with-key="false" size="sm" class="w-full" v-model:name="entry.cmName" />
        <EnvSourceField v-else-if="entry.type === 'secret'" kind="secret" :namespace="namespace" :with-key="false" size="sm" class="w-full" v-model:name="entry.secretName" />
        <p v-else class="text-xs text-on-surface-variant/70 py-1.5">临时空目录，Pod 删除即失效</p>
      </div>
    </div>

    <!-- 挂载到 / subPath / 只读 -->
    <div class="grid grid-cols-[1fr_1fr_auto] gap-xs items-end">
      <div>
        <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">挂载到</label>
        <input v-model="entry.mountPath" :class="fld" placeholder="/etc/config" />
      </div>
      <div>
        <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">subPath</label>
        <input v-model="entry.subPath" :class="fld" placeholder="(可选)" />
      </div>
      <label class="flex items-center gap-0.5 text-xs text-on-surface-variant pb-1.5 whitespace-nowrap">
        <input type="checkbox" v-model="entry.readOnly" class="h-3.5 w-3.5 accent-primary" /> 只读
      </label>
    </div>

    <!-- 键映射 items（仅 configMap/secret）-->
    <div v-if="showItems" class="border-t border-outline-variant/40 pt-sm">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-semibold text-on-surface-variant">键映射 items（可选：把指定 key 投影成文件名）</span>
        <button type="button" @click="entry.items.push({ key: '', path: '' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>添加</button>
      </div>
      <div v-for="(it, idx) in entry.items" :key="idx" class="flex items-center gap-xs mt-xs">
        <input v-model="it.key" :class="fld" placeholder="key" />
        <span class="material-symbols-outlined text-sm text-on-surface-variant flex-shrink-0">arrow_forward</span>
        <input v-model="it.path" :class="fld" placeholder="文件名 path" />
        <button @click="entry.items.splice(idx, 1)" class="p-0.5 flex-shrink-0 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button>
      </div>
    </div>
  </div>
</template>
