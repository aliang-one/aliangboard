<script setup>
// Init/Sidecar 容器「完整编辑」弹窗:复用 Modal 壳(z 层/ESC/遮罩)。draft 副本编辑,
// 确认(合法才可点)emit('confirm', {...draft}),父组件 Object.assign 写回原槽位
// (数组身份不变 → 卷挂载 init:idx/sidecar:idx target 稳定);取消/ESC/遮罩丢弃 draft。
// 校验单源 logic/containerValidation。显错规则 = 字段 blur 过才显示
// (确认按钮非法即禁用,故无需「点确认后」分支,避免新容器一打开满屏红)。
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/common/Modal.vue'
import ResourceInput from '@/components/common/ResourceInput.vue'
import EnvSourceField from '@/components/common/EnvSourceField.vue'
import { validateContainerFields } from '@/logic/containerValidation'
import { makeSubContainer, advancedCount } from '@/logic/subContainer'
import { sanitizeImageToName } from '@/utils/containerNames'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  container: { type: Object, required: true },
  kind: { type: String, default: 'init' },          // 'init' | 'sidecar'
  index: { type: Number, default: 0 },
  otherNames: { type: Array, default: () => [] },   // 主容器有效名 + 其他容器显式名(查重)
  namespace: { type: String, default: '' },         // EnvSourceField 候选过滤用
})
const emit = defineEmits(['update:modelValue', 'confirm'])
const { t } = useI18n()

// 打开即重置 draft(全字段模型;传入容器可能是旧 8 字段——makeSubContainer 兜底混入)与 touched
const draft = ref({ ...makeSubContainer(), ...props.container })
const touched = ref({})
watch(() => props.modelValue, open => {
  if (open) { draft.value = { ...makeSubContainer(), ...props.container }; touched.value = {} }
})

// 折叠节状态(默认收起);高级项计数展示于标题旁(卡片 badge 按钮本体在调用方,Task 7/10)
const openSect = ref({ env: false, ports: false, probes: false, lifecycle: false, security: false })
const advCount = computed(() => advancedCount(draft.value))
const PROBES = ['liveness', 'readiness', 'startup']

function addEnvRow(list) {
  draft.value[list].push(list === 'envVars' ? { key: '', value: '' } : list === 'envCMKeys' ? { name: '', cmName: '', key: '' } : { name: '', secretName: '', key: '' })
}
function addPortRow() { draft.value.ports.push({ containerPort: '', protocol: 'TCP' }) }

const errors = computed(() => validateContainerFields(draft.value, props.otherNames))
const errorsByField = computed(() => {
  const m = {}
  for (const e of errors.value) if (!m[e.field]) m[e.field] = e
  return m
})
function showErr(field) { return touched.value[field] ? errorsByField.value[field] : null }
function markTouched(field) { touched.value[field] = true }

const title = computed(() => t(props.kind === 'init' ? 'deploy.editInitContainer' : 'deploy.editSidecarContainer'))

// name 留空 → 自动派生名预览(与 YAML 生成同源清洗;撞名时 YAML 端会自动加 -2 序号)
const autoName = computed(() => {
  const base = sanitizeImageToName(draft.value.image) || `${props.kind}-${props.index + 1}`
  return { base, conflict: props.otherNames.includes(base) }
})

function onConfirm() {
  if (errors.value.length) return
  emit('confirm', { ...draft.value })
  emit('update:modelValue', false)
}
</script>

<template>
  <Modal :model-value="modelValue" :title="title" width="max-w-2xl"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="flex flex-col gap-md">
      <div v-if="advCount" data-testid="ced-advanced-count" class="text-xs text-on-surface-variant">{{ t('deploy.ced.advancedBadge', { n: advCount }) }}</div>
      <section class="flex flex-col gap-sm">
        <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.containerSectionBasic') }}</h4>
        <div>
          <label for="ced-name" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.containerName') }}</label>
          <input id="ced-name" data-testid="ced-name-input" v-model="draft.name" @blur="markTouched('name')"
            class="w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary/20"
            :class="showErr('name') ? 'border-error' : 'border-outline-variant'" placeholder="init name" />
          <p v-if="showErr('name')" data-testid="ced-name-error" class="text-xs text-error mt-xs">{{ t(showErr('name').msgKey, showErr('name').params) }}</p>
          <p v-else-if="!draft.name" data-testid="ced-auto-name-preview" class="text-xs text-on-surface-variant mt-xs">
            {{ autoName.conflict ? t('deploy.containerFv.autoNameDedupeNote', { name: autoName.base }) : t('deploy.containerFv.autoNamePreview', { name: autoName.base }) }}
          </p>
        </div>
        <div>
          <label for="ced-image" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.imageUrl') }}</label>
          <input id="ced-image" data-testid="ced-image-input" v-model="draft.image" @blur="markTouched('image')"
            class="w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary/20"
            :class="showErr('image') ? 'border-error' : 'border-outline-variant'" placeholder="image" />
          <p v-if="showErr('image')" data-testid="ced-image-error" class="text-xs text-error mt-xs">{{ t(showErr('image').msgKey, showErr('image').params) }}</p>
        </div>
        <div v-if="kind === 'sidecar'" class="flex flex-col gap-xs">
          <label class="flex items-center gap-sm cursor-pointer">
            <input type="checkbox" data-testid="ced-native-toggle" v-model="draft.nativeSidecar" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t('deploy.ced.nativeSidecar') }}</span>
          </label>
          <p v-if="draft.nativeSidecar" class="text-xs text-on-surface-variant">{{ t('deploy.ced.nativeSidecarHint') }}</p>
        </div>
        <div>
          <label for="ced-workdir" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.workingDir') }}</label>
          <input id="ced-workdir" data-testid="ced-workdir-input" v-model="draft.workingDir"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/app" />
        </div>
        <div>
          <label for="ced-pullpolicy" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.pullPolicy') }}</label>
          <select id="ced-pullpolicy" data-testid="ced-pullpolicy-select" v-model="draft.pullPolicy"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono">
            <option value="">—</option>
            <option>IfNotPresent</option><option>Always</option><option>Never</option>
          </select>
        </div>
        <div class="flex items-center gap-md">
          <label class="flex items-center gap-xs cursor-pointer">
            <input type="checkbox" data-testid="ced-stdin-toggle" v-model="draft.stdin" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t('deploy.ced.stdinLabel') }}</span>
          </label>
          <label class="flex items-center gap-xs cursor-pointer">
            <input type="checkbox" data-testid="ced-tty-toggle" v-model="draft.tty" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t('deploy.ttyLabel') }}</span>
          </label>
        </div>
      </section>

      <section class="flex flex-col gap-sm">
        <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.containerSectionCommand') }}</h4>
        <div>
          <label for="ced-command" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.command') }}</label>
          <input id="ced-command" data-testid="ced-command-input" v-model="draft.command"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="sh -c" />
          <p class="text-xs text-on-surface-variant mt-xs">{{ t('deploy.commandHint') }}</p>
        </div>
        <div>
          <label for="ced-args" class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.args') }}<span class="ml-xs font-normal text-on-surface-variant/70">{{ t('deploy.argsHint') }}</span></label>
          <textarea id="ced-args" data-testid="ced-args-input" v-model="draft.args" rows="6"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono resize-y" />
        </div>
      </section>

      <section class="flex flex-col gap-sm">
        <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.containerSectionResources') }}</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-sm">
          <div data-testid="ced-cpu-request" @focusout="markTouched('cpu')">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.cpuRequestLabel') }}</label>
            <ResourceInput v-model="draft.cpuRequest" kind="cpu" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.cpuLimitLabel') }}</label>
            <ResourceInput v-model="draft.cpuLimit" kind="cpu" />
          </div>
          <div data-testid="ced-memory-request" @focusout="markTouched('memory')">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.memoryRequestLabel') }}</label>
            <ResourceInput v-model="draft.memoryRequest" kind="memory" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.memoryLimitLabel') }}</label>
            <ResourceInput v-model="draft.memoryLimit" kind="memory" />
          </div>
        </div>
        <p v-if="showErr('cpu')" data-testid="ced-cpu-error" class="text-xs text-error">{{ t(showErr('cpu').msgKey, showErr('cpu').params) }}</p>
        <p v-if="showErr('memory')" data-testid="ced-memory-error" class="text-xs text-error">{{ t(showErr('memory').msgKey, showErr('memory').params) }}</p>
      </section>

      <!-- 环境(折叠) -->
      <section data-testid="ced-env-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionEnv') }}</h4>
          <button type="button" data-testid="ced-env-toggle" @click="openSect.env = !openSect.env" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.env ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.env" class="flex flex-col gap-sm mt-sm">
          <div class="flex items-center justify-between"><span class="text-xs text-on-surface-variant">{{ t('deploy.envDirectGroup') }}</span>
            <button type="button" data-testid="ced-env-add" @click="addEnvRow('envVars')" class="text-xs text-primary hover:bg-primary-container/10 rounded px-sm py-xs">{{ t('deploy.ced.addEnvRow') }}</button></div>
          <div v-for="(e, i) in draft.envVars" :key="'ev'+i" class="grid grid-cols-2 gap-sm">
            <input :data-testid="'ced-env-key-'+i" v-model="e.key" @blur="markTouched('env')" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.ced.envKeyPh')" />
            <input :data-testid="'ced-env-val-'+i" v-model="e.value" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.ced.envValPh')" />
          </div>
          <div class="flex items-center justify-between"><span class="text-xs text-on-surface-variant">{{ t('deploy.fromConfigMap') }}</span>
            <button type="button" @click="addEnvRow('envCMKeys')" class="text-xs text-primary hover:bg-primary-container/10 rounded px-sm py-xs">{{ t('deploy.ced.addEnvRow') }}</button></div>
          <div v-for="(e, i) in draft.envCMKeys" :key="'cm'+i" class="flex gap-sm">
            <input :data-testid="'ced-envcm-name-'+i" v-model="e.name" class="w-28 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-xs font-mono" :placeholder="t('deploy.ced.envNamePh')" />
            <EnvSourceField kind="configmap" :namespace="namespace" class="flex-1" v-model:name="e.cmName" v-model:dataKey="e.key" />
          </div>
          <div class="flex items-center justify-between"><span class="text-xs text-on-surface-variant">{{ t('deploy.fromSecret') }}</span>
            <button type="button" @click="addEnvRow('envSecretKeys')" class="text-xs text-primary hover:bg-primary-container/10 rounded px-sm py-xs">{{ t('deploy.ced.addEnvRow') }}</button></div>
          <div v-for="(e, i) in draft.envSecretKeys" :key="'sk'+i" class="flex gap-sm">
            <input :data-testid="'ced-envsk-name-'+i" v-model="e.name" class="w-28 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-xs font-mono" :placeholder="t('deploy.ced.envNamePh')" />
            <EnvSourceField kind="secret" :namespace="namespace" class="flex-1" v-model:name="e.secretName" v-model:dataKey="e.key" />
          </div>
          <div class="grid grid-cols-2 gap-sm">
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.envFromCmLabel') }}</label>
              <input v-model="draft.envFromConfigMap" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.envFromSecretLabel') }}</label>
              <input v-model="draft.envFromSecret" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" /></div>
          </div>
          <p v-if="showErr('env')" data-testid="ced-env-error" class="text-xs text-error">{{ t(showErr('env').msgKey, showErr('env').params) }}</p>
        </div>
      </section>

      <!-- 端口(折叠) -->
      <section data-testid="ced-ports-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionPorts') }}</h4>
          <button type="button" data-testid="ced-ports-toggle" @click="openSect.ports = !openSect.ports" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.ports ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.ports" class="flex flex-col gap-sm mt-sm">
          <button type="button" data-testid="ced-ports-add" @click="addPortRow" class="self-start text-xs text-primary hover:bg-primary-container/10 rounded px-sm py-xs">{{ t('deploy.ced.addPortRow') }}</button>
          <div v-for="(p, i) in draft.ports" :key="'pt'+i" class="grid grid-cols-2 gap-sm">
            <input :data-testid="'ced-port-'+i" v-model="p.containerPort" @blur="markTouched('ports')" type="number" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.ced.portNumberPh')" />
            <select v-model="p.protocol" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono">
              <option>TCP</option><option>UDP</option><option>SCTP</option>
            </select>
          </div>
          <p v-if="showErr('ports')" data-testid="ced-ports-error" class="text-xs text-error">{{ t(showErr('ports').msgKey, showErr('ports').params) }}</p>
        </div>
      </section>

      <!-- 探针(折叠;三探针各一块) -->
      <section data-testid="ced-probes-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionProbes') }}</h4>
          <button type="button" data-testid="ced-probes-toggle" @click="openSect.probes = !openSect.probes" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.probes ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.probes" class="flex flex-col gap-md mt-sm">
          <div v-for="pk in PROBES" :key="pk" class="border border-outline-variant rounded-lg p-sm flex flex-col gap-xs">
            <div class="flex items-center gap-sm">
              <label class="flex items-center gap-xs cursor-pointer">
                <input type="checkbox" :data-testid="'ced-probe-enable-' + pk" v-model="draft[pk].enabled" @change="markTouched(pk)" class="h-4 w-4 accent-primary" />
                <span class="text-xs font-semibold">{{ pk }}</span>
              </label>
              <select v-model="draft[pk].type" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono">
                <option value="http">{{ t('deploy.ced.probeTypeHttp') }}</option>
                <option value="tcp">{{ t('deploy.ced.probeTypeTcp') }}</option>
                <option value="exec">{{ t('deploy.ced.probeTypeExec') }}</option>
              </select>
            </div>
            <div v-if="draft[pk].enabled" class="flex flex-col gap-xs">
              <div v-if="draft[pk].type === 'http'" class="grid grid-cols-2 gap-sm">
                <input v-model="draft[pk].httpPath" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.httpPath')" />
                <input :data-testid="'ced-' + pk + '-port'" v-model="draft[pk].port" @blur="markTouched(pk)" type="number" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.port')" />
              </div>
              <div v-else-if="draft[pk].type === 'tcp'">
                <input :data-testid="'ced-' + pk + '-port'" v-model="draft[pk].port" @blur="markTouched(pk)" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.port')" />
              </div>
              <div v-else>
                <input v-model="draft[pk].execCommand" @blur="markTouched(pk)" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" :placeholder="t('deploy.execCommand')" />
              </div>
              <div class="grid grid-cols-2 md:grid-cols-3 gap-xs">
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.initialDelay') }}</label><input v-model.number="draft[pk].initialDelaySeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.period') }}</label><input v-model.number="draft[pk].periodSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.timeoutSeconds') }}</label><input v-model.number="draft[pk].timeoutSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.failureThreshold') }}</label><input v-model.number="draft[pk].failureThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.successThreshold') }}</label><input v-model.number="draft[pk].successThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs text-xs font-mono" /></div>
              </div>
            </div>
            <p v-if="showErr(pk)" :data-testid="'ced-' + pk + '-error'" class="text-xs text-error">{{ t(showErr(pk).msgKey, showErr(pk).params) }}</p>
          </div>
        </div>
      </section>

      <!-- 生命周期(折叠) -->
      <section data-testid="ced-lifecycle-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionLifecycle') }}</h4>
          <button type="button" data-testid="ced-lifecycle-toggle" @click="openSect.lifecycle = !openSect.lifecycle" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.lifecycle ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.lifecycle" class="grid grid-cols-1 md:grid-cols-2 gap-sm mt-sm">
          <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.postStart') }}</label>
            <input v-model="draft.lifecycle.postStart" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="echo started" /></div>
          <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.preStop') }}</label>
            <input v-model="draft.lifecycle.preStop" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="echo stopping" /></div>
        </div>
      </section>

      <!-- 安全上下文(折叠) -->
      <section data-testid="ced-security-section">
        <div class="flex items-center justify-between">
          <h4 class="text-body-sm font-semibold text-on-surface-variant">{{ t('deploy.ced.sectionSecurity') }}</h4>
          <button type="button" data-testid="ced-security-toggle" @click="openSect.security = !openSect.security" class="p-1 text-on-surface-variant hover:bg-surface-container-high rounded-lg">
            <span class="material-symbols-outlined text-base">{{ openSect.security ? 'expand_less' : 'expand_more' }}</span>
          </button>
        </div>
        <div v-show="openSect.security" class="flex flex-col gap-sm mt-sm">
          <label class="flex items-center gap-sm cursor-pointer">
            <input type="checkbox" v-model="draft.securityContext.enabled" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t('deploy.enableSecurityContext') }}</span>
          </label>
          <div v-if="draft.securityContext.enabled" class="grid grid-cols-2 gap-sm">
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.runAsUser') }}</label>
              <input v-model="draft.securityContext.runAsUser" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.ced.runAsGroup') }}</label>
              <input v-model="draft.securityContext.runAsGroup" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" /></div>
            <label class="flex items-center gap-sm col-span-2 cursor-pointer">
              <input type="checkbox" v-model="draft.securityContext.privileged" class="h-4 w-4 accent-primary" />
              <span class="text-xs">{{ t('deploy.ced.privileged') }}</span>
            </label>
            <label class="flex items-center gap-sm cursor-pointer">
              <input type="checkbox" v-model="draft.securityContext.runAsNonPrivileged" class="h-4 w-4 accent-primary" />
              <span class="text-xs">{{ t('deploy.ced.runAsNonRoot') }}</span>
            </label>
            <label class="flex items-center gap-sm cursor-pointer">
              <input type="checkbox" v-model="draft.securityContext.readOnlyRootFilesystem" class="h-4 w-4 accent-primary" />
              <span class="text-xs">{{ t('deploy.ced.readOnlyRootFilesystem') }}</span>
            </label>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.addCapabilities') }}</label>
              <input v-model="draft.securityContext.addCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="NET_ADMIN" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ t('deploy.dropCapabilities') }}</label>
              <input v-model="draft.securityContext.dropCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-xs font-mono" placeholder="ALL" /></div>
          </div>
        </div>
      </section>
    </div>

    <template #actions>
      <span v-if="errors.length" class="mr-auto text-xs text-on-surface-variant self-center">{{ t('deploy.containerFv.confirmDisabledHint') }}</span>
      <button data-testid="ced-cancel-btn" @click="emit('update:modelValue', false)"
        class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('component.modal.cancel') }}</button>
      <button data-testid="ced-confirm-btn" :disabled="errors.length" @click="onConfirm"
        class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold disabled:opacity-40">{{ t('component.modal.confirm') }}</button>
    </template>
  </Modal>
</template>
