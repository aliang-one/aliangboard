<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import CreatePvcDialog from '@/components/common/CreatePvcDialog.vue'
import { normalizeMountPath } from '@/logic/volumeMountValidation'

const { t } = useI18n()

// 单个卷挂载卡片：类型图标胶囊 + 挂到容器 + 来源(下拉) + 键映射items(key 下拉) + 挂载到/subPath/只读。
// items 与 subPath 可共存（K8s 合法）：subPath 挂载 items 投影出的某个文件。
// v-model 整个 entry；emit('remove') 由父删行。
const props = defineProps({
  containers: { type: Array, default: () => [{ value: 'main', label: null }] },
  pvcs: { type: Array, default: () => [] },
  availableConfigMaps: { type: Array, default: () => [] },
  availableSecrets: { type: Array, default: () => [] },
  namespace: { type: String, default: '' },
  issues: { type: Array, default: () => [] },   // 单源校验器下发的本卡问题({code,field,level,params?})
})
const entry = defineModel({ required: true })
const emit = defineEmits(['remove'])
const store = useClusterStore()
const _cid = computed(() => (store.currentCluster || 'cluster'))
const _cmQ = useResourceList({ key: ['cluster', _cid, 'configmaps'], fetcher: () => store.fetchConfigMaps(), options: { refetchInterval: 30000 } })
const _secQ = useResourceList({ key: ['cluster', _cid, 'secrets'], fetcher: () => store.fetchSecrets(), options: { refetchInterval: 30000 } })

// PVC 内联快速创建:下拉旁「新建」开 CreatePvcDialog;创建后写回 entry.pvcName 并把新名并入 options,
// 使自动选中即时生效(不依赖父列表刷新时机、不受 namespace 过滤差异影响)。
const showCreatePvc = ref(false)
const createdPvcName = ref('')
const pvcOptions = computed(() => [...new Set([...props.pvcs, createdPvcName.value].filter(Boolean))])
// 当前已选名兜底并入 options:值不在列表时(如编辑回填/列表未含)避免 select 显示空
const cmOptions = computed(() => [...new Set([...props.availableConfigMaps, entry.value.cmName].filter(Boolean))])
const secretOptions = computed(() => [...new Set([...props.availableSecrets, entry.value.secretName].filter(Boolean))])
function onPvcCreated(name) {
  createdPvcName.value = name
  entry.value.pvcName = name
}

const TYPES = [
  { value: 'emptyDir', label: 'emptyDir', icon: 'folder' },
  { value: 'pvc', label: 'PVC', icon: 'save' },
  { value: 'hostPath', label: 'hostPath', icon: 'computer' },
  { value: 'nfs', label: 'NFS', icon: 'dns' },
  { value: 'configMap', label: 'ConfigMap', icon: 'description' },
  { value: 'secret', label: 'Secret', icon: 'key' },
]
const typeIcon = computed(() => TYPES.find(t => t.value === entry.value.type)?.icon || 'folder')
const showItems = computed(() => entry.value.type === 'configMap' || entry.value.type === 'secret')
if (entry.value.server == null) entry.value.server = ''
if (entry.value.nfsPath == null) entry.value.nfsPath = ''
if (!Array.isArray(entry.value.items)) entry.value.items = []
if (entry.value.readOnly == null) entry.value.readOnly = false
if (!entry.value.target) entry.value.target = 'main'
if (entry.value.hostPathType == null) entry.value.hostPathType = ''
if (entry.value.defaultMode == null) entry.value.defaultMode = ''

// —— 即时错误态(spec §5)——
const issuesFor = f => props.issues.filter(i => i.field === f || String(i.field).startsWith(f + ':'))
const issueMsg = i => t('component.volumeMount.issue.' + i.code, i.params || {})
const fldErr = f => issuesFor(f).some(i => i.level === 'error')
const fldWarn = f => !fldErr(f) && issuesFor(f).some(i => i.level === 'warn')
// 追加到 fld 之后的错误态类(! 前缀压过 border-outline-variant)
const issueCls = f => (fldErr(f) ? '!border-error focus:!border-error' : fldWarn(f) ? '!border-tertiary-container focus:!border-tertiary-container' : '')
const issueTextCls = { error: 'text-error', warn: 'text-tertiary-container', hint: 'text-on-surface-variant/60' }
const rowIssues = idx => props.issues.filter(i => i.field === 'itemsPath:' + idx)
const cardLevel = computed(() => props.issues.some(i => i.level === 'error') ? 'error' : props.issues.some(i => i.level === 'warn') ? 'warn' : 'ok')
const dotCls = { error: 'bg-error', warn: 'bg-tertiary-container' } // ok → 不渲染

const HOST_PATH_TYPES = ['DirectoryOrCreate', 'Directory', 'FileOrCreate', 'File', 'Socket', 'CharDevice', 'BlockDevice']
// defaultMode 三态下拉:预设值直接对应;'custom' 模式露出自由输入(八进制)
const defaultModeChoice = computed({
  get: () => (['', '0400', '0640'].includes(entry.value.defaultMode) ? entry.value.defaultMode : 'custom'),
  set: v => { if (v !== 'custom') entry.value.defaultMode = v; else if (!/^[0-7]{3,4}$/.test(entry.value.defaultMode || '')) entry.value.defaultMode = '0444' },
})
function onBlurMountPath() {
  const n = normalizeMountPath(entry.value.mountPath)
  if (n !== entry.value.mountPath) entry.value.mountPath = n
}

// 所选 configMap/secret 的 data 键（用于 items 的 key 下拉）
const selectedKeys = computed(() => {
  const isSecret = entry.value.type === 'secret'
  const list = isSecret ? (_secQ.data.value || []) : (_cmQ.data.value || [])
  const name = isSecret ? entry.value.secretName : entry.value.cmName
  const res = (list || []).find(r => r.name === name && r.namespace === props.namespace)
  return Object.keys(res?.data || {})
})
function onItemKey(it) { if (!it.path) it.path = it.key }

const fld = 'w-full bg-surface-container-lowest border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors'
</script>

<template>
  <div class="rounded-lg border border-outline-variant p-md bg-surface-container-low/30 flex flex-col gap-sm">
    <!-- 头：类型图标 + 卷名(自动) + 删除 -->
    <div class="flex items-center gap-xs">
      <span class="material-symbols-outlined text-primary text-base">{{ typeIcon }}</span>
      <span v-if="cardLevel !== 'ok'" data-testid="status-dot" class="h-2 w-2 rounded-full shrink-0" :class="dotCls[cardLevel]" />
      <span class="font-mono text-xs text-on-surface-variant truncate" :class="issuesFor('name').some(i => i.level === 'error') ? 'text-error' : ''">{{ entry.name }}</span>
      <button @click="emit('remove')" class="ml-auto p-0.5 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button>
    </div>
    <div v-if="issuesFor('name').length" class="flex flex-col">
      <p v-for="(i, ii) in issuesFor('name')" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
    </div>

    <!-- 类型：图标胶囊 -->
    <div class="flex flex-wrap gap-xs">
      <button v-for="t in TYPES" :key="t.value" type="button" @click="entry.type = t.value"
        class="flex items-center gap-0.5 px-sm py-0.5 rounded-full border text-xs transition-colors"
        :class="entry.type === t.value ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:border-primary'">
        <span class="material-symbols-outlined text-sm">{{ t.icon }}</span>{{ t.label }}
      </button>
    </div>

    <!-- 挂到容器 + 来源（下拉选择）-->
    <div class="grid grid-cols-2 gap-xs">
      <div>
        <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">{{ t('component.volumeMount.mountToContainer') }}</label>
        <select v-model="entry.target" :class="[fld, issueCls('target')]">
          <option v-for="c in containers" :key="c.value" :value="c.value">{{ c.label ?? t('component.volumeMountCard.mainContainer') }}</option>
        </select>
      </div>
      <div>
        <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">{{ t('component.volumeMount.source') }}</label>
        <div v-if="entry.type === 'pvc'" class="flex gap-xs">
          <select v-model="entry.pvcName" :class="[fld, issueCls('source')]" class="flex-1">
            <option value="">{{ t('component.volumeMount.selectPvc') }}</option>
            <option v-for="p in pvcOptions" :key="p" :value="p">{{ p }}</option>
          </select>
          <button type="button" :disabled="!namespace" @click="showCreatePvc = true"
            :title="t('component.volumeMount.newPvc')"
            class="shrink-0 px-sm rounded-md border border-outline-variant text-on-surface-variant hover:bg-surface-container-high hover:text-primary disabled:opacity-40 transition-colors">
            <span class="material-symbols-outlined text-sm">add</span>
          </button>
          <CreatePvcDialog v-model="showCreatePvc" :namespace="namespace" @created="onPvcCreated" />
        </div>
        <template v-else-if="entry.type === 'hostPath'">
          <input v-model="entry.hostPath" :class="[fld, issueCls('source'), issueCls('hostPath')]" placeholder="/var/lib/data" class="mb-1" />
          <select v-model="entry.hostPathType" :class="fld">
            <option value="">{{ t('component.volumeMount.hostPathTypeUnset') }}</option>
            <option v-for="hpt in HOST_PATH_TYPES" :key="hpt" :value="hpt">{{ hpt }}</option>
          </select>
        </template>
        <div v-else-if="entry.type === 'nfs'" class="grid grid-cols-2 gap-xs">
          <input v-model="entry.server" :class="[fld, issueCls('source')]" :placeholder="t('component.volumeMount.serverPlaceholder')" />
          <input v-model="entry.nfsPath" :class="[fld, issueCls('nfsPath')]" :placeholder="t('component.volumeMount.exportPathPlaceholder')" />
        </div>
        <select v-else-if="entry.type === 'configMap'" v-model="entry.cmName" :class="[fld, issueCls('source')]">
          <option value="">{{ t('component.volumeMount.selectConfigMap') }}</option>
          <option v-for="cm in cmOptions" :key="cm" :value="cm">{{ cm }}</option>
        </select>
        <select v-else-if="entry.type === 'secret'" v-model="entry.secretName" :class="[fld, issueCls('source')]">
          <option value="">{{ t('component.volumeMount.selectSecret') }}</option>
          <option v-for="s in secretOptions" :key="s" :value="s">{{ s }}</option>
        </select>
        <p v-else class="text-xs text-on-surface-variant/70 py-1.5">{{ t('component.volumeMount.emptyDirHint') }}</p>
        <template v-if="issuesFor('source').length || issuesFor('hostPath').length || issuesFor('nfsPath').length">
          <p v-for="(i, ii) in [...issuesFor('source'), ...issuesFor('hostPath'), ...issuesFor('nfsPath')]" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
        </template>
      </div>
    </div>

    <!-- 键映射 items（仅 configMap/secret；key 下拉选择）—— 置上 -->
    <div v-if="showItems" class="border-t border-outline-variant/40 pt-sm flex flex-col gap-xs">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-semibold text-on-surface-variant">{{ t('component.volumeMount.keyMapping') }}</span>
        <button type="button" @click="entry.items.push({ key: '', path: '' })" class="flex items-center gap-0.5 text-xs font-medium text-primary hover:bg-primary-container/10 rounded px-xs py-0.5 transition-colors"><span class="material-symbols-outlined text-sm">add</span>{{ t('common.add') }}</button>
      </div>
      <p class="text-[10px] text-on-surface-variant/60">{{ t('component.volumeMount.keyMappingHint') }}</p>
      <template v-if="issuesFor('items').length">
        <p v-for="(i, ii) in issuesFor('items')" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
      </template>
      <div v-for="(it, idx) in entry.items" :key="idx" class="flex flex-col">
        <div class="grid grid-cols-[1fr_auto_1fr_auto] gap-xs items-center">
          <select v-model="it.key" @change="onItemKey(it)" :class="[fld, issueCls('itemsPath:' + idx)]">
            <option value="">{{ t('component.volumeMount.selectKey') }}</option>
            <option v-for="k in selectedKeys" :key="k" :value="k">{{ k }}</option>
          </select>
          <span class="material-symbols-outlined text-sm text-on-surface-variant">arrow_forward</span>
          <input v-model="it.path" :class="[fld, issueCls('itemsPath:' + idx)]" :placeholder="t('component.volumeMount.fileNamePlaceholder')" />
          <button @click="entry.items.splice(idx, 1)" class="p-0.5 text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-md transition-colors"><span class="material-symbols-outlined text-base">close</span></button>
        </div>
        <p v-for="(i, ii) in rowIssues(idx)" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
      </div>
      <p v-if="(entry.cmName || entry.secretName) && !selectedKeys.length" class="text-[10px] text-on-surface-variant/60">{{ t('component.volumeMount.noKeysHint') }}</p>
      <div class="grid grid-cols-[1fr_auto] gap-xs items-end">
        <div>
          <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">{{ t('component.volumeMount.defaultMode') }}</label>
          <select v-model="defaultModeChoice" :class="[fld, issueCls('defaultMode')]">
            <option value="">{{ t('component.volumeMount.defaultModeDefault') }}</option>
            <option value="0400">0400</option>
            <option value="0640">0640</option>
            <option value="custom">{{ t('component.volumeMount.defaultModeCustom') }}</option>
          </select>
        </div>
        <input v-if="defaultModeChoice === 'custom'" v-model="entry.defaultMode" :class="[fld, issueCls('defaultMode')]" class="w-20" placeholder="0444" />
      </div>
      <template v-if="issuesFor('defaultMode').length">
        <p v-for="(i, ii) in issuesFor('defaultMode')" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
      </template>
    </div>

    <!-- 挂载到 / subPath / 只读 —— 置下 -->
    <div class="grid grid-cols-[1fr_1fr_auto] gap-xs items-end">
      <div>
        <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">{{ t('component.volumeMount.mountPath') }}</label>
        <input v-model="entry.mountPath" :class="[fld, issueCls('mountPath')]" placeholder="/etc/config" @blur="onBlurMountPath" />
        <p v-for="(i, ii) in issuesFor('mountPath')" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
      </div>
      <div>
        <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">{{ t('component.volumeMount.subPathLabel') }}</label>
        <input v-model="entry.subPath" :class="[fld, issueCls('subPath')]" :placeholder="t('component.volumeMount.subPathPlaceholder')" />
        <p v-for="(i, ii) in issuesFor('subPath')" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
      </div>
      <label class="flex items-center gap-0.5 text-xs text-on-surface-variant pb-1.5 whitespace-nowrap">
        <input type="checkbox" v-model="entry.readOnly" class="h-3.5 w-3.5 accent-primary" /> {{ t('component.volumeMount.readOnly') }}
        <template v-if="issuesFor('readOnly').length">
          <span v-for="(i, ii) in issuesFor('readOnly')" :key="ii" class="block text-[10px]" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</span>
        </template>
      </label>
    </div>
  </div>
</template>
