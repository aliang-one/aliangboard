<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import { PERF_GROUPS, buildIngressAnnotations } from '@/composables/useIngressPerf'
import { isEmptyEnvRow, firstDuplicateEnvName } from '@/utils/envRows'
import { yamlScalar } from '@/composables/useYaml'
import { TIER_OPTIONS } from '@/composables/useLayering'
import { recordTagUsage } from '@/composables/useTagHistory'
import { notify } from '@/composables/useToast'
import TagInput from '@/components/common/TagInput.vue'
import PortSelect from '@/components/common/PortSelect.vue'
import EnvSourceField from '@/components/common/EnvSourceField.vue'
import VolumeMountCard from '@/components/common/VolumeMountCard.vue'
import AnnotationKeySelect from '@/components/common/AnnotationKeySelect.vue'
import { useCopySeed } from '@/composables/useCopySeed'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
if (route.params.namespace) store.setNamespace(route.params.namespace)

const cid = computed(() => (store.currentCluster || 'cluster'))
const nsQ = useResourceList({ key: ['cluster', cid, 'namespaces'], fetcher: () => store.fetchNamespaces(), options: { refetchInterval: 60000 } })
const allNamespaces = computed(() => nsQ.data.value ?? store.namespaceList)
const priorityClassesQuery = useResourceList({
  key: ['cluster', cid, 'priorityclasses'],
  fetcher: () => store.fetchPriorityClasses(),
  options: { refetchInterval: 30000 },
})
const serviceAccountsQuery = useResourceList({
  key: ['cluster', cid, 'serviceaccounts'],
  fetcher: () => store.fetchServiceAccounts(),
  options: { refetchInterval: 30000 },
})
// IngressClass 下拉源（集群级真实网关类；弃用硬编码 nginx/traefik/kong，避免指向集群里不存在的类）
const ingressClassQ = useResourceList({ key: ['cluster', cid, 'ingressclasses'], fetcher: () => store.fetchIngressClasses(), options: { staleTime: 60_000 } })
const allIngressClasses = computed(() => ingressClassQ.data.value || [])

const ns = computed(() => route.params.namespace)

const currentStep = ref(0)
const showDeploySuccess = ref(false)
const showAdvanced = ref(false)
const deployLoading = ref(false)
const deployError = ref('')

function makeForm() {
  return {
  name: '',
  namespace: route.params.namespace || 'default',
  workloadType: 'Deployment',
  description: '',
  replicas: 1,
  tier: 'svc',
  // Container（主工作容器）
  containerName: '',
  image: '',
  pullPolicy: 'IfNotPresent',
  command: '',
  args: '',
  workingDir: '',
  stdin: false,
  tty: false,
  cpuRequest: '250m',
  cpuLimit: '500m',
  memoryRequest: '256Mi',
  memoryLimit: '512Mi',
  envVars: [],
  envFromConfigMap: '',
  envFromSecret: '',
  envCMKeys: [],
  envSecretKeys: [],
  // 健康探针（容器策略）
  liveness: { enabled: false, type: 'http', httpPath: '/health', port: 8080, execCommand: '', initialDelaySeconds: 30, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 },
  readiness: { enabled: false, type: 'http', httpPath: '/ready', port: 8080, execCommand: '', initialDelaySeconds: 5, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 },
  startup: { enabled: false, type: 'http', httpPath: '/', port: 8080, execCommand: '', initialDelaySeconds: 0, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 },
  // 额外工作容器（sidecar）与初始容器（init）
  extraContainers: [],
  initContainers: [],
  // Storage & Network
  ports: [],
  volumeMounts: [],
  // Service & Ingress
  createService: true,
  serviceType: 'ClusterIP',
  servicePorts: [{ name: 'http', port: '', targetPort: '', nodePort: '', protocol: 'TCP' }],
  externalName: '',
  createIngress: false,
  ingressClassName: '',
  ingressRules: [{ host: '', paths: [{ path: '/', pathType: 'Prefix' }], tls: false, tlsSecret: '' }],
  ingressAdv: {},
  ingressCustomAnnotations: [],
  // Labels
  labels: [{ key: 'app', value: '' }],
  annotations: [],
  // 业务元数据（aliangboard.io/* 标签体系）：title/owner/version/tags 进 label，description 进 annotation
  metaTitle: '',
  metaOwner: '',
  metaVersion: '',
  metaTags: '',
  metaDescription: '',
  // Scheduling & Update Strategy
  nodeSelectors: [],
  tolerations: [],
  strategy: 'RollingUpdate',
  maxSurge: '25%',
  maxUnavailable: '25%',
  revisionHistoryLimit: 10,
  priorityClassName: '',
  serviceAccountName: '',
  // Job 专属
  jobConfig: { completions: 1, parallelism: 1, backoffLimit: 6, activeDeadlineSeconds: '' },
  // CronJob 专属
  cronConfig: { schedule: '*/5 * * * *', concurrencyPolicy: 'Allow', suspend: false, successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1 },
  // 镜像拉取凭证（pod 级）
  imagePullSecrets: '',
  // 容器安全上下文
  securityContext: { enabled: false, privileged: false, runAsUser: '', runAsGroup: '', runAsNonPrivileged: false, readOnlyRootFilesystem: false, addCaps: '', dropCaps: '' },
  // Pod 安全上下文（pod 级）
  podSecurityContext: { runAsUser: '', runAsGroup: '', runAsNonRoot: false, fsGroup: '', seccompProfile: '' },
  // DNS
  dnsPolicy: '',
  dnsConfig: { nameservers: [], searches: [], options: [] },
  // 主机别名
  hostAliases: [],
  // 主机网络
  hostNetwork: false, hostPID: false, hostIPC: false,
  // Pod 亲和/反亲和（简化）
  podAffinity: { enabled: false, type: 'anti-affinity', topologyKey: 'kubernetes.io/hostname', labelKey: '', labelValue: '', strength: 'preferred' },
  // 生命周期钩子
  lifecycle: { postStart: '', preStop: '' },
  }
}
const form = ref(makeForm())

// 复制 workload:若有 seed(来自 CopyWorkloadDialog),用源数据初始化表单
const { consumeSeed } = useCopySeed()
const copySeed = consumeSeed()
const copyHint = ref('')
if (copySeed?.form) {
  form.value = { ...makeForm(), ...copySeed.form }
  copyHint.value = copySeed.source || ''
}

// 整体重置表单（保留当前命名空间）—— 用于「Deploy Another」避免残留脏数据
function resetForm() {
  const ns = form.value.namespace
  form.value = { ...makeForm(), namespace: ns }
}

const steps = [
  { title: t('deploy.step1'), icon: 'info' },
  { title: t('deploy.step2'), icon: 'layers' },
  { title: t('deploy.step3'), icon: 'storage' },
  { title: t('deploy.step4'), icon: 'settings' },
  { title: t('deploy.step5'), icon: 'hub' },
  { title: t('deploy.step6'), icon: 'rocket_launch' },
]

const workloadTypes = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']

function addEnvVar() { form.value.envVars.push({ key: '', value: '' }) }
function removeEnvVar(idx) { form.value.envVars.splice(idx, 1) }
function addEnvCMKey() { form.value.envCMKeys.push({ name: '', cmName: '', key: '' }) }
function removeEnvCMKey(idx) { form.value.envCMKeys.splice(idx, 1) }
function addEnvSecretKey() { form.value.envSecretKeys.push({ name: '', secretName: '', key: '' }) }
function removeEnvSecretKey(idx) { form.value.envSecretKeys.splice(idx, 1) }
function addExtraContainer() { form.value.extraContainers.push({ name: '', image: '', command: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' }) }
function removeExtraContainer(idx) { form.value.extraContainers.splice(idx, 1) }
function addInitContainer() { form.value.initContainers.push({ name: '', image: '', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' }) }
function removeInitContainer(idx) { form.value.initContainers.splice(idx, 1) }
function addPort() { form.value.ports.push({ containerPort: '', protocol: 'TCP' }) }
function removePort(idx) { form.value.ports.splice(idx, 1) }
function addServicePort() { form.value.servicePorts.push({ name: '', port: '', targetPort: '', nodePort: '', protocol: 'TCP' }) }
function removeServicePort(idx) { form.value.servicePorts.splice(idx, 1) }
function addIngressRule() { form.value.ingressRules.push({ host: '', paths: [{ path: '/', pathType: 'Prefix' }], tls: false, tlsSecret: '' }) }
function removeIngressRule(idx) { form.value.ingressRules.splice(idx, 1) }
function addIngressPath(rIdx) { form.value.ingressRules[rIdx].paths.push({ path: '/', pathType: 'Prefix' }) }
function removeIngressPath(rIdx, pIdx) { form.value.ingressRules[rIdx].paths.splice(pIdx, 1) }
function genVolName() { return 'vol-' + Math.random().toString(36).slice(2, 8) }
function addVolume() { form.value.volumeMounts.push({ name: genVolName(), target: 'main', type: 'pvc', mountPath: '', subPath: '', readOnly: false, pvcName: '', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] }) }
function removeVolume(idx) { form.value.volumeMounts.splice(idx, 1) }
function addLabel() { form.value.labels.push({ key: '', value: '' }) }
function removeLabel(idx) { form.value.labels.splice(idx, 1) }
function addAnnotation() { form.value.annotations.push({ key: '', value: '' }) }
function removeAnnotation(idx) { form.value.annotations.splice(idx, 1) }
function addIngressCustom() { form.value.ingressCustomAnnotations.push({ key: '', value: '' }) }
function removeIngressCustom(i) { form.value.ingressCustomAnnotations.splice(i, 1) }
function addNodeSelector() { form.value.nodeSelectors.push({ key: '', value: '' }) }
function removeNodeSelector(idx) { form.value.nodeSelectors.splice(idx, 1) }
function addToleration() { form.value.tolerations.push({ key: '', operator: 'Equal', value: '', effect: 'NoSchedule' }) }
function removeToleration(idx) { form.value.tolerations.splice(idx, 1) }
function addDnsNameserver() { form.value.dnsConfig.nameservers.push('') }
function removeDnsNameserver(i) { form.value.dnsConfig.nameservers.splice(i, 1) }
function addDnsSearch() { form.value.dnsConfig.searches.push('') }
function removeDnsSearch(i) { form.value.dnsConfig.searches.splice(i, 1) }
function addDnsOption() { form.value.dnsConfig.options.push({ name: '', value: '' }) }
function removeDnsOption(i) { form.value.dnsConfig.options.splice(i, 1) }
function addHostAlias() { form.value.hostAliases.push({ ip: '', hostnames: '' }) }
function removeHostAlias(i) { form.value.hostAliases.splice(i, 1) }

function nextStep() { if (currentStep.value < steps.length - 1) currentStep.value++ }
function prevStep() { if (currentStep.value > 0) currentStep.value-- }

// 当前步骤为何不能继续(返回提示文案;null=可继续)。既是「下一步」开关,也驱动按钮旁的内联提示,
// 避免静默禁用让用户不知为何卡住(QA:勾选 Service 后端口没填,下一步无声禁用)。
const stepBlockReason = computed(() => {
  const f = form.value
  if (currentStep.value === 0) {
    // K8s 资源名合规：小写字母/数字/横线，开头结尾须为字母数字
    if (!f.name || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(f.name)) return t('deploy.nameInvalid')
    if (!f.namespace) return t('deploy.namespaceRequired')
  }
  if (currentStep.value === 1) {
    if (!f.image) return t('deploy.imageRequired')
    // 已填写的端口必须是正整数
    if (f.ports.some(p => p.containerPort !== '' && !/^\d+$/.test(String(p.containerPort)))) return t('deploy.portMustBeNumber')
  }
  if (currentStep.value === 4) {
    if (f.createService) {
      if (f.serviceType === 'ExternalName') { if (!f.externalName) return t('deploy.externalNameRequired') }
      else {
        // service port 已填则必须为正整数
        if (!f.servicePorts.some(p => p.port)) return t('deploy.svcPortRequired')
        if (f.servicePorts.some(p => p.port !== '' && !/^\d+$/.test(String(p.port)))) return t('deploy.portMustBeNumber')
        // 同 port+protocol 不能重复(K8s apply 会拒 duplicate entries,这里提前拦;QA ISSUE-003)
        const seen = new Set()
        for (const p of f.servicePorts) {
          if (p.port === '') continue
          const key = `${p.port}/${p.protocol || 'TCP'}`
          if (seen.has(key)) return t('deploy.duplicateServicePort')
          seen.add(key)
        }
      }
    }
    if (f.createIngress && !f.ingressRules.some(r => r.host)) return t('deploy.ingressHostRequired')
  }
  return null
})
const canProceed = computed(() => !stepBlockReason.value)

// Available ConfigMaps/Secrets for envFrom（Vue Query，store.nsXxx 在 remote 下孤立）
const _cmQ = useResourceList({ key: ['cluster', cid, 'configmaps'], fetcher: () => store.fetchConfigMaps(), options: { refetchInterval: 30000 } })
const _secQ = useResourceList({ key: ['cluster', cid, 'secrets'], fetcher: () => store.fetchSecrets(), options: { refetchInterval: 30000 } })
const _pvcQ = useResourceList({ key: ['cluster', cid, 'pvcs'], fetcher: () => store.fetchPVCs(), options: { refetchInterval: 30000 } })
const availableConfigMaps = computed(() => (_cmQ.data.value || []).filter(c => c.namespace === store.currentNamespace).map(c => c.name))
// 卷挂载目标选项：主容器 + 有镜像的 init/sidecar（按原索引）
const containerTargets = computed(() => {
  const targets = [{ value: 'main', label: t('deploy.mainContainer') }]
  form.value.initContainers.forEach((c, i) => { if (c.image) targets.push({ value: `init:${i}`, label: `Init: ${c.name || '#' + i}` }) })
  form.value.extraContainers.forEach((c, i) => { if (c.image) targets.push({ value: `sidecar:${i}`, label: `Sidecar: ${c.name || '#' + i}` }) })
  return targets
})
const availableSecrets = computed(() => (_secQ.data.value || []).filter(s => s.namespace === store.currentNamespace).map(s => s.name))
const availablePVCs = computed(() => (_pvcQ.data.value || []).filter(p => p.namespace === store.currentNamespace).map(p => p.name))
const availablePriorityClasses = computed(() => (priorityClassesQuery.data.value || []).map(p => p.name))
const availableServiceAccounts = computed(() => (serviceAccountsQuery.data.value || []).filter(s => s.namespace === store.currentNamespace).map(s => s.name))

// 部署向导：targetPort 候选 = 本步骤已填的容器端口（去重），引导用户选对后端端口
const containerPortOptions = computed(() => {
  const set = new Set()
  for (const p of form.value.ports) {
    if (p.containerPort !== '' && p.containerPort != null) set.add(p.containerPort)
  }
  return [...set]
})

const tierOptions = TIER_OPTIONS
function tierLabel(o) { return o.parentLabelKey ? `${t(o.parentLabelKey)} / ${t(o.labelKey)}` : t(o.labelKey) }

const resourcePresets = [
  { label: t('deploy.resourcePresetSmall'), cpuReq: '100m', cpuLim: '250m', memReq: '128Mi', memLim: '256Mi' },
  { label: t('deploy.resourcePresetMedium'), cpuReq: '250m', cpuLim: '500m', memReq: '256Mi', memLim: '512Mi' },
  { label: t('deploy.resourcePresetLarge'), cpuReq: '500m', cpuLim: '1000m', memReq: '512Mi', memLim: '1Gi' },
  { label: t('deploy.resourcePresetXLarge'), cpuReq: '1000m', cpuLim: '2000m', memReq: '1Gi', memLim: '2Gi' },
]
function applyPreset(p) {
  form.value.cpuRequest = p.cpuReq
  form.value.cpuLimit = p.cpuLim
  form.value.memoryRequest = p.memReq
  form.value.memoryLimit = p.memLim
}

const quickTemplates = [
  { id: 'nginx', label: 'Nginx', icon: 'public', image: 'nginx:latest', port: 80, cpuReq: '100m', cpuLim: '250m', memReq: '128Mi', memLim: '256Mi', tier: 'presentation' },
  { id: 'redis', label: 'Redis', icon: 'bolt', image: 'redis:7-alpine', port: 6379, cpuReq: '100m', cpuLim: '500m', memReq: '128Mi', memLim: '512Mi', tier: 'middleware' },
  { id: 'postgres', label: 'PostgreSQL', icon: 'database', image: 'postgres:16', port: 5432, cpuReq: '250m', cpuLim: '1000m', memReq: '256Mi', memLim: '1Gi', tier: 'persistence' },
  { id: 'nodejs', label: 'Node.js', icon: 'code', image: 'node:20-alpine', port: 3000, cpuReq: '250m', cpuLim: '500m', memReq: '256Mi', memLim: '512Mi', tier: 'microservice-business' },
  { id: 'python', label: 'Python', icon: 'terminal', image: 'python:3.12-slim', port: 8000, cpuReq: '250m', cpuLim: '500m', memReq: '256Mi', memLim: '512Mi', tier: 'microservice-business' },
]
function applyTemplate(t) {
  form.value.image = t.image
  form.value.containerName = t.id
  form.value.ports = [{ containerPort: String(t.port), protocol: 'TCP' }]
  form.value.cpuRequest = t.cpuReq
  form.value.cpuLimit = t.cpuLim
  form.value.memoryRequest = t.memReq
  form.value.memoryLimit = t.memLim
  form.value.servicePorts = [{ name: 'http', port: String(t.port), targetPort: String(t.port), nodePort: '', protocol: 'TCP' }]
  form.value.tier = t.tier
  if (!form.value.labels.some(l => l.key === 'app')) {
    form.value.labels = [{ key: 'app', value: t.id }]
  }
}

// Generate YAML preview
const previewYAML = computed(() => {
  const f = form.value
  const labels = {}
  f.labels.forEach(l => { if (l.key) labels[l.key] = l.value || f.name })
  labels.app = labels.app || f.name
  labels['aliangboard.io/layer'] = f.tier
  labels['aliangboard.io/managed-by'] = 'aliangboard'
  if (f.metaOwner) labels['aliangboard.io/owner'] = f.metaOwner
  if (f.metaVersion) labels['aliangboard.io/version'] = f.metaVersion
  // annotations（title + description + tags 走 annotation，支持中文/逗号/超长文本；label value 不允许非 ASCII 和逗号）
  const annotations = {}
  f.annotations.forEach(a => { if (a.key) annotations[a.key] = a.value })
  if (f.metaTitle) annotations['aliangboard.io/title'] = f.metaTitle
  if (f.metaDescription) annotations['aliangboard.io/description'] = f.metaDescription
  if (f.metaTags) annotations['aliangboard.io/tags'] = f.metaTags // tags 含逗号，必须走 annotation

  const portsYaml = f.ports
    .filter(p => p.containerPort)
    .map(p => `        - containerPort: ${p.containerPort}
          protocol: ${p.protocol}`)
    .join('\n')

  const envYaml = f.envVars
    .filter(e => e.key)
    .map(e => `        - name: ${e.key}\n          value: "${e.value}"`)
    .join('\n')

  const envCMKeyYaml = f.envCMKeys
    .filter(e => e.name && e.cmName && e.key)
    .map(e => `        - name: ${e.name}\n          valueFrom:\n            configMapKeyRef:\n              name: ${e.cmName}\n              key: ${e.key}`)
    .join('\n')

  const envSecretKeyYaml = f.envSecretKeys
    .filter(e => e.name && e.secretName && e.key)
    .map(e => `        - name: ${e.name}\n          valueFrom:\n            secretKeyRef:\n              name: ${e.secretName}\n              key: ${e.key}`)
    .join('\n')

  const allEnvYaml = [envYaml, envCMKeyYaml, envSecretKeyYaml].filter(Boolean).join('\n')

  const envFromYaml = []
  if (f.envFromConfigMap) envFromYaml.push(`        - configMapRef:\n            name: ${f.envFromConfigMap}`)
  if (f.envFromSecret) envFromYaml.push(`        - secretRef:\n            name: ${f.envFromSecret}`)

  // 健康探针生成
  function probeYaml(name, p) {
    if (!p.enabled) return ''
    let s = `        ${name}:`
    if (p.type === 'http') s += `\n          httpGet:\n            path: ${p.httpPath}\n            port: ${p.port}`
    else if (p.type === 'tcp') s += `\n          tcpSocket:\n            port: ${p.port}`
    else if (p.type === 'exec') s += `\n          exec:\n            command: ["${p.execCommand}"]`
    s += `\n          initialDelaySeconds: ${p.initialDelaySeconds}\n          periodSeconds: ${p.periodSeconds}\n          timeoutSeconds: ${p.timeoutSeconds}\n          failureThreshold: ${p.failureThreshold}\n          successThreshold: ${p.successThreshold}`
    return s
  }
  const probesYaml = [probeYaml('livenessProbe', f.liveness), probeYaml('readinessProbe', f.readiness), probeYaml('startupProbe', f.startup)].filter(Boolean).join('\n')

  // 每挂载点的 volumeMount 块（按 target：main / init:i / sidecar:i）
  function mountLines(target) {
    const ms = f.volumeMounts.filter(v => v.target === target && v.name && v.mountPath)
    if (!ms.length) return ''
    return '        volumeMounts:\n' + ms.map(v => {
      let m = `        - name: ${v.name}\n          mountPath: ${v.mountPath}`
      if (v.subPath) m += `\n          subPath: ${v.subPath}`
      if (v.readOnly) m += `\n          readOnly: true`
      return m
    }).join('\n')
  }

  // 额外工作容器（sidecar）—— 保留原索引，便于按 target 挂卷
  const extraContainersYaml = f.extraContainers.map((c, idx) => !c.image ? null :
    `      - name: ${c.name || c.image.split(':')[0]}\n        image: ${c.image}` +
    (c.command ? `\n        command: [${c.command.split(' ').map(x => `"${x}"`).join(', ')}]` : '') +
    `\n        resources:\n          requests:\n            cpu: ${c.cpuRequest}\n            memory: ${c.memoryRequest}\n          limits:\n            cpu: ${c.cpuLimit}\n            memory: ${c.memoryLimit}` +
    (mountLines(`sidecar:${idx}`) ? '\n' + mountLines(`sidecar:${idx}`) : '')
  ).filter(Boolean).join('\n')

  // 初始容器（init）
  const initContainersYaml = f.initContainers.map((c, idx) => !c.image ? null :
    `      - name: ${c.name || c.image.split(':')[0]}\n        image: ${c.image}` +
    (c.command ? `\n        command: [${c.command.split(' ').map(x => `"${x}"`).join(', ')}]` : '') +
    (c.args ? `\n        args: [${c.args.split(' ').map(x => `"${x}"`).join(', ')}]` : '') +
    `\n        resources:\n          requests:\n            cpu: ${c.cpuRequest}\n            memory: ${c.memoryRequest}\n          limits:\n            cpu: ${c.cpuLimit}\n            memory: ${c.memoryLimit}` +
    (mountLines(`init:${idx}`) ? '\n' + mountLines(`init:${idx}`) : '')
  ).filter(Boolean).join('\n')

  // pod 级 volumes（按 name 去重；configMap/secret 可带 items 键映射）
  const volDefs = new Map()
  f.volumeMounts.filter(v => v.name).forEach(v => { if (!volDefs.has(v.name)) volDefs.set(v.name, v) })
  const volumesYaml = [...volDefs.values()].map(v => {
    if (v.type === 'pvc' && v.pvcName) return `      - name: ${v.name}\n        persistentVolumeClaim:\n          claimName: ${v.pvcName}`
    if (v.type === 'emptyDir') return `      - name: ${v.name}\n        emptyDir: {}`
    if (v.type === 'hostPath' && v.hostPath) return `      - name: ${v.name}\n        hostPath:\n          path: ${v.hostPath}`
    if (v.type === 'nfs' && v.server) return `      - name: ${v.name}\n        nfs:\n          server: ${v.server}\n          path: ${v.nfsPath || '/'}`
    const itemsYaml = (v.items || []).filter(it => it.key).map(it => `          - key: ${it.key}\n            path: ${it.path}`).join('\n')
    if (v.type === 'configMap' && v.cmName) return `      - name: ${v.name}\n        configMap:\n          name: ${v.cmName}` + (itemsYaml ? `\n          items:\n${itemsYaml}` : '')
    if (v.type === 'secret' && v.secretName) return `      - name: ${v.name}\n        secret:\n          secretName: ${v.secretName}` + (itemsYaml ? `\n          items:\n${itemsYaml}` : '')
    return null
  }).filter(Boolean).join('\n')

  // apiVersion / kind / spec 头部按类型区分
  const isBatch = f.workloadType === 'Job'
  const isCron = f.workloadType === 'CronJob'
  const apiVersion = isBatch ? 'batch/v1' : isCron ? 'batch/v1' : 'apps/v1'
  let yaml = `apiVersion: ${apiVersion}
kind: ${f.workloadType}
metadata:
  name: ${f.name}
  namespace: ${f.namespace}
  labels:
${Object.entries(labels).map(([k, v]) => `    ${k}: ${v}`).join('\n')}`
  if (Object.keys(annotations).length) {
    yaml += `
  annotations:
${Object.entries(annotations).map(([k, v]) => `    ${k}: ${v}`).join('\n')}`
  }
  yaml += `
spec:`
  if (isCron) {
    yaml += `
  schedule: "${f.cronConfig.schedule}"
  concurrencyPolicy: ${f.cronConfig.concurrencyPolicy}
  suspend: ${f.cronConfig.suspend}
  successfulJobsHistoryLimit: ${f.cronConfig.successfulJobsHistoryLimit}
  failedJobsHistoryLimit: ${f.cronConfig.failedJobsHistoryLimit}
  jobTemplate:
    spec:
      backoffLimit: ${f.jobConfig.backoffLimit}` +
      (f.jobConfig.activeDeadlineSeconds ? `\n      activeDeadlineSeconds: ${f.jobConfig.activeDeadlineSeconds}` : '') + `
      template:`
  } else if (isBatch) {
    yaml += `
  backoffLimit: ${f.jobConfig.backoffLimit}
  completions: ${f.jobConfig.completions}
  parallelism: ${f.jobConfig.parallelism}` +
    (f.jobConfig.activeDeadlineSeconds ? `\n  activeDeadlineSeconds: ${f.jobConfig.activeDeadlineSeconds}` : '') + `
  template:`
  } else {
    yaml += `
  replicas: ${f.replicas}`
    if (f.workloadType === 'Deployment' || f.workloadType === 'StatefulSet' || f.workloadType === 'DaemonSet') {
      yaml += `
  strategy:
    type: ${f.strategy}`
      if (f.strategy === 'RollingUpdate') {
        yaml += `
    rollingUpdate:
      maxSurge: ${f.maxSurge}
      maxUnavailable: ${f.maxUnavailable}`
      }
      yaml += `
  revisionHistoryLimit: ${f.revisionHistoryLimit}`
    }
    yaml += `
  selector:
    matchLabels:
      app: ${f.name}
  template:`
  }
  yaml += `
    metadata:
      labels:
${Object.entries(labels).map(([k, v]) => `        ${k}: ${v}`).join('\n')}
    spec:`
  if (f.serviceAccountName) yaml += `\n      serviceAccountName: ${f.serviceAccountName}`
  if (f.priorityClassName) yaml += `\n      priorityClassName: ${f.priorityClassName}`
  if (f.imagePullSecrets) yaml += `\n      imagePullSecrets:\n      - name: ${f.imagePullSecrets}`
  if (f.nodeSelectors.filter(n => n.key).length) {
    yaml += `\n      nodeSelector:`
    f.nodeSelectors.filter(n => n.key).forEach(n => { yaml += `\n        ${n.key}: "${n.value}"` })
  }
  if (f.tolerations.filter(t => t.key).length) {
    yaml += `\n      tolerations:`
    f.tolerations.filter(t => t.key).forEach(t => {
      yaml += `\n      - key: "${t.key}"`
      yaml += `\n        operator: ${t.operator}`
      if (t.operator === 'Equal') yaml += `\n        value: "${t.value}"`
      yaml += `\n        effect: ${t.effect}`
    })
  }
  // Pod 安全上下文（pod 级）
  const psc = f.podSecurityContext
  if (psc.runAsUser || psc.runAsGroup || psc.runAsNonRoot || psc.fsGroup || psc.seccompProfile) {
    yaml += `\n      securityContext:`
    if (psc.runAsUser) yaml += `\n        runAsUser: ${psc.runAsUser}`
    if (psc.runAsGroup) yaml += `\n        runAsGroup: ${psc.runAsGroup}`
    if (psc.runAsNonRoot) yaml += `\n        runAsNonRoot: true`
    if (psc.fsGroup) yaml += `\n        fsGroup: ${psc.fsGroup}`
    if (psc.seccompProfile) yaml += `\n        seccompProfile:\n          type: ${psc.seccompProfile}`
  }
  // DNS
  if (f.dnsPolicy) yaml += `\n      dnsPolicy: ${f.dnsPolicy}`
  const dc = f.dnsConfig
  const dnsNs = dc.nameservers.filter(x => x)
  const dnsSr = dc.searches.filter(x => x)
  const dnsOps = dc.options.filter(o => o.name)
  if (dnsNs.length || dnsSr.length || dnsOps.length) {
    yaml += `\n      dnsConfig:`
    if (dnsNs.length) yaml += `\n        nameservers:\n${dnsNs.map(n => `        - ${n}`).join('\n')}`
    if (dnsSr.length) yaml += `\n        searches:\n${dnsSr.map(s => `        - ${s}`).join('\n')}`
    if (dnsOps.length) {
      yaml += `\n        options:`
      dnsOps.forEach(o => { yaml += `\n        - name: ${o.name}`; if (o.value) yaml += `\n          value: "${o.value}"` })
    }
  }
  // 主机别名
  const ha = f.hostAliases.filter(h => h.ip)
  if (ha.length) {
    yaml += `\n      hostAliases:`
    ha.forEach(h => {
      yaml += `\n      - ip: ${h.ip}`
      const hosts = (h.hostnames || '').split(',').map(x => x.trim()).filter(Boolean)
      if (hosts.length) yaml += `\n        hostnames:\n${hosts.map(x => `        - ${x}`).join('\n')}`
    })
  }
  // 主机网络
  if (f.hostNetwork) yaml += `\n      hostNetwork: true`
  if (f.hostPID) yaml += `\n      hostPID: true`
  if (f.hostIPC) yaml += `\n      hostIPC: true`
  // Pod 亲和/反亲和
  const pa = f.podAffinity
  if (pa.enabled && pa.labelKey) {
    const aKey = pa.type === 'anti-affinity' ? 'podAntiAffinity' : 'podAffinity'
    yaml += `\n      affinity:\n        ${aKey}:`
    if (pa.strength === 'required') {
      yaml += `\n          requiredDuringSchedulingIgnoredDuringExecution:\n          - labelSelector:\n              matchLabels:\n                ${pa.labelKey}: "${pa.labelValue}"\n            topologyKey: ${pa.topologyKey || 'kubernetes.io/hostname'}`
    } else {
      yaml += `\n          preferredDuringSchedulingIgnoredDuringExecution:\n          - weight: 100\n            podAffinityTerm:\n              topologyKey: ${pa.topologyKey || 'kubernetes.io/hostname'}\n              labelSelector:\n                matchLabels:\n                  ${pa.labelKey}: "${pa.labelValue}"`
    }
  }
  yaml += `
      containers:
      - name: ${f.containerName || f.name}
        image: ${f.image}
        imagePullPolicy: ${f.pullPolicy}`

  if (f.command) yaml += `\n        command: [${f.command.split(' ').map(c => `"${c}"`).join(', ')}]`
  if (f.args) yaml += `\n        args: [${f.args.split(' ').map(c => `"${c}"`).join(', ')}]`
  if (f.workingDir) yaml += `\n        workingDir: ${f.workingDir}`
  if (f.stdin) yaml += `\n        stdin: true`
  if (f.tty) yaml += `\n        tty: true`
  if (portsYaml) yaml += `\n        ports:\n${portsYaml}`
  if (allEnvYaml) yaml += `\n        env:\n${allEnvYaml}`
  if (envFromYaml.length) yaml += `\n        envFrom:\n${envFromYaml.join('\n')}`
  yaml += `\n        resources:
          requests:
            cpu: ${f.cpuRequest}
            memory: ${f.memoryRequest}
          limits:
            cpu: ${f.cpuLimit}
            memory: ${f.memoryLimit}`
  // securityContext
  if (f.securityContext.enabled) {
    yaml += `\n        securityContext:`
    if (f.securityContext.privileged) yaml += `\n          privileged: true`
    if (f.securityContext.runAsUser) yaml += `\n          runAsUser: ${f.securityContext.runAsUser}`
    if (f.securityContext.runAsGroup) yaml += `\n          runAsGroup: ${f.securityContext.runAsGroup}`
    if (f.securityContext.runAsNonPrivileged) yaml += `\n          runAsNonRoot: true`
    if (f.securityContext.readOnlyRootFilesystem) yaml += `\n          readOnlyRootFilesystem: true`
    if (f.securityContext.addCaps) yaml += `\n          capabilities:\n            add: [${f.securityContext.addCaps.split(',').map(c => `"${c.trim()}"`).join(', ')}]`
    else if (f.securityContext.dropCaps) yaml += `\n          capabilities:\n            drop: [${f.securityContext.dropCaps.split(',').map(c => `"${c.trim()}"`).join(', ')}]`
  }
  // lifecycle
  if (f.lifecycle.postStart || f.lifecycle.preStop) {
    yaml += `\n        lifecycle:`
    if (f.lifecycle.postStart) yaml += `\n          postStart:\n            exec:\n              command: [${f.lifecycle.postStart.split(' ').map(c => `"${c}"`).join(', ')}]`
    if (f.lifecycle.preStop) yaml += `\n          preStop:\n            exec:\n              command: [${f.lifecycle.preStop.split(' ').map(c => `"${c}"`).join(', ')}]`
  }
  if (probesYaml) yaml += '\n' + probesYaml
  if (mountLines('main')) yaml += '\n' + mountLines('main')
  if (extraContainersYaml) yaml += '\n' + extraContainersYaml
  if (initContainersYaml) yaml += `\n      initContainers:\n${initContainersYaml}`
  if (volumesYaml) yaml += `\n      volumes:\n${volumesYaml}`

  // Service
  if (f.createService) {
    const isExternal = f.serviceType === 'ExternalName'
    const validPorts = f.servicePorts.filter(p => p.port)
    if (isExternal ? f.externalName : validPorts.length) {
      yaml += `\n---
apiVersion: v1
kind: Service
metadata:
  name: ${f.name}-svc
  namespace: ${f.namespace}
spec:`
      if (isExternal) {
        yaml += `\n  type: ExternalName\n  externalName: ${f.externalName}`
      } else {
        yaml += `\n  type: ${f.serviceType}\n  selector:\n    app: ${f.name}\n  ports:`
        validPorts.forEach(p => {
          let line = `\n    - port: ${p.port}`
          if (p.name) line += `\n      name: ${p.name}`
          line += `\n      targetPort: ${p.targetPort || p.port}\n      protocol: ${p.protocol}`
          if (f.serviceType === 'NodePort' && p.nodePort) line += `\n      nodePort: ${p.nodePort}`
          yaml += line
        })
      }
    }
  }

  // Ingress
  if (f.createIngress && f.ingressRules.filter(r => r.host).length) {
    const validRules = f.ingressRules.filter(r => r.host)
    yaml += `\n---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${f.name}-ingress
  namespace: ${f.namespace}`
    const ingressAnn = buildIngressAnnotations(f.ingressAdv, f.ingressCustomAnnotations)
    if (Object.keys(ingressAnn).length) {
      yaml += '\n  annotations:'
      for (const [k, v] of Object.entries(ingressAnn)) yaml += `\n    ${k}: ${yamlScalar(v)}`
    }
    yaml += `
spec:`
    if (f.ingressClassName) yaml += `\n  ingressClassName: ${f.ingressClassName}`
    const tlsRules = validRules.filter(r => r.tls)
    if (tlsRules.length) {
      yaml += `\n  tls:`
      tlsRules.forEach(r => {
        yaml += `\n  - hosts:\n    - ${r.host}\n    secretName: ${r.tlsSecret || f.name + '-tls'}`
      })
    }
    yaml += `\n  rules:`
    validRules.forEach(r => {
      yaml += `\n  - host: ${r.host}\n    http:\n      paths:`
      r.paths.filter(p => p.path).forEach(p => {
        yaml += `\n      - path: ${p.path}\n        pathType: ${p.pathType}\n        backend:\n          service:\n            name: ${f.name}-svc\n            port:\n              number: ${f.servicePorts[0]?.port || 80}`
      })
    })
  }

  return yaml
})

// Deploy action
// 提交前校验：返回错误描述数组（空数组=通过）
// 返回 [{ step, msg }]:step 用于部署校验失败时跳到首个出错步骤(QA ISSUE-004:原本只弹 toast,用户不知卡哪步)
function validate() {
  const f = form.value, errs = []
  if (!f.name || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(f.name)) errs.push({ step: 0, msg: t('deploy.nameInvalid') })
  if (!f.namespace) errs.push({ step: 0, msg: t('deploy.namespaceRequired') })
  if (!f.image) errs.push({ step: 1, msg: t('deploy.imageRequired') })
  f.volumeMounts.forEach((v, i) => {
    const w = v.name || '#' + (i + 1)
    if (!v.mountPath && !v.pvcName && !v.hostPath && !v.server && !v.cmName && !v.secretName) return // 整行未动,跳过(YAML 端同样跳过)
    if (!v.mountPath) errs.push({ step: 2, msg: t('deploy.volumeMissingMountPath', { name: w }) })
    if (v.type === 'pvc' && !v.pvcName) errs.push({ step: 2, msg: t('deploy.volumeMissingPvc', { name: w }) })
    if (v.type === 'hostPath' && !v.hostPath) errs.push({ step: 2, msg: t('deploy.volumeMissingHostPath', { name: w }) })
    if (v.type === 'nfs' && !v.server) errs.push({ step: 2, msg: t('deploy.volumeMissingNfs', { name: w }) })
    if (v.type === 'configMap' && !v.cmName) errs.push({ step: 2, msg: t('deploy.volumeMissingConfigMap', { name: w }) })
    if (v.type === 'secret' && !v.secretName) errs.push({ step: 2, msg: t('deploy.volumeMissingSecret', { name: w }) })
  })
  f.initContainers.forEach((c, i) => { if (!isEmptyEnvRow(c, ['name', 'image', 'command', 'args']) && !c.image) errs.push({ step: 1, msg: t('deploy.initContainerMissingImage', { name: c.name || '#' + (i + 1) }) }) })
  f.extraContainers.forEach((c, i) => { if (!isEmptyEnvRow(c, ['name', 'image', 'command', 'args']) && !c.image) errs.push({ step: 1, msg: t('deploy.sidecarMissingImage', { name: c.name || '#' + (i + 1) }) }) })
  f.ports.forEach((p, i) => { if (!isEmptyEnvRow(p, ['containerPort']) && !p.containerPort) errs.push({ step: 1, msg: t('deploy.portMissing', { idx: i + 1 }) }) })
  f.envVars.forEach((e, i) => { if (!isEmptyEnvRow(e, ['key', 'value']) && !e.key) errs.push({ step: 1, msg: t('deploy.envMissingKey', { idx: i + 1 }) }) })
  f.envCMKeys.forEach(e => { if (!isEmptyEnvRow(e, ['name', 'cmName', 'key']) && (!e.name || !e.cmName || !e.key)) errs.push({ step: 1, msg: t('deploy.envCmMissing', { name: e.name || '—' }) }) })
  f.envSecretKeys.forEach(e => { if (!isEmptyEnvRow(e, ['name', 'secretName', 'key']) && (!e.name || !e.secretName || !e.key)) errs.push({ step: 1, msg: t('deploy.envSecretMissing', { name: e.name || '—' }) }) })
  const dupEnvName = firstDuplicateEnvName(f.envVars, f.envCMKeys, f.envSecretKeys)
  if (dupEnvName) errs.push({ step: 1, msg: t('deploy.envDuplicateName', { name: dupEnvName }) })
  return errs
}
async function handleDeploy() {
  const errs = validate()
  if (errs.length) {
    // 跳到首个出错步骤,并只列该步骤的错误(跨步骤消息会让用户混乱);QA ISSUE-004:原本只弹 toast 不跳转
    const firstStep = Math.min(...errs.map(e => e.step))
    currentStep.value = firstStep
    notify('error', t('deploy.fixErrors') + errs.filter(e => e.step === firstStep).map(e => e.msg).join('；'))
    return
  }
  const f = form.value
  deployLoading.value = true
  deployError.value = ''
  const result = await store.applyResourceYaml(previewYAML.value)
  deployLoading.value = false
  if (!result.ok) {
    deployError.value = result.error || 'Deployment failed'
    return
  }
  showDeploySuccess.value = true
  // 部分成功:主工作负载已建,但有附属资源(如 Service)失败 —— 不阻断成功,仅 warning 告知(QA ISSUE-002)
  if (result.partial) notify('warning', t('deploy.partialApplied') + result.warning)
  if (f.metaTags) recordTagUsage(ns.value, f.metaTags) // 记录标签使用
}
</script>

<template>
  <div class="animate-fade-in max-w-4xl mx-auto">
    <div class="mb-md">
      <Breadcrumbs v-if="route.params.namespace" :items="[
        { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
        { label: $t('deploy.title') }
      ]" />
      <h2 class="text-headline-md text-on-surface font-bold" :class="route.params.namespace ? 'mt-sm' : ''">{{ $t('deploy.title') }}</h2>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ $t('deploy.deployTo') }} <span class="text-primary font-medium">{{ route.params.namespace || form.namespace }}</span></p>
    </div>

    <!-- Copy Workload Hint -->
    <div v-if="copyHint && !showDeploySuccess" class="flex items-center gap-sm px-md py-sm bg-primary-container text-on-primary-container rounded-lg text-body-sm mb-md">
      <span class="material-symbols-outlined text-lg">content_copy</span>
      {{ t('deploy.copyHint', { source: copyHint }) }}
    </div>

    <!-- Deploy Success -->
    <div v-if="showDeploySuccess" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md text-center">
      <div class="w-16 h-16 rounded-full bg-primary-container/20 flex items-center justify-center mx-auto mb-md">
        <span class="material-symbols-outlined text-primary text-2xl">check_circle</span>
      </div>
      <h3 class="text-headline-md text-on-surface mb-xs">{{ $t('deploy.deploySuccess') }}</h3>
      <p class="text-body-sm text-on-surface-variant mb-md">{{ $t('deploy.appDeployed', { name: form.name, namespace: form.namespace }) }}</p>
      <div class="flex justify-center gap-sm">
        <button @click="router.push({ name: 'NsWorkloads', params: { namespace: form.namespace } })" class="px-3 py-1.5 bg-primary text-on-primary text-body-sm rounded-lg font-semibold hover:opacity-90">
          {{ $t('deploy.viewWorkloads') }}
        </button>
        <button @click="router.push({ name: 'NsPods', params: { namespace: form.namespace } })" class="px-3 py-1.5 border border-outline-variant text-body-sm rounded-lg hover:bg-surface-container-high">
          {{ $t('deploy.viewPods') }}
        </button>
        <button @click="showDeploySuccess = false; currentStep = 0; resetForm()" class="px-3 py-1.5 border border-outline-variant text-body-sm rounded-lg hover:bg-surface-container-high">
          {{ $t('deploy.deployAnother') }}
        </button>
      </div>
    </div>

    <!-- Step Indicator -->
    <div v-if="!showDeploySuccess" class="flex items-center mb-md">
      <div v-for="(step, idx) in steps" :key="idx" class="flex items-center">
        <div
          class="flex items-center gap-sm cursor-pointer"
          :class="idx <= currentStep ? 'text-primary' : 'text-on-surface-variant'"
          @click="idx < currentStep ? currentStep = idx : null"
        >
          <div
            class="w-8 h-8 rounded-full flex items-center justify-center text-on-primary font-semibold transition-all text-body-sm"
            :class="idx === currentStep ? 'bg-primary' : idx < currentStep ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container text-on-surface-variant'"
          >
            <span v-if="idx < currentStep" class="material-symbols-outlined text-sm">check</span>
            <span v-else>{{ idx + 1 }}</span>
          </div>
          <span class="text-body-sm font-medium hidden md:inline">{{ step.title }}</span>
        </div>
        <div v-if="idx < steps.length - 1" class="w-8 md:w-16 h-0.5 mx-1" :class="idx < currentStep ? 'bg-primary' : 'bg-outline-variant'"></div>
      </div>
    </div>

    <!-- Step Content -->
    <div v-if="!showDeploySuccess" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md">

      <!-- Step 1: Basic Info -->
      <div v-if="currentStep === 0">
        <h3 class="text-headline-sm font-bold mb-md">{{ $t('deploy.basicInfoTitle') }}</h3>
        <!-- 快速开始模板 -->
        <div class="mb-md p-md bg-primary-container/5 border border-primary/20 rounded-lg">
          <p class="text-xs font-medium text-on-surface mb-xs flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-sm">bolt</span>{{ $t('deploy.quickTemplates') }}
          </p>
          <div class="flex flex-wrap gap-sm">
            <button v-for="t in quickTemplates" :key="t.id" @click="applyTemplate(t)" class="flex items-center gap-xs px-sm py-xs bg-surface-container-lowest border border-outline-variant rounded-lg text-xs font-medium hover:border-primary hover:text-primary transition-colors">
              <span class="material-symbols-outlined text-xs">{{ t.icon }}</span>{{ t.label }}
            </button>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-sm">
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.appName') }}</label>
            <input v-model="form.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary focus:border-primary" placeholder="my-application" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.namespaceLabel') }}</label>
            <div v-if="route.params.namespace" class="w-full bg-primary/5 border border-primary/30 rounded-lg px-md py-sm text-body-sm text-primary font-medium">
              <span class="material-symbols-outlined text-xs align-middle mr-1">lock</span>{{ route.params.namespace }}
            </div>
            <select v-else v-model="form.namespace" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-primary focus:border-primary">
              <option v-for="ns in allNamespaces" :key="ns.name" :value="ns.name">{{ ns.name }}</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.workloadType') }}</label>
            <div class="flex flex-wrap gap-sm">
              <button v-for="wt in workloadTypes" :key="wt" @click="form.workloadType = wt"
                class="px-md py-xs rounded-lg border font-medium text-body-sm transition-all"
                :class="form.workloadType === wt ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'"
              >{{ wt }}</button>
            </div>
          </div>
          <div v-if="!['DaemonSet','Job','CronJob'].includes(form.workloadType)">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.replicas') }}</label>
            <input v-model.number="form.replicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
          </div>
          <!-- Job 专属配置 -->
          <div v-if="form.workloadType === 'Job'" class="md:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-sm p-md bg-tertiary-container/5 border border-tertiary-container/20 rounded-lg">
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.completions') }}</label><input v-model.number="form.jobConfig.completions" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.parallelism') }}</label><input v-model.number="form.jobConfig.parallelism" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.backoffLimit') }}</label><input v-model.number="form.jobConfig.backoffLimit" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.activeDeadline') }}</label><input v-model.number="form.jobConfig.activeDeadlineSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" :placeholder="$t('deploy.optionalPlaceholder')" /></div>
          </div>
          <!-- CronJob 专属配置 -->
          <div v-if="form.workloadType === 'CronJob'" class="md:col-span-2 grid grid-cols-2 md:grid-cols-3 gap-sm p-md bg-tertiary-container/5 border border-tertiary-container/20 rounded-lg">
            <div class="md:col-span-2">
              <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.schedule') }}</label>
              <input v-model="form.cronConfig.schedule" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="*/5 * * * *" />
            </div>
            <div>
              <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.concurrencyPolicy') }}</label>
              <select v-model="form.cronConfig.concurrencyPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
                <option>Allow</option><option>Forbid</option><option>Replace</option>
              </select>
            </div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.successHistoryLimit') }}</label><input v-model.number="form.cronConfig.successfulJobsHistoryLimit" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.failedHistoryLimit') }}</label><input v-model.number="form.cronConfig.failedJobsHistoryLimit" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
          </div>
          <!-- 业务元数据（aliangboard.io/* 标签体系：写入后卡片/详情自动展示） -->
          <div class="md:col-span-2 mt-xs p-md rounded-lg border border-outline-variant/60 bg-surface-container-lowest">
            <label class="text-xs text-on-surface-variant block mb-sm">{{ $t('deploy.businessMeta') }} <span class="text-tertiary-container normal-case">{{ $t('deploy.businessMetaHint') }}</span></label>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-sm">
              <div>
                <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.metaTitle') }}</label>
                <input v-model="form.metaTitle" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary focus:border-primary" :placeholder="$t('deploy.metaTitlePlaceholder')" />
              </div>
              <div>
                <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.metaOwner') }}</label>
                <input v-model="form.metaOwner" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary focus:border-primary" placeholder="team-pay" />
              </div>
              <div>
                <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.metaVersion') }}</label>
                <input v-model="form.metaVersion" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary focus:border-primary" placeholder="v2.3.1" />
              </div>
              <div>
                <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.metaTags') }}</label>
                <TagInput v-model="form.metaTags" :namespace="ns" :max="3" />
              </div>
              <div class="md:col-span-2">
                <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.metaDescription') }}</label>
                <textarea v-model="form.metaDescription" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary focus:border-primary h-16 resize-none" :placeholder="$t('deploy.metaDescriptionPlaceholder')"></textarea>
              </div>
            </div>
          </div>
          <div class="md:col-span-2">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.tier') }} <span class="text-tertiary-container normal-case">{{ $t('deploy.tierHint') }}</span></label>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-sm">
              <button v-for="t in tierOptions" :key="t.value" @click="form.tier = t.value"
                class="flex flex-col items-start gap-xs px-sm py-xs rounded-lg border text-left transition-all"
                :class="form.tier === t.value ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">
                <span class="flex items-center gap-xs text-xs font-medium">
                  <span class="material-symbols-outlined text-xs">{{ t.icon }}</span>{{ tierLabel(t) }}
                </span>
                <span class="text-xs opacity-70">{{ $t(t.descKey) }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Labels -->
        <h4 class="text-body-sm font-semibold mt-md mb-xs">{{ $t('deploy.labels') }}</h4>
        <div class="flex flex-col gap-sm">
          <div v-for="(lbl, idx) in form.labels" :key="idx" class="flex gap-sm items-center">
            <input v-model="lbl.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="key" />
            <input v-model="lbl.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="value" />
            <button v-if="form.labels.length > 1" @click="removeLabel(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
          <button @click="addLabel" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addLabel') }}
          </button>
        </div>
      </div>

      <!-- Step 2: Container Config -->
      <div v-if="currentStep === 1">
        <h3 class="text-headline-sm font-bold mb-md">{{ $t('deploy.containerConfigTitle') }}</h3>

        <!-- 主容器档案卡 -->
        <div class="rounded-xl border border-outline-variant/80 bg-surface-container-lowest shadow-sm overflow-hidden">
          <!-- 身份条 -->
          <div class="flex flex-wrap items-end gap-md px-md py-md bg-primary-container/10 border-b border-outline-variant/60">
            <span class="w-10 h-10 rounded-xl bg-primary-container/30 flex items-center justify-center self-center">
              <span class="material-symbols-outlined text-primary">deployed_code</span>
            </span>
            <span class="px-sm py-xs rounded-full bg-primary text-on-primary text-xs font-semibold self-center">{{ $t('deploy.mainContainer') }}</span>
            <div class="w-40 min-w-36">
              <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.containerName') }}</label>
              <input v-model="form.containerName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary" placeholder="main" />
            </div>
            <div class="flex-1 min-w-48">
              <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.imageUrl') }}</label>
              <input v-model="form.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="nginx:latest" />
            </div>
          </div>

          <!-- 带一:左列(镜像获取 + 资源) × 右区(进程执行) -->
          <div class="flex flex-col md:flex-row gap-md p-md items-stretch">
            <div class="md:w-[38%] flex flex-col gap-md">
              <!-- 镜像获取 -->
              <div class="rounded-lg border border-outline-variant/60 p-md">
                <div class="flex items-center gap-sm mb-sm text-primary">
                  <span class="material-symbols-outlined text-base">download</span>
                  <span class="text-body-sm font-semibold">{{ $t('deploy.imagePullGroup') }}</span>
                </div>
                <div class="mb-sm">
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.imagePullSecrets') }}</label>
                  <select v-model="form.imagePullSecrets" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
                    <option value="">None</option>
                    <option v-for="s in availableSecrets" :key="s" :value="s">{{ s }}</option>
                  </select>
                </div>
                <div>
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.pullPolicy') }}</label>
                  <div class="flex rounded-lg overflow-hidden border border-outline-variant">
                    <button v-for="opt in ['IfNotPresent', 'Always', 'Never']" :key="opt" type="button" @click="form.pullPolicy = opt"
                      :class="['flex-1 px-xs py-sm text-xs transition-colors', form.pullPolicy === opt ? 'bg-primary text-on-primary font-semibold' : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container-low']">{{ opt }}</button>
                  </div>
                </div>
              </div>
              <!-- 资源(下沉左列) -->
              <div class="rounded-lg border border-outline-variant/60 p-md">
                <div class="flex flex-wrap items-center gap-sm mb-sm text-primary">
                  <span class="material-symbols-outlined text-base">memory</span>
                  <span class="text-body-sm font-semibold">{{ $t('deploy.resources') }}</span>
                  <span class="ml-auto flex gap-xs">
                    <button v-for="p in resourcePresets" :key="p.label" @click="applyPreset(p)" class="px-sm py-xs text-xs font-medium rounded-full border border-outline-variant text-on-surface-variant hover:border-primary hover:text-primary transition-colors">{{ p.label }} {{ p.cpuLim }}/{{ p.memLim }}</button>
                  </span>
                </div>
                <div class="grid grid-cols-2 gap-sm">
                  <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.cpuRequest') }}</label><input v-model="form.cpuRequest" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
                  <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.cpuLimit') }}</label><input v-model="form.cpuLimit" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
                  <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.memoryRequest') }}</label><input v-model="form.memoryRequest" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
                  <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.memoryLimit') }}</label><input v-model="form.memoryLimit" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
                </div>
              </div>
            </div>

            <!-- 进程执行 -->
            <div class="flex-1 rounded-lg border border-outline-variant/60 p-md flex flex-col min-w-0">
              <div class="flex items-center gap-sm mb-sm text-primary">
                <span class="material-symbols-outlined text-base">terminal</span>
                <span class="text-body-sm font-semibold">{{ $t('deploy.processExecGroup') }}</span>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-sm mb-sm">
                <div>
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.workingDir') }}</label>
                  <input v-model="form.workingDir" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/app" />
                </div>
                <div>
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.command') }}</label>
                  <input v-model="form.command" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/bin/sh -c" />
                </div>
              </div>
              <div class="flex-1 flex flex-col mb-sm">
                <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.args') }}</label>
                <textarea v-model="form.args" rows="2" @input="form.args = form.args.replace(/\n/g, ' ')"
                  class="w-full flex-1 min-h-16 bg-code-surface text-on-code-surface font-mono rounded-lg px-sm py-sm text-body-sm resize-y placeholder:text-on-code-surface/40 focus:ring-2 focus:ring-primary/40"
                  placeholder="--port 8080 --debug"></textarea>
              </div>
              <div class="flex items-center gap-md pt-sm border-t border-outline-variant/60">
                <button type="button" @click="form.stdin = !form.stdin" :class="['w-10 h-6 rounded-full relative transition-colors', form.stdin ? 'bg-primary' : 'bg-surface-container-highest']">
                  <span :class="['absolute top-1 left-1 w-4 h-4 rounded-full shadow transition-all', form.stdin ? 'translate-x-4 bg-on-primary' : 'bg-on-surface-variant']"></span>
                </button>
                <span class="text-xs">stdin</span>
                <button type="button" @click="form.tty = !form.tty" :class="['w-10 h-6 rounded-full relative transition-colors ml-md', form.tty ? 'bg-primary' : 'bg-surface-container-highest']">
                  <span :class="['absolute top-1 left-1 w-4 h-4 rounded-full shadow transition-all', form.tty ? 'translate-x-4 bg-on-primary' : 'bg-on-surface-variant']"></span>
                </button>
                <span class="text-xs">{{ $t('deploy.ttyLabel') }}</span>
              </div>
            </div>
          </div>
        </div>

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

        <!-- Container Ports -->
        <h4 class="text-body-sm font-semibold mt-md mb-xs">{{ $t('deploy.containerPorts') }}</h4>
        <div class="flex flex-col gap-sm mb-md">
          <div v-for="(port, idx) in form.ports" :key="idx" class="flex gap-sm items-center">
            <input v-model="port.containerPort" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="Port (e.g. 8080)" />
            <select v-model="port.protocol" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
              <option>TCP</option><option>UDP</option>
            </select>
            <button @click="removePort(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
          <button @click="addPort" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addPort') }}
          </button>
        </div>

        <!-- Env Vars -->
        <h4 class="text-body-sm font-semibold mt-md mb-xs">{{ $t('deploy.environmentVariables') }}</h4>
        <div class="flex flex-col gap-sm">
          <div v-for="(env, idx) in form.envVars" :key="idx" class="flex gap-sm items-center">
            <input v-model="env.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="KEY" />
            <input v-model="env.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="value" />
            <button @click="removeEnvVar(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
          <button @click="addEnvVar" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addVariable') }}
          </button>
        </div>

        <!-- Env From -->
        <h4 class="text-body-sm font-semibold mt-md mb-xs">{{ $t('deploy.envFrom') }}</h4>
        <div class="grid grid-cols-2 gap-sm mb-md">
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.fromConfigMap') }}</label>
            <EnvSourceField kind="configmap" :namespace="form.namespace" :with-key="false" size="md" v-model:name="form.envFromConfigMap" />
          </div>
          <div>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.fromSecret') }}</label>
            <EnvSourceField kind="secret" :namespace="form.namespace" :with-key="false" size="md" v-model:name="form.envFromSecret" />
          </div>
        </div>
        <p class="text-xs text-on-surface-variant/80 -mt-sm mb-md">{{ $t('deploy.envFromHint') }}</p>

        <!-- 单 Key 引用 -->
        <h4 class="text-body-sm font-semibold mt-md mb-xs">{{ $t('deploy.singleKeyRef') }}</h4>
        <div class="flex flex-col gap-sm mb-md">
          <div v-for="(e, idx) in form.envCMKeys" :key="'cmk'+idx" class="flex gap-sm items-center">
            <input v-model="e.name" class="w-36 flex-shrink-0 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="ENV_NAME" />
            <EnvSourceField kind="configmap" :namespace="form.namespace" size="md" class="flex-1" v-model:name="e.cmName" v-model:dataKey="e.key" />
            <button @click="removeEnvCMKey(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg flex-shrink-0"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
          <div v-for="(e, idx) in form.envSecretKeys" :key="'sk'+idx" class="flex gap-sm items-center">
            <input v-model="e.name" class="w-36 flex-shrink-0 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="ENV_NAME" />
            <EnvSourceField kind="secret" :namespace="form.namespace" size="md" class="flex-1" v-model:name="e.secretName" v-model:dataKey="e.key" />
            <button @click="removeEnvSecretKey(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg flex-shrink-0"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
          <div class="flex gap-sm">
            <button @click="addEnvCMKey" class="flex items-center gap-xs px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.fromConfigMap') }}</button>
            <button @click="addEnvSecretKey" class="flex items-center gap-xs px-md py-xs text-tertiary-container font-medium text-xs hover:bg-tertiary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.fromSecret') }}</button>
          </div>
        </div>

        <!-- 高级设置（默认折叠）-->
        <div class="mt-md border border-outline-variant rounded-xl overflow-hidden">
          <button type="button" @click="showAdvanced = !showAdvanced" class="w-full flex items-center justify-between px-md py-sm bg-surface-container-low hover:bg-surface-container transition-colors">
            <span class="flex items-center gap-sm text-body-sm font-semibold">
              <span class="material-symbols-outlined text-on-surface-variant text-base">{{ showAdvanced ? 'expand_less' : 'expand_more' }}</span>
              {{ $t('deploy.advancedSettings') }}
              <span class="text-xs text-on-surface-variant font-normal opacity-70">{{ $t('deploy.advancedHint') }}</span>
            </span>
            <span class="text-xs text-primary font-medium">{{ showAdvanced ? $t('deploy.collapse') : $t('deploy.expand') }}</span>
          </button>
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
            <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.healthProbes') }}</h4>
            <div v-for="pName in ['liveness', 'readiness', 'startup']" :key="pName" class="border border-outline-variant rounded-lg mb-sm">
              <label class="flex items-center justify-between px-md py-sm cursor-pointer">
                <span class="flex items-center gap-sm text-body-sm font-medium capitalize">
                  <span class="material-symbols-outlined text-primary text-base">{{ pName === 'liveness' ? 'favorite' : pName === 'readiness' ? 'check_circle' : 'rocket_launch' }}</span>
                  {{ pName }} Probe
                </span>
                <input type="checkbox" v-model="form[pName].enabled" class="rounded text-primary h-4 w-4" />
              </label>
              <div v-if="form[pName].enabled" class="px-md pb-sm grid grid-cols-2 md:grid-cols-4 gap-sm">
                <div>
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.probeType') }}</label>
                  <select v-model="form[pName].type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
                    <option value="http">HTTP</option><option value="tcp">TCP</option><option value="exec">Exec</option>
                  </select>
                </div>
                <div v-if="form[pName].type === 'http'">
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.httpPath') }}</label>
                  <input v-model="form[pName].httpPath" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
                </div>
                <div v-if="form[pName].type !== 'exec'">
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.port') }}</label>
                  <input v-model.number="form[pName].port" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
                </div>
                <div v-if="form[pName].type === 'exec'" class="col-span-2">
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.execCommand') }}</label>
                  <input v-model="form[pName].execCommand" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="cat /tmp/ready" />
                </div>
                <div>
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.initialDelay') }}</label>
                  <input v-model.number="form[pName].initialDelaySeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
                </div>
                <div>
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.period') }}</label>
                  <input v-model.number="form[pName].periodSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
                </div>
                <div>
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.timeout') }}</label>
                  <input v-model.number="form[pName].timeoutSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
                </div>
                <div>
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.failureThreshold') }}</label>
                  <input v-model.number="form[pName].failureThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
                </div>
                <div>
                  <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.successThreshold') }}</label>
                  <input v-model.number="form[pName].successThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
                </div>
              </div>
            </div>

            <!-- 安全上下文 -->
            <h4 class="text-body-sm font-semibold mt-md mb-xs">{{ $t('deploy.securityContext') }}</h4>
            <div class="border border-outline-variant rounded-lg mb-md">
              <label class="flex items-center justify-between px-md py-sm cursor-pointer">
                <span class="text-body-sm font-medium">{{ $t('deploy.enableSecurityContext') }}</span>
                <input type="checkbox" v-model="form.securityContext.enabled" class="rounded text-primary h-4 w-4" />
              </label>
              <div v-if="form.securityContext.enabled" class="px-md pb-sm grid grid-cols-2 gap-sm">
                <div class="col-span-2 flex items-center gap-sm px-sm py-sm bg-error-container/10 border border-error/30 rounded-lg">
                  <input type="checkbox" v-model="form.securityContext.privileged" class="rounded text-error h-4 w-4" id="priv" />
                  <label for="priv" class="text-xs font-medium text-error flex items-center gap-xs"><span class="material-symbols-outlined text-sm">warning</span>{{ $t('deploy.privileged') }}</label>
                </div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.runAsUser') }}</label><input v-model.number="form.securityContext.runAsUser" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="1000" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.runAsGroup') }}</label><input v-model.number="form.securityContext.runAsGroup" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="1000" /></div>
                <div class="flex items-center gap-sm pt-sm"><input type="checkbox" v-model="form.securityContext.runAsNonPrivileged" class="rounded text-primary h-4 w-4" id="nonroot" /><label for="nonroot" class="text-xs">{{ $t('deploy.runAsNonRootLabel') }}</label></div>
                <div class="flex items-center gap-sm pt-sm"><input type="checkbox" v-model="form.securityContext.readOnlyRootFilesystem" class="rounded text-primary h-4 w-4" id="rorfs" /><label for="rorfs" class="text-xs">readOnlyRootFilesystem</label></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.addCapabilities') }}</label><input v-model="form.securityContext.addCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="NET_BIND_SERVICE" /></div>
                <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.dropCapabilities') }}</label><input v-model="form.securityContext.dropCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="ALL" /></div>
              </div>
            </div>

            <!-- 生命周期钩子 -->
            <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.lifecycleHooks') }}</h4>
            <div class="grid grid-cols-2 gap-sm">
              <div>
                <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.postStart') }}</label>
                <input v-model="form.lifecycle.postStart" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/bin/sh -c 'echo started'" />
              </div>
              <div>
                <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.preStop') }}</label>
                <input v-model="form.lifecycle.preStop" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/bin/sh -c 'sleep 10'" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Step 3: Volumes -->
      <div v-if="currentStep === 2">
        <h3 class="text-headline-sm font-bold mb-md">{{ $t('deploy.volumesTitle') }}</h3>

        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.volumeMounts') }}</h4>
        <div class="flex flex-col gap-sm mb-md">
          <VolumeMountCard v-for="(vol, idx) in form.volumeMounts" :key="idx" v-model="form.volumeMounts[idx]" :containers="containerTargets" :pvcs="availablePVCs" :available-config-maps="availableConfigMaps" :available-secrets="availableSecrets" :namespace="form.namespace" @remove="removeVolume(idx)" />
          <button @click="addVolume" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addVolume') }}
          </button>
        </div>
      </div>

      <!-- Step 4: 高级设置 -->
      <div v-if="currentStep === 3">
        <h3 class="text-headline-sm font-bold mb-md">{{ $t('deploy.advancedTitle') }}</h3>

        <!-- 更新策略 -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.updateStrategy') }}</h4>
        <div v-if="['Deployment','StatefulSet','DaemonSet'].includes(form.workloadType)" class="flex flex-col gap-sm mb-md">
          <div class="flex gap-sm">
            <button v-for="s in ['RollingUpdate','Recreate']" :key="s" @click="form.strategy = s"
              class="px-md py-xs rounded-lg border font-medium text-body-sm transition-all"
              :class="form.strategy === s ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">{{ s }}</button>
          </div>
          <div v-if="form.strategy === 'RollingUpdate'" class="grid grid-cols-3 gap-sm">
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.maxSurge') }}</label><input v-model="form.maxSurge" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="25%" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.maxUnavailable') }}</label><input v-model="form.maxUnavailable" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="25%" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.revisionHistory') }}</label><input v-model.number="form.revisionHistoryLimit" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
          </div>
        </div>
        <p v-else class="text-xs text-on-surface-variant mb-md">{{ $t('deploy.noRollingForJob') }}</p>

        <!-- 节点调度 -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.nodeSelector') }}</h4>
        <div class="flex flex-col gap-sm mb-md">
          <div v-for="(ns, idx) in form.nodeSelectors" :key="idx" class="flex gap-sm items-center">
            <input v-model="ns.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="label key (e.g. disktype)" />
            <input v-model="ns.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="value (e.g. ssd)" />
            <button @click="removeNodeSelector(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
          <button @click="addNodeSelector" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addNodeSelector') }}
          </button>
        </div>

        <!-- 污点容忍 -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.tolerations') }}</h4>
        <div class="flex flex-col gap-sm mb-md">
          <div v-for="(t, idx) in form.tolerations" :key="idx" class="flex gap-sm items-center flex-wrap">
            <input v-model="t.key" class="flex-1 min-w-[100px] bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="key" />
            <select v-model="t.operator" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
              <option>Equal</option><option>Exists</option>
            </select>
            <input v-if="t.operator === 'Equal'" v-model="t.value" class="flex-1 min-w-[80px] bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="value" />
            <select v-model="t.effect" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
              <option>NoSchedule</option><option>PreferNoSchedule</option><option>NoExecute</option>
            </select>
            <button @click="removeToleration(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
          <button @click="addToleration" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addToleration') }}
          </button>
        </div>

        <!-- 优先级 -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.priorityClass') }}</h4>
        <div>
          <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.priorityClass') }}</label>
          <select v-model="form.priorityClassName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
            <option value="">None</option>
            <option v-for="pc in availablePriorityClasses" :key="pc" :value="pc">{{ pc }}</option>
          </select>
        </div>

        <!-- 服务账号 -->
        <h4 class="text-body-sm font-semibold mt-md mb-xs">{{ $t('deploy.serviceAccountTitle') }}</h4>
        <div class="grid grid-cols-2 gap-sm mb-md">
          <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.serviceAccountTitle') }}</label><select v-model="form.serviceAccountName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"><option value="">Default</option><option v-for="sa in availableServiceAccounts" :key="sa" :value="sa">{{ sa }}</option></select></div>
          <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.imagePullSecret') }}</label><select v-model="form.imagePullSecrets" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"><option value="">None</option><option v-for="s in availableSecrets" :key="s" :value="s">{{ s }}</option></select></div>
        </div>

        <!-- Pod 安全上下文 -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.podSecurityContext') }}</h4>
        <div class="grid grid-cols-3 gap-sm mb-md">
          <div><label class="text-xs text-on-surface-variant block mb-xs">runAsUser</label><input v-model.number="form.podSecurityContext.runAsUser" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="1000" /></div>
          <div><label class="text-xs text-on-surface-variant block mb-xs">runAsGroup</label><input v-model.number="form.podSecurityContext.runAsGroup" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="1000" /></div>
          <div><label class="text-xs text-on-surface-variant block mb-xs">fsGroup</label><input v-model.number="form.podSecurityContext.fsGroup" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="2000" /></div>
          <label class="flex items-center gap-sm cursor-pointer"><input type="checkbox" v-model="form.podSecurityContext.runAsNonRoot" class="h-4 w-4 accent-primary" /><span class="text-xs">runAsNonRoot</span></label>
          <div><label class="text-xs text-on-surface-variant block mb-xs">seccompProfile</label><select v-model="form.podSecurityContext.seccompProfile" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"><option value="">{{ $t('deploy.default') }}</option><option>RuntimeDefault</option><option>Unconfined</option><option>Localhost</option></select></div>
        </div>

        <!-- DNS 配置 -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.dnsConfig') }}</h4>
        <div class="flex flex-col gap-sm mb-md">
          <div><label class="text-xs text-on-surface-variant block mb-xs">dnsPolicy</label><select v-model="form.dnsPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"><option value="">{{ $t('deploy.default') }}</option><option>ClusterFirst</option><option>ClusterFirstWithHostNet</option><option>Default</option><option>None</option></select></div>
          <!-- nameservers -->
          <div><label class="text-xs text-on-surface-variant block mb-xs">Nameservers</label><div v-for="(ns, i) in form.dnsConfig.nameservers" :key="'ns'+i" class="flex gap-sm items-center mb-xs"><input v-model="form.dnsConfig.nameservers[i]" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="8.8.8.8" /><button @click="removeDnsNameserver(i)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button></div><button @click="addDnsNameserver" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addNameserver') }}</button></div>
          <!-- searches -->
          <div><label class="text-xs text-on-surface-variant block mb-xs">Searches</label><div v-for="(s, i) in form.dnsConfig.searches" :key="'sr'+i" class="flex gap-sm items-center mb-xs"><input v-model="form.dnsConfig.searches[i]" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="svc.cluster.local" /><button @click="removeDnsSearch(i)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button></div><button @click="addDnsSearch" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addSearch') }}</button></div>
          <!-- options -->
          <div><label class="text-xs text-on-surface-variant block mb-xs">Options</label><div v-for="(o, i) in form.dnsConfig.options" :key="'op'+i" class="flex gap-sm items-center mb-xs"><input v-model="o.name" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="ndots" /><input v-model="o.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="5" /><button @click="removeDnsOption(i)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button></div><button @click="addDnsOption" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addOption') }}</button></div>
        </div>

        <!-- 主机别名 -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.hostAliases') }}</h4>
        <div class="flex flex-col gap-sm mb-md">
          <div v-for="(h, i) in form.hostAliases" :key="'ha'+i" class="flex gap-sm items-center">
            <input v-model="h.ip" class="w-32 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="IP" />
            <input v-model="h.hostnames" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" :placeholder="$t('deploy.hostnamesPlaceholder')" />
            <button @click="removeHostAlias(i)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
          <button @click="addHostAlias" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addHostAlias') }}</button>
        </div>

        <!-- 主机网络 -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.hostNetworkTitle') }}</h4>
        <div class="flex gap-md mb-md">
          <label class="flex items-center gap-sm cursor-pointer"><input type="checkbox" v-model="form.hostNetwork" class="h-4 w-4 accent-primary" /><span class="text-xs">hostNetwork</span></label>
          <label class="flex items-center gap-sm cursor-pointer"><input type="checkbox" v-model="form.hostPID" class="h-4 w-4 accent-primary" /><span class="text-xs">hostPID</span></label>
          <label class="flex items-center gap-sm cursor-pointer"><input type="checkbox" v-model="form.hostIPC" class="h-4 w-4 accent-primary" /><span class="text-xs">hostIPC</span></label>
        </div>

        <!-- Pod 亲和/反亲和 -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.podAffinityTitle') }}</h4>
        <div class="flex flex-col gap-sm mb-md">
          <label class="flex items-center gap-sm cursor-pointer"><input type="checkbox" v-model="form.podAffinity.enabled" class="h-4 w-4 accent-primary" /><span class="text-xs">{{ $t('deploy.enablePodAffinity') }}</span></label>
          <div v-if="form.podAffinity.enabled" class="grid grid-cols-2 md:grid-cols-3 gap-sm">
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.affinityType') }}</label><select v-model="form.podAffinity.type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"><option value="affinity">{{ $t('deploy.affinity') }}</option><option value="anti-affinity">{{ $t('deploy.antiAffinity') }}</option></select></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.affinityStrength') }}</label><select v-model="form.podAffinity.strength" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"><option value="preferred">{{ $t('deploy.strengthPreferred') }}</option><option value="required">{{ $t('deploy.strengthRequired') }}</option></select></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">topologyKey</label><input v-model="form.podAffinity.topologyKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="kubernetes.io/hostname" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.labelKey') }}</label><input v-model="form.podAffinity.labelKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="app" /></div>
            <div><label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.labelValue') }}</label><input v-model="form.podAffinity.labelValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="myapp" /></div>
          </div>
        </div>
      </div>

      <!-- Step 5: Service & Ingress -->
      <div v-if="currentStep === 4">
        <h3 class="text-headline-sm font-bold mb-md">{{ $t('deploy.serviceIngressTitle') }}</h3>

        <div class="flex items-center gap-sm mb-md">
          <input v-model="form.createService" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" id="createSvc" />
          <label for="createSvc" class="text-body-sm font-medium cursor-pointer">{{ $t('deploy.createService') }}</label>
        </div>

        <div v-if="form.createService" class="mb-md">
          <div class="mb-xs">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.serviceType') }}</label>
            <div class="flex flex-wrap gap-sm">
              <button v-for="st in ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']" :key="st" @click="form.serviceType = st"
                class="px-md py-xs rounded-lg border font-medium text-body-sm transition-all"
                :class="form.serviceType === st ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'"
              >{{ st }}</button>
            </div>
          </div>

          <!-- ExternalName -->
          <div v-if="form.serviceType === 'ExternalName'">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.externalName') }}</label>
            <input v-model="form.externalName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="my-service.example.com" />
            <p class="text-xs text-on-surface-variant mt-xs flex items-center gap-xs"><span class="material-symbols-outlined text-xs">info</span>{{ $t('deploy.externalNameHint') }}</p>
          </div>

          <!-- 多端口t('common.edit')器 -->
          <div v-else>
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.servicePorts') }}</label>
            <div class="flex flex-col gap-sm">
              <div v-for="(sp, idx) in form.servicePorts" :key="idx" class="flex flex-wrap gap-xs items-center p-sm bg-surface-container-low rounded-lg border border-outline-variant">
                <input v-model="sp.name" class="w-20 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" :placeholder="$t('deploy.portNamePlaceholder')" />
                <input v-model="sp.port" class="w-20 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" placeholder="port" />
                <span class="text-on-surface-variant text-xs">→</span>
                <PortSelect v-model="sp.targetPort" :options="containerPortOptions" placeholder="targetPort" :empty-hint="$t('deploy.targetPortHint')" input-class="w-24 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" />
                <select v-model="sp.protocol" class="bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs">
                  <option>TCP</option><option>UDP</option>
                </select>
                <input v-if="form.serviceType === 'NodePort'" v-model="sp.nodePort" class="w-24 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" placeholder="nodePort" />
                <button v-if="form.servicePorts.length > 1" @click="removeServicePort(idx)" class="p-xs text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-sm">delete</span></button>
              </div>
              <button @click="addServicePort" class="self-start flex items-center gap-xs px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
                <span class="material-symbols-outlined text-xs">add</span> {{ $t('deploy.addPort') }}
              </button>
            </div>
            <p v-if="form.serviceType === 'NodePort'" class="text-xs text-tertiary-container mt-sm flex items-center gap-xs">
              <span class="material-symbols-outlined text-xs">info</span>{{ $t('deploy.nodePortHint') }}
            </p>
          </div>
        </div>

        <div class="mt-md">
          <label class="flex items-center gap-sm cursor-pointer">
            <input v-model="form.createIngress" type="checkbox" class="rounded text-primary h-4 w-4" />
            <span class="text-body-sm font-medium">{{ $t('deploy.createIngress') }}</span>
          </label>
          <div v-if="form.createIngress" class="mt-sm">
            <!-- ingressClassName -->
            <div class="mb-xs">
              <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.ingressClass') }}</label>
              <select v-model="form.ingressClassName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
                <option value="">{{ $t('deploy.ingressClassDefaultOption') }}</option>
                <option v-for="c in allIngressClasses" :key="c.name" :value="c.name">{{ c.name }}{{ c.isDefault ? $t('deploy.ingressClassDefault') : '' }}</option>
              </select>
            </div>

            <!-- 多 Rule t('common.edit')器 -->
            <label class="text-xs text-on-surface-variant block mb-xs">{{ $t('deploy.ingressRules') }}</label>
            <div class="flex flex-col gap-sm">
              <div v-for="(rule, rIdx) in form.ingressRules" :key="rIdx" class="border border-outline-variant rounded-lg p-md bg-surface-container-low">
                <div class="flex gap-sm items-center mb-xs">
                  <span class="material-symbols-outlined text-primary text-base">language</span>
                  <input v-model="rule.host" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="app.example.com" />
                  <button v-if="form.ingressRules.length > 1" @click="removeIngressRule(rIdx)" class="p-xs text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button>
                </div>
                <!-- paths -->
                <div class="flex flex-col gap-xs mb-xs">
                  <div v-for="(p, pIdx) in rule.paths" :key="pIdx" class="flex gap-xs items-center">
                    <input v-model="p.path" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" placeholder="/api" />
                    <select v-model="p.pathType" class="bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs">
                      <option>Prefix</option><option>Exact</option><option>ImplementationSpecific</option>
                    </select>
                    <button v-if="rule.paths.length > 1" @click="removeIngressPath(rIdx, pIdx)" class="p-xs text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-sm">close</span></button>
                  </div>
                  <button @click="addIngressPath(rIdx)" class="self-start flex items-center gap-xs px-sm py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded">
                    <span class="material-symbols-outlined text-xs">add</span> {{ $t('deploy.addPath') }}
                  </button>
                </div>
                <!-- TLS -->
                <label class="flex items-center gap-sm cursor-pointer mt-xs">
                  <input type="checkbox" v-model="rule.tls" class="rounded text-primary h-4 w-4" />
                  <span class="text-xs">{{ $t('deploy.tlsLabel') }}</span>
                  <input v-if="rule.tls" v-model="rule.tlsSecret" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" :placeholder="$t('deploy.tlsSecretPlaceholder')" />
                </label>
              </div>
              <button @click="addIngressRule" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-xs hover:bg-primary-container/10 rounded-lg">
                <span class="material-symbols-outlined text-sm">add</span> {{ $t('deploy.addRule') }}
              </button>
            </div>
            <p class="text-xs text-on-surface-variant mt-sm flex items-center gap-xs">
              <span class="material-symbols-outlined text-xs">info</span>{{ $t('deploy.ingressRuleHint', { name: form.name }) }}
            </p>

            <!-- 网关性能调优（nginx 注解，留空=默认）-->
            <details class="mt-sm border border-outline-variant rounded-lg p-md bg-surface-container-low">
              <summary class="cursor-pointer text-xs font-semibold text-on-surface flex items-center gap-sm">
                <span class="material-symbols-outlined text-primary text-base">tune</span> {{ $t('deploy.gatewayPerfTuning') }}
              </summary>
              <p class="text-xs text-on-surface-variant mt-sm mb-xs">{{ $t('deploy.gatewayPerfHint') }}</p>
              <div class="flex flex-col gap-sm">
                <div v-for="g in PERF_GROUPS" :key="g.titleKey" class="border border-outline-variant rounded-lg p-sm bg-surface-container-lowest">
                  <div class="flex items-center gap-sm mb-sm">
                    <span class="material-symbols-outlined text-primary text-base">{{ g.icon }}</span>
                    <h4 class="text-xs font-semibold text-on-surface">{{ $t(g.titleKey) }}</h4>
                  </div>
                  <div class="grid grid-cols-2 gap-xs">
                    <div v-for="fld in g.fields" :key="fld.key">
                      <label class="text-xs text-on-surface-variant block mb-xs">{{ $t(fld.labelKey) }}</label>
                      <textarea v-if="fld.area" v-model="form.ingressAdv[fld.key]" rows="2" class="w-full bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="fld.ph"></textarea>
                      <select v-else-if="fld.options" v-model="form.ingressAdv[fld.key]" class="w-full bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm">
                        <option v-for="o in fld.options" :key="o" :value="o">{{ o || $t('deploy.default') }}</option>
                      </select>
                      <input v-else v-model="form.ingressAdv[fld.key]" class="w-full bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="fld.ph" />
                    </div>
                  </div>
                </div>
                <!-- 自定义注解 -->
                <div class="border border-outline-variant rounded-lg p-sm bg-surface-container-lowest">
                  <div class="flex items-center justify-between mb-sm">
                    <h4 class="text-xs font-semibold text-on-surface">{{ $t('deploy.customAnnotations') }}</h4>
                    <button type="button" @click="addIngressCustom" class="flex items-center gap-xs px-sm py-xs border border-outline-variant rounded text-xs hover:bg-surface-container-low"><span class="material-symbols-outlined text-sm">add</span>{{ $t('deploy.addAnnotation') }}</button>
                  </div>
                  <div v-for="(a, i) in form.ingressCustomAnnotations" :key="i" class="flex items-center gap-xs mb-xs">
                    <AnnotationKeySelect v-model="a.key" class="flex-1" field-class="bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono focus:ring-2 focus:ring-primary" />
                    <input v-model="a.value" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="value" />
                    <button type="button" @click="removeIngressCustom(i)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-base">delete</span></button>
                  </div>
                  <p v-if="!form.ingressCustomAnnotations.length" class="text-xs text-on-surface-variant">{{ $t('deploy.noCustomAnnotations') }}</p>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>

      <!-- Step 6: Review & Deploy -->
      <div v-if="currentStep === 5">
        <h3 class="text-headline-sm font-bold mb-md">{{ $t('deploy.reviewDeployTitle') }}</h3>

        <!-- Summary Cards -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-sm mb-md">
          <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center">
            <span class="material-symbols-outlined text-primary text-base">info</span>
            <p class="text-body-sm font-bold mt-xs">{{ form.name || '—' }}</p>
            <p class="text-xs text-on-surface-variant">{{ form.workloadType }}</p>
          </div>
          <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center">
            <span class="material-symbols-outlined text-secondary text-base">layers</span>
            <p class="text-body-sm font-bold mt-xs">{{ form.replicas }}</p>
            <p class="text-xs text-on-surface-variant">Replicas</p>
          </div>
          <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center">
            <span class="material-symbols-outlined text-tertiary text-base">hub</span>
            <p class="text-body-sm font-bold mt-xs">{{ form.createService ? form.serviceType : '—' }}</p>
            <p class="text-xs text-on-surface-variant">{{ form.createService ? 'Service' : $t('deploy.noService') }}</p>
          </div>
          <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center">
            <span class="material-symbols-outlined text-on-surface-variant text-base">language</span>
            <p class="text-body-sm font-bold mt-xs">{{ form.createIngress ? (form.ingressRules.find(r => r.host)?.host || '—') : '—' }}</p>
            <p class="text-xs text-on-surface-variant">{{ form.createIngress ? 'Ingress' : $t('deploy.noIngress') }}</p>
          </div>
        </div>

        <!-- YAML Preview -->
        <h4 class="text-body-sm font-semibold mb-xs">{{ $t('deploy.yamlPreview') }}</h4>
        <YamlEditor :model-value="previewYAML" :readonly="true" height="400px" />
      </div>

      <!-- Actions -->
      <div class="flex justify-between mt-md pt-md border-t border-outline-variant">
        <button v-if="currentStep > 0" @click="prevStep" class="flex items-center gap-sm px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high">
          <span class="material-symbols-outlined text-sm">arrow_back</span> {{ $t('deploy.back') }}
        </button>
        <div v-else></div>
        <div class="flex gap-sm">
          <button @click="router.push(`/ns/${form.namespace}`)" class="px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high">{{ $t('deploy.cancel') }}</button>
          <button v-if="currentStep < steps.length - 1" @click="nextStep" :disabled="!canProceed"
            class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            {{ $t('deploy.next') }} <span class="material-symbols-outlined text-sm">arrow_forward</span>
          </button>
          <button v-else @click="handleDeploy" :disabled="deployLoading"
            class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 active:scale-95 transition-all disabled:opacity-50">
            <span class="material-symbols-outlined text-sm" :class="deployLoading ? 'animate-spin' : ''">{{ deployLoading ? 'progress_activity' : 'rocket_launch' }}</span>
            {{ deployLoading ? $t('deploy.deploying') : $t('deploy.deploy') }}
          </button>
        </div>
      </div>
      <p v-if="currentStep < steps.length - 1 && stepBlockReason" class="mt-sm flex items-center gap-xs text-xs text-on-surface-variant"><span class="material-symbols-outlined text-sm text-error">error_outline</span>{{ stepBlockReason }}</p>
      <p v-if="deployError" class="mt-sm rounded-lg border border-error/30 bg-error-container/10 px-md py-sm text-xs text-error">{{ deployError }}</p>
    </div>
  </div>
</template>
