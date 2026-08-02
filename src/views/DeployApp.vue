<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import { PERF_GROUPS, buildIngressAnnotations } from '@/composables/useIngressPerf'
import { yamlScalar } from '@/composables/useYaml'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
if (route.params.namespace) store.setNamespace(route.params.namespace)

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
  envVars: [{ key: '', value: '' }],
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
  ports: [{ containerPort: '', protocol: 'TCP' }],
  volumeMounts: [],
  // Service & Ingress
  createService: true,
  serviceType: 'ClusterIP',
  servicePorts: [{ name: 'http', port: '', targetPort: '', nodePort: '', protocol: 'TCP' }],
  externalName: '',
  createIngress: false,
  ingressClassName: 'nginx',
  ingressRules: [{ host: '', paths: [{ path: '/', pathType: 'Prefix' }], tls: false, tlsSecret: '' }],
  ingressAdv: {},
  ingressCustomAnnotations: [],
  // Labels
  labels: [{ key: 'app', value: '' }],
  annotations: [],
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
  // 生命周期钩子
  lifecycle: { postStart: '', preStop: '' },
  }
}
const form = ref(makeForm())

// 整体重置表单（保留当前命名空间）—— 用于「Deploy Another」避免残留脏数据
function resetForm() {
  const ns = form.value.namespace
  form.value = { ...makeForm(), namespace: ns }
}

const steps = [
  { title: 'Basic Information', icon: 'info' },
  { title: 'Container Config', icon: 'layers' },
  { title: 'Volumes', icon: 'storage' },
  { title: 'Scheduling & Update', icon: 'tune' },
  { title: 'Service & Ingress', icon: 'hub' },
  { title: 'Review & Deploy', icon: 'rocket_launch' },
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
function addVolume() { form.value.volumeMounts.push({ name: '', type: 'pvc', mountPath: '', subPath: '', pvcName: '', hostPath: '', cmName: '', secretName: '' }) }
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

function nextStep() { if (currentStep.value < steps.length - 1) currentStep.value++ }
function prevStep() { if (currentStep.value > 0) currentStep.value-- }

const canProceed = computed(() => {
  const f = form.value
  if (currentStep.value === 0) {
    // K8s 资源名合规：小写字母/数字/横线，开头结尾须为字母数字
    if (!f.name || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(f.name)) return false
    if (!f.namespace) return false
  }
  if (currentStep.value === 1) {
    if (!f.image) return false
    // 已填写的端口必须是正整数
    if (f.ports.some(p => p.containerPort !== '' && !/^\d+$/.test(String(p.containerPort)))) return false
  }
  if (currentStep.value === 4) {
    if (f.createService) {
      if (f.serviceType === 'ExternalName') { if (!f.externalName) return false }
      else {
        // service port 已填则必须为正整数
        if (!f.servicePorts.some(p => p.port)) return false
        if (f.servicePorts.some(p => p.port !== '' && !/^\d+$/.test(String(p.port)))) return false
      }
    }
    if (f.createIngress && !f.ingressRules.some(r => r.host)) return false
  }
  return true
})

// Available ConfigMaps/Secrets for envFrom
const availableConfigMaps = computed(() => store.nsConfigMaps.map(c => c.name))
const availableSecrets = computed(() => store.nsSecrets.map(s => s.name))
const availablePVCs = computed(() => store.nsPVCs.map(p => p.name))
const availablePriorityClasses = computed(() => store.priorityClassList.map(p => p.name))
const availableServiceAccounts = computed(() => store.nsServiceAccounts.map(s => s.name))

const tierOptions = [
  { value: 'web', label: '表现层 Web', icon: 'web', desc: '前端应用、用户界面' },
  { value: 'gateway', label: '网关层 Gateway', icon: 'dns', desc: 'API 网关、流量入口' },
  { value: 'svc', label: '服务层 Service', icon: 'apps', desc: '业务逻辑服务' },
  { value: 'cloud', label: '中间件 Middleware', icon: 'cloud', desc: '消息队列、缓存等中间件' },
  { value: 'db', label: '持久层 Database', icon: 'database', desc: '数据库、有状态存储' },
  { value: 'monitor', label: '监控层 Monitor', icon: 'monitoring', desc: '监控、日志、可观测性' },
  { value: 'default', label: '默认层 Default', icon: 'workspaces', desc: '未分类或系统组件' },
]

const resourcePresets = [
  { label: '小', cpuReq: '100m', cpuLim: '250m', memReq: '128Mi', memLim: '256Mi' },
  { label: '中', cpuReq: '250m', cpuLim: '500m', memReq: '256Mi', memLim: '512Mi' },
  { label: '大', cpuReq: '500m', cpuLim: '1000m', memReq: '512Mi', memLim: '1Gi' },
  { label: '超大', cpuReq: '1000m', cpuLim: '2000m', memReq: '1Gi', memLim: '2Gi' },
]
function applyPreset(p) {
  form.value.cpuRequest = p.cpuReq
  form.value.cpuLimit = p.cpuLim
  form.value.memoryRequest = p.memReq
  form.value.memoryLimit = p.memLim
}

const quickTemplates = [
  { id: 'nginx', label: 'Nginx', icon: 'public', image: 'nginx:latest', port: 80, cpuReq: '100m', cpuLim: '250m', memReq: '128Mi', memLim: '256Mi', tier: 'web' },
  { id: 'redis', label: 'Redis', icon: 'bolt', image: 'redis:7-alpine', port: 6379, cpuReq: '100m', cpuLim: '500m', memReq: '128Mi', memLim: '512Mi', tier: 'db' },
  { id: 'postgres', label: 'PostgreSQL', icon: 'database', image: 'postgres:16', port: 5432, cpuReq: '250m', cpuLim: '1000m', memReq: '256Mi', memLim: '1Gi', tier: 'db' },
  { id: 'nodejs', label: 'Node.js', icon: 'code', image: 'node:20-alpine', port: 3000, cpuReq: '250m', cpuLim: '500m', memReq: '256Mi', memLim: '512Mi', tier: 'svc' },
  { id: 'python', label: 'Python', icon: 'terminal', image: 'python:3.12-slim', port: 8000, cpuReq: '250m', cpuLim: '500m', memReq: '256Mi', memLim: '512Mi', tier: 'svc' },
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
  labels.tier = f.tier

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

  // 额外工作容器（sidecar）
  const extraContainersYaml = f.extraContainers.filter(c => c.image).map(c =>
    `      - name: ${c.name || c.image.split(':')[0]}\n        image: ${c.image}` +
    (c.command ? `\n        command: [${c.command.split(' ').map(x => `"${x}"`).join(', ')}]` : '') +
    `\n        resources:\n          requests:\n            cpu: ${c.cpuRequest}\n            memory: ${c.memoryRequest}\n          limits:\n            cpu: ${c.cpuLimit}\n            memory: ${c.memoryLimit}`
  ).join('\n')

  // 初始容器（init）
  const initContainersYaml = f.initContainers.filter(c => c.image).map(c =>
    `      - name: ${c.name || c.image.split(':')[0]}\n        image: ${c.image}` +
    (c.command ? `\n        command: [${c.command.split(' ').map(x => `"${x}"`).join(', ')}]` : '') +
    (c.args ? `\n        args: [${c.args.split(' ').map(x => `"${x}"`).join(', ')}]` : '') +
    `\n        resources:\n          requests:\n            cpu: ${c.cpuRequest}\n            memory: ${c.memoryRequest}\n          limits:\n            cpu: ${c.cpuLimit}\n            memory: ${c.memoryLimit}`
  ).join('\n')

  const volumeMountsYaml = f.volumeMounts
    .filter(v => v.name && v.mountPath)
    .map(v => {
      let m = `        - name: ${v.name}\n          mountPath: ${v.mountPath}`
      if (v.subPath) m += `\n          subPath: ${v.subPath}`
      return m
    })
    .join('\n')

  const volumesYaml = f.volumeMounts
    .filter(v => v.name)
    .map(v => {
      if (v.type === 'pvc' && v.pvcName) return `      - name: ${v.name}\n        persistentVolumeClaim:\n          claimName: ${v.pvcName}`
      if (v.type === 'emptyDir') return `      - name: ${v.name}\n        emptyDir: {}`
      if (v.type === 'hostPath' && v.hostPath) return `      - name: ${v.name}\n        hostPath:\n          path: ${v.hostPath}`
      if (v.type === 'configMap' && v.cmName) return `      - name: ${v.name}\n        configMap:\n          name: ${v.cmName}`
      if (v.type === 'secret' && v.secretName) return `      - name: ${v.name}\n        secret:\n          secretName: ${v.secretName}`
      return null
    })
    .filter(Boolean)
    .join('\n')

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
${Object.entries(labels).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
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
  if (volumeMountsYaml) yaml += `\n        volumeMounts:\n${volumeMountsYaml}`
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
async function handleDeploy() {
  const f = form.value
  deployLoading.value = true
  deployError.value = ''
  if (store.remoteMode) {
    const result = await store.applyResourceYaml(previewYAML.value)
    deployLoading.value = false
    if (!result.ok) {
      deployError.value = result.error || '部署失败'
      return
    }
    showDeploySuccess.value = true
    return
  }
  // Add workload to mock data
  store.addWorkload({
    name: f.name,
    type: f.workloadType,
    namespace: f.namespace,
    status: 'Running',
    replicas: f.replicas + '/' + f.replicas,
    image: f.image,
    sha: 'sha:' + Math.random().toString(16).slice(2, 8),
    labels: { app: f.name, tier: f.tier },
    tier: f.tier,
    strategy: f.strategy,
    nodeSelectors: f.nodeSelectors.filter(n => n.key),
    priorityClassName: f.priorityClassName,
    serviceAccountName: f.serviceAccountName,
  })

  // Add service if requested
  if (f.createService) {
    const isExt = f.serviceType === 'ExternalName'
    const validPorts = f.servicePorts.filter(p => p.port)
    if (isExt ? f.externalName : validPorts.length) {
      const portsStr = isExt ? '-' : validPorts.map(p => `${p.port}:${p.targetPort || p.port}/${p.protocol}` + (f.serviceType === 'NodePort' && p.nodePort ? `:${p.nodePort}` : '')).join(', ')
      store.addService({
        name: f.name + '-svc',
        namespace: f.namespace,
        type: f.serviceType,
        clusterIP: isExt ? '-' : '10.96.' + Math.floor(Math.random() * 255) + '.' + Math.floor(Math.random() * 255),
        externalIP: '-',
        ports: portsStr,
        externalName: isExt ? f.externalName : '',
        selector: isExt ? {} : { app: f.name },
      })
    }
  }

  // Add ingress if requested
  if (f.createIngress && f.ingressRules.filter(r => r.host).length) {
    const validRules = f.ingressRules.filter(r => r.host)
    const firstRule = validRules[0]
    store.addIngress({
      name: f.name + '-ingress',
      namespace: f.namespace,
      hosts: validRules.map(r => r.host).join(','),
      path: firstRule.paths[0]?.path || '/',
      backend: f.name + '-svc:' + (f.servicePorts[0]?.port || 80),
      tls: validRules.some(r => r.tls),
      tlsSecret: validRules.find(r => r.tls)?.tlsSecret || (f.name + '-tls'),
      className: f.ingressClassName,
      annotations: buildIngressAnnotations(f.ingressAdv, f.ingressCustomAnnotations),
      rules: validRules.map(r => ({
        host: r.host,
        http: { paths: r.paths.filter(p => p.path).map(p => ({ path: p.path, pathType: p.pathType, backend: { serviceName: f.name + '-svc', servicePort: parseInt(f.servicePorts[0]?.port) || 80 } })) }
      })),
    })
  }

  showDeploySuccess.value = true
  deployLoading.value = false
}
</script>

<template>
  <div class="animate-fade-in max-w-4xl mx-auto">
    <div class="mb-xl">
      <Breadcrumbs v-if="route.params.namespace" :items="[
        { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
        { label: 'Deploy New App' }
      ]" />
      <h2 class="text-display-lg text-on-surface" :class="route.params.namespace ? 'mt-sm' : ''">Deploy New App</h2>
      <p class="text-on-surface-variant text-body-md mt-1">Deploy to namespace <span class="text-primary font-medium">{{ route.params.namespace || form.namespace }}</span></p>
    </div>

    <!-- Deploy Success -->
    <div v-if="showDeploySuccess" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-xl shadow-card text-center">
      <div class="w-20 h-20 rounded-full bg-primary-container/20 flex items-center justify-center mx-auto mb-lg">
        <span class="material-symbols-outlined text-primary text-4xl">check_circle</span>
      </div>
      <h3 class="text-headline-lg text-on-surface mb-sm">Deployment Successful!</h3>
      <p class="text-body-md text-on-surface-variant mb-lg">Application <span class="text-primary font-semibold">{{ form.name }}</span> has been deployed to namespace <span class="font-semibold">{{ form.namespace }}</span></p>
      <div class="flex justify-center gap-sm">
        <button @click="router.push({ name: 'NsWorkloads', params: { namespace: form.namespace } })" class="px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
          View Workloads
        </button>
        <button @click="router.push({ name: 'NsPods', params: { namespace: form.namespace } })" class="px-lg py-sm border border-outline-variant rounded-lg hover:bg-surface-container-high">
          View Pods
        </button>
        <button @click="showDeploySuccess = false; currentStep = 0; resetForm()" class="px-lg py-sm border border-outline-variant rounded-lg hover:bg-surface-container-high">
          Deploy Another
        </button>
      </div>
    </div>

    <!-- Step Indicator -->
    <div v-if="!showDeploySuccess" class="flex items-center mb-xl">
      <div v-for="(step, idx) in steps" :key="idx" class="flex items-center">
        <div
          class="flex items-center gap-sm cursor-pointer"
          :class="idx <= currentStep ? 'text-primary' : 'text-on-surface-variant'"
          @click="idx < currentStep ? currentStep = idx : null"
        >
          <div
            class="w-10 h-10 rounded-full flex items-center justify-center text-on-primary font-semibold transition-all"
            :class="idx === currentStep ? 'bg-primary' : idx < currentStep ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container text-on-surface-variant'"
          >
            <span v-if="idx < currentStep" class="material-symbols-outlined">check</span>
            <span v-else>{{ idx + 1 }}</span>
          </div>
          <span class="text-body-md font-medium hidden md:inline">{{ step.title }}</span>
        </div>
        <div v-if="idx < steps.length - 1" class="w-8 md:w-16 h-0.5 mx-1" :class="idx < currentStep ? 'bg-primary' : 'bg-outline-variant'"></div>
      </div>
    </div>

    <!-- Step Content -->
    <div v-if="!showDeploySuccess" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-xl shadow-card">

      <!-- Step 1: Basic Info -->
      <div v-if="currentStep === 0">
        <h3 class="text-headline-md mb-lg">Basic Information</h3>
        <!-- 快速开始模板 -->
        <div class="mb-lg p-md bg-primary-container/5 border border-primary/20 rounded-lg">
          <p class="text-body-sm font-medium text-on-surface mb-sm flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-base">bolt</span>快速开始模板（一键填充镜像/端口/资源）
          </p>
          <div class="flex flex-wrap gap-sm">
            <button v-for="t in quickTemplates" :key="t.id" @click="applyTemplate(t)" class="flex items-center gap-xs px-md py-xs bg-surface-container-lowest border border-outline-variant rounded-lg text-body-sm font-medium hover:border-primary hover:text-primary transition-colors">
              <span class="material-symbols-outlined text-sm">{{ t.icon }}</span>{{ t.label }}
            </button>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-lg">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">App Name *</label>
            <input v-model="form.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary" placeholder="my-application" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Namespace *</label>
            <div v-if="route.params.namespace" class="w-full bg-primary/5 border border-primary/30 rounded-lg px-md py-sm text-body-md text-primary font-medium">
              <span class="material-symbols-outlined text-sm align-middle mr-1">lock</span>{{ route.params.namespace }}
            </div>
            <select v-else v-model="form.namespace" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary">
              <option v-for="ns in store.namespaceList" :key="ns.name" :value="ns.name">{{ ns.name }}</option>
            </select>
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Workload Type</label>
            <div class="flex flex-wrap gap-sm">
              <button v-for="wt in workloadTypes" :key="wt" @click="form.workloadType = wt"
                class="px-lg py-sm rounded-lg border font-medium text-body-md transition-all"
                :class="form.workloadType === wt ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'"
              >{{ wt }}</button>
            </div>
          </div>
          <div v-if="!['DaemonSet','Job','CronJob'].includes(form.workloadType)">
            <label class="text-label-caps text-on-surface-variant block mb-xs">Replicas</label>
            <input v-model.number="form.replicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
          </div>
          <!-- Job 专属配置 -->
          <div v-if="form.workloadType === 'Job'" class="md:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-md p-md bg-tertiary-container/5 border border-tertiary-container/20 rounded-lg">
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Completions</label><input v-model.number="form.jobConfig.completions" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Parallelism</label><input v-model.number="form.jobConfig.parallelism" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Backoff Limit</label><input v-model.number="form.jobConfig.backoffLimit" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Active Deadline (s)</label><input v-model.number="form.jobConfig.activeDeadlineSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="可选" /></div>
          </div>
          <!-- CronJob 专属配置 -->
          <div v-if="form.workloadType === 'CronJob'" class="md:col-span-2 grid grid-cols-2 md:grid-cols-3 gap-md p-md bg-tertiary-container/5 border border-tertiary-container/20 rounded-lg">
            <div class="md:col-span-2">
              <label class="text-label-caps text-on-surface-variant block mb-xs">Schedule (Cron 表达式)</label>
              <input v-model="form.cronConfig.schedule" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="*/5 * * * *" />
            </div>
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Concurrency Policy</label>
              <select v-model="form.cronConfig.concurrencyPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
                <option>Allow</option><option>Forbid</option><option>Replace</option>
              </select>
            </div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">成功历史保留</label><input v-model.number="form.cronConfig.successfulJobsHistoryLimit" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">失败历史保留</label><input v-model.number="form.cronConfig.failedJobsHistoryLimit" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
          </div>
          <div class="md:col-span-2">
            <label class="text-label-caps text-on-surface-variant block mb-xs">Description</label>
            <textarea v-model="form.description" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary h-20 resize-none" placeholder="Optional description..."></textarea>
          </div>
          <div class="md:col-span-2">
            <label class="text-label-caps text-on-surface-variant block mb-xs">服务分层 (Tier) <span class="text-tertiary-container normal-case">决定在分层拓扑中的归属</span></label>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-sm">
              <button v-for="t in tierOptions" :key="t.value" @click="form.tier = t.value"
                class="flex flex-col items-start gap-xs px-md py-sm rounded-lg border text-left transition-all"
                :class="form.tier === t.value ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">
                <span class="flex items-center gap-xs text-body-sm font-medium">
                  <span class="material-symbols-outlined text-sm">{{ t.icon }}</span>{{ t.label }}
                </span>
                <span class="text-body-xs opacity-70">{{ t.desc }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Labels -->
        <h4 class="text-headline-sm mt-xl mb-md">Labels</h4>
        <div class="flex flex-col gap-sm">
          <div v-for="(lbl, idx) in form.labels" :key="idx" class="flex gap-sm items-center">
            <input v-model="lbl.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="key" />
            <input v-model="lbl.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="value" />
            <button v-if="form.labels.length > 1" @click="removeLabel(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined">delete</span></button>
          </div>
          <button @click="addLabel" class="self-start flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Label
          </button>
        </div>
      </div>

      <!-- Step 2: Container Config -->
      <div v-if="currentStep === 1">
        <h3 class="text-headline-md mb-lg">Container Configuration</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-lg">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Container Name</label>
            <input v-model="form.containerName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="main" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Image URL *</label>
            <input v-model="form.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="nginx:latest" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Pull Policy</label>
            <select v-model="form.pullPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option>IfNotPresent</option><option>Always</option><option>Never</option>
            </select>
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Command (optional)</label>
            <input v-model="form.command" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="/bin/sh -c" />
          </div>
          <div class="md:col-span-2">
            <label class="text-label-caps text-on-surface-variant block mb-xs">Args (optional)</label>
            <input v-model="form.args" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="--port 8080 --debug" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Working Dir</label>
            <input v-model="form.workingDir" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="/app" />
          </div>
          <div class="flex items-center gap-lg pt-xl">
            <label class="flex items-center gap-sm cursor-pointer"><input type="checkbox" v-model="form.stdin" class="rounded text-primary h-4 w-4" /><span class="text-body-sm">stdin</span></label>
            <label class="flex items-center gap-sm cursor-pointer"><input type="checkbox" v-model="form.tty" class="rounded text-primary h-4 w-4" /><span class="text-body-sm">tty（分配 TTY）</span></label>
          </div>
          <div class="md:col-span-2">
            <label class="text-label-caps text-on-surface-variant block mb-xs">Image Pull Secrets</label>
            <select v-model="form.imagePullSecrets" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="">None</option>
              <option v-for="s in availableSecrets" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">ServiceAccount（运行身份）</label>
            <select v-model="form.serviceAccountName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="">Default</option>
              <option v-for="sa in availableServiceAccounts" :key="sa" :value="sa">{{ sa }}</option>
            </select>
          </div>
        </div>

        <!-- Container Ports -->
        <h4 class="text-headline-sm mt-xl mb-md">Container Ports</h4>
        <div class="flex flex-col gap-sm mb-xl">
          <div v-for="(port, idx) in form.ports" :key="idx" class="flex gap-sm items-center">
            <input v-model="port.containerPort" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="Port (e.g. 8080)" />
            <select v-model="port.protocol" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option>TCP</option><option>UDP</option>
            </select>
            <button @click="removePort(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined">delete</span></button>
          </div>
          <button @click="addPort" class="self-start flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Port
          </button>
        </div>

        <!-- Resources -->
        <div class="flex items-center justify-between mt-xl mb-md flex-wrap gap-sm">
          <h4 class="text-headline-sm">Resources</h4>
          <div class="flex gap-xs">
            <button v-for="p in resourcePresets" :key="p.label" @click="applyPreset(p)" class="px-sm py-xs text-body-xs font-medium rounded border border-outline-variant text-on-surface-variant hover:border-primary hover:text-primary transition-colors">{{ p.label }} {{ p.cpuLim }}/{{ p.memLim }}</button>
          </div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-md">
          <div><label class="text-label-caps text-on-surface-variant block mb-xs">CPU Request</label><input v-model="form.cpuRequest" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
          <div><label class="text-label-caps text-on-surface-variant block mb-xs">CPU Limit</label><input v-model="form.cpuLimit" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
          <div><label class="text-label-caps text-on-surface-variant block mb-xs">Memory Request</label><input v-model="form.memoryRequest" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
          <div><label class="text-label-caps text-on-surface-variant block mb-xs">Memory Limit</label><input v-model="form.memoryLimit" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
        </div>

        <!-- Env Vars -->
        <h4 class="text-headline-sm mt-xl mb-md">Environment Variables</h4>
        <div class="flex flex-col gap-sm">
          <div v-for="(env, idx) in form.envVars" :key="idx" class="flex gap-sm items-center">
            <input v-model="env.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="KEY" />
            <input v-model="env.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="value" />
            <button @click="removeEnvVar(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined">delete</span></button>
          </div>
          <button @click="addEnvVar" class="self-start flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Variable
          </button>
        </div>

        <!-- Env From -->
        <h4 class="text-headline-sm mt-xl mb-md">Env From</h4>
        <div class="grid grid-cols-2 gap-md mb-xl">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">From ConfigMap</label>
            <select v-model="form.envFromConfigMap" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="">None</option>
              <option v-for="cm in availableConfigMaps" :key="cm" :value="cm">{{ cm }}</option>
            </select>
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">From Secret</label>
            <select v-model="form.envFromSecret" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="">None</option>
              <option v-for="s in availableSecrets" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
        </div>

        <!-- 单 Key 引用 -->
        <h4 class="text-headline-sm mt-xl mb-md">单 Key 引用 (ConfigMap / Secret)</h4>
        <div class="flex flex-col gap-sm mb-xl">
          <div v-for="(e, idx) in form.envCMKeys" :key="'cmk'+idx" class="flex gap-sm items-center">
            <input v-model="e.name" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="ENV_NAME" />
            <select v-model="e.cmName" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="">ConfigMap</option>
              <option v-for="cm in availableConfigMaps" :key="cm" :value="cm">{{ cm }}</option>
            </select>
            <input v-model="e.key" class="w-28 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="key" />
            <button @click="removeEnvCMKey(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined">delete</span></button>
          </div>
          <div v-for="(e, idx) in form.envSecretKeys" :key="'sk'+idx" class="flex gap-sm items-center">
            <input v-model="e.name" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="ENV_NAME" />
            <select v-model="e.secretName" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="">Secret</option>
              <option v-for="s in availableSecrets" :key="s" :value="s">{{ s }}</option>
            </select>
            <input v-model="e.key" class="w-28 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="key" />
            <button @click="removeEnvSecretKey(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined">delete</span></button>
          </div>
          <div class="flex gap-sm">
            <button @click="addEnvCMKey" class="flex items-center gap-xs px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined">add</span> From ConfigMap</button>
            <button @click="addEnvSecretKey" class="flex items-center gap-xs px-md py-sm text-tertiary-container font-medium text-body-sm hover:bg-tertiary-container/10 rounded-lg"><span class="material-symbols-outlined">add</span> From Secret</button>
          </div>
        </div>

        <!-- 高级设置（默认折叠）-->
        <div class="mt-xl border border-outline-variant rounded-xl overflow-hidden">
          <button type="button" @click="showAdvanced = !showAdvanced" class="w-full flex items-center justify-between px-lg py-md bg-surface-container-low hover:bg-surface-container transition-colors">
            <span class="flex items-center gap-sm text-body-md font-semibold">
              <span class="material-symbols-outlined text-on-surface-variant">{{ showAdvanced ? 'expand_less' : 'expand_more' }}</span>
              高级设置
              <span class="text-body-xs text-on-surface-variant font-normal opacity-70">探针 · 多容器 · 安全上下文 · 生命周期</span>
            </span>
            <span class="text-body-xs text-primary font-medium">{{ showAdvanced ? '收起' : '展开' }}</span>
          </button>
          <div v-show="showAdvanced" class="p-lg border-t border-outline-variant">
        <!-- 健康探针 -->
        <h4 class="text-headline-sm mb-md">健康探针 (Health Probes)</h4>
        <div v-for="pName in ['liveness', 'readiness', 'startup']" :key="pName" class="border border-outline-variant rounded-lg mb-sm">
          <label class="flex items-center justify-between px-md py-sm cursor-pointer">
            <span class="flex items-center gap-sm text-body-md font-medium capitalize">
              <span class="material-symbols-outlined text-primary text-lg">{{ pName === 'liveness' ? 'favorite' : pName === 'readiness' ? 'check_circle' : 'rocket_launch' }}</span>
              {{ pName }} Probe
            </span>
            <input type="checkbox" v-model="form[pName].enabled" class="rounded text-primary h-4 w-4" />
          </label>
          <div v-if="form[pName].enabled" class="px-md pb-md grid grid-cols-2 md:grid-cols-4 gap-md">
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">类型</label>
              <select v-model="form[pName].type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
                <option value="http">HTTP</option><option value="tcp">TCP</option><option value="exec">Exec</option>
              </select>
            </div>
            <div v-if="form[pName].type === 'http'">
              <label class="text-label-caps text-on-surface-variant block mb-xs">HTTP Path</label>
              <input v-model="form[pName].httpPath" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" />
            </div>
            <div v-if="form[pName].type !== 'exec'">
              <label class="text-label-caps text-on-surface-variant block mb-xs">Port</label>
              <input v-model.number="form[pName].port" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
            </div>
            <div v-if="form[pName].type === 'exec'" class="col-span-2">
              <label class="text-label-caps text-on-surface-variant block mb-xs">Exec Command</label>
              <input v-model="form[pName].execCommand" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="cat /tmp/ready" />
            </div>
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Initial Delay (s)</label>
              <input v-model.number="form[pName].initialDelaySeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
            </div>
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Period (s)</label>
              <input v-model.number="form[pName].periodSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
            </div>
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Timeout (s)</label>
              <input v-model.number="form[pName].timeoutSeconds" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
            </div>
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Failure Threshold</label>
              <input v-model.number="form[pName].failureThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
            </div>
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Success Threshold</label>
              <input v-model.number="form[pName].successThreshold" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
            </div>
          </div>
        </div>

        <!-- 额外工作容器 (Sidecar) -->
        <h4 class="text-headline-sm mt-xl mb-md">额外工作容器 (Sidecar)</h4>
        <div class="flex flex-col gap-sm mb-xl">
          <div v-for="(c, idx) in form.extraContainers" :key="'ec'+idx" class="border border-outline-variant rounded-lg p-md">
            <div class="grid grid-cols-2 gap-md mb-sm">
              <input v-model="c.name" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="sidecar name" />
              <input v-model="c.image" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="image" />
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-md">
              <input v-model="c.cpuRequest" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="cpu req" />
              <input v-model="c.cpuLimit" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="cpu limit" />
              <input v-model="c.memoryRequest" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="mem req" />
              <input v-model="c.memoryLimit" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="mem limit" />
            </div>
            <button @click="removeExtraContainer(idx)" class="mt-sm text-body-sm text-error hover:underline">移除该容器</button>
          </div>
          <button @click="addExtraContainer" class="self-start flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Sidecar Container
          </button>
        </div>

        <!-- 初始容器 (Init) -->
        <h4 class="text-headline-sm mt-xl mb-md">初始容器 (Init Containers)</h4>
        <div class="flex flex-col gap-sm">
          <div v-for="(c, idx) in form.initContainers" :key="'ic'+idx" class="border border-outline-variant rounded-lg p-md">
            <div class="grid grid-cols-2 gap-md mb-sm">
              <input v-model="c.name" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="init name" />
              <input v-model="c.image" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="image" />
            </div>
            <div class="grid grid-cols-2 gap-md mb-sm">
              <input v-model="c.command" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="command" />
              <input v-model="c.args" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="args" />
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-md">
              <input v-model="c.cpuRequest" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="cpu req" />
              <input v-model="c.cpuLimit" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="cpu limit" />
              <input v-model="c.memoryRequest" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="mem req" />
              <input v-model="c.memoryLimit" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" placeholder="mem limit" />
            </div>
            <button @click="removeInitContainer(idx)" class="mt-sm text-body-sm text-error hover:underline">移除该容器</button>
          </div>
          <button @click="addInitContainer" class="self-start flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Init Container
          </button>
        </div>

        <!-- 安全上下文 -->
        <h4 class="text-headline-sm mt-xl mb-md">Security Context（安全上下文）</h4>
        <div class="border border-outline-variant rounded-lg mb-xl">
          <label class="flex items-center justify-between px-md py-sm cursor-pointer">
            <span class="text-body-md font-medium">启用自定义安全上下文</span>
            <input type="checkbox" v-model="form.securityContext.enabled" class="rounded text-primary h-4 w-4" />
          </label>
          <div v-if="form.securityContext.enabled" class="px-md pb-md grid grid-cols-2 gap-md">
            <div class="col-span-2 flex items-center gap-sm px-sm py-sm bg-error-container/10 border border-error/30 rounded-lg">
              <input type="checkbox" v-model="form.securityContext.privileged" class="rounded text-error h-4 w-4" id="priv" />
              <label for="priv" class="text-body-sm font-medium text-error flex items-center gap-xs"><span class="material-symbols-outlined text-base">warning</span>privileged（特权模式）— 危险：等同主机 root 权限</label>
            </div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Run As User</label><input v-model.number="form.securityContext.runAsUser" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="1000" /></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Run As Group</label><input v-model.number="form.securityContext.runAsGroup" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="1000" /></div>
            <div class="flex items-center gap-sm pt-xl"><input type="checkbox" v-model="form.securityContext.runAsNonPrivileged" class="rounded text-primary h-4 w-4" id="nonroot" /><label for="nonroot" class="text-body-sm">runAsNonRoot（非特权）</label></div>
            <div class="flex items-center gap-sm pt-xl"><input type="checkbox" v-model="form.securityContext.readOnlyRootFilesystem" class="rounded text-primary h-4 w-4" id="rorfs" /><label for="rorfs" class="text-body-sm">readOnlyRootFilesystem</label></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Add Capabilities</label><input v-model="form.securityContext.addCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="NET_BIND_SERVICE" /></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Drop Capabilities</label><input v-model="form.securityContext.dropCaps" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="ALL" /></div>
          </div>
        </div>

        <!-- 生命周期钩子 -->
        <h4 class="text-headline-sm mb-md">Lifecycle Hooks（生命周期钩子）</h4>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">PostStart (exec)</label>
            <input v-model="form.lifecycle.postStart" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="/bin/sh -c 'echo started'" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">PreStop (exec)</label>
            <input v-model="form.lifecycle.preStop" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="/bin/sh -c 'sleep 10'" />
          </div>
        </div>
          </div>
        </div>
      </div>

      <!-- Step 3: Volumes -->
      <div v-if="currentStep === 2">
        <h3 class="text-headline-md mb-lg">Volumes（数据卷挂载）</h3>

        <h4 class="text-headline-sm mb-md">Volume Mounts</h4>
        <div class="flex flex-col gap-sm mb-xl">
          <div v-for="(vol, idx) in form.volumeMounts" :key="idx" class="border border-outline-variant rounded-lg p-md">
            <div class="flex gap-sm items-center mb-sm">
              <select v-model="vol.type" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-medium">
                <option value="pvc">PVC</option>
                <option value="emptyDir">emptyDir</option>
                <option value="hostPath">hostPath</option>
                <option value="configMap">ConfigMap</option>
                <option value="secret">Secret</option>
              </select>
              <input v-model="vol.name" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="Volume Name" />
              <button @click="removeVolume(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined">delete</span></button>
            </div>
            <div class="grid grid-cols-2 gap-md mb-sm">
              <div>
                <label class="text-label-caps text-on-surface-variant block mb-xs">Mount Path</label>
                <input v-model="vol.mountPath" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="/data" />
              </div>
              <div>
                <label class="text-label-caps text-on-surface-variant block mb-xs">Sub Path (可选)</label>
                <input v-model="vol.subPath" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="" />
              </div>
            </div>
            <!-- 按卷类型显示来源 -->
            <div v-if="vol.type === 'pvc'">
              <label class="text-label-caps text-on-surface-variant block mb-xs">PVC</label>
              <select v-model="vol.pvcName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
                <option value="">选择 PVC</option>
                <option v-for="pvc in availablePVCs" :key="pvc" :value="pvc">{{ pvc }}</option>
              </select>
            </div>
            <div v-else-if="vol.type === 'hostPath'">
              <label class="text-label-caps text-on-surface-variant block mb-xs">Host Path</label>
              <input v-model="vol.hostPath" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="/var/lib/data" />
            </div>
            <div v-else-if="vol.type === 'configMap'">
              <label class="text-label-caps text-on-surface-variant block mb-xs">ConfigMap</label>
              <select v-model="vol.cmName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
                <option value="">选择 ConfigMap</option>
                <option v-for="cm in availableConfigMaps" :key="cm" :value="cm">{{ cm }}</option>
              </select>
            </div>
            <div v-else-if="vol.type === 'secret'">
              <label class="text-label-caps text-on-surface-variant block mb-xs">Secret</label>
              <select v-model="vol.secretName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
                <option value="">选择 Secret</option>
                <option v-for="s in availableSecrets" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <p v-else class="text-body-sm text-on-surface-variant">emptyDir：临时空目录，Pod 删除即失效。</p>
          </div>
          <button @click="addVolume" class="self-start flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Volume
          </button>
        </div>
      </div>

      <!-- Step 4: Scheduling & Update -->
      <div v-if="currentStep === 3">
        <h3 class="text-headline-md mb-lg">调度与更新策略</h3>

        <!-- 更新策略 -->
        <h4 class="text-headline-sm mb-md">更新策略 (Update Strategy)</h4>
        <div v-if="['Deployment','StatefulSet','DaemonSet'].includes(form.workloadType)" class="flex flex-col gap-md mb-xl">
          <div class="flex gap-sm">
            <button v-for="s in ['RollingUpdate','Recreate']" :key="s" @click="form.strategy = s"
              class="px-lg py-sm rounded-lg border font-medium text-body-md transition-all"
              :class="form.strategy === s ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">{{ s }}</button>
          </div>
          <div v-if="form.strategy === 'RollingUpdate'" class="grid grid-cols-3 gap-md">
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Max Surge</label><input v-model="form.maxSurge" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="25%" /></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Max Unavailable</label><input v-model="form.maxUnavailable" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="25%" /></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Revision History</label><input v-model.number="form.revisionHistoryLimit" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
          </div>
        </div>
        <p v-else class="text-body-sm text-on-surface-variant mb-xl">Job / CronJob 不适用滚动更新策略。</p>

        <!-- 节点调度 -->
        <h4 class="text-headline-sm mb-md">节点调度 (Node Selector)</h4>
        <div class="flex flex-col gap-sm mb-xl">
          <div v-for="(ns, idx) in form.nodeSelectors" :key="idx" class="flex gap-sm items-center">
            <input v-model="ns.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="label key (e.g. disktype)" />
            <input v-model="ns.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="value (e.g. ssd)" />
            <button @click="removeNodeSelector(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined">delete</span></button>
          </div>
          <button @click="addNodeSelector" class="self-start flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Node Selector
          </button>
        </div>

        <!-- 污点容忍 -->
        <h4 class="text-headline-sm mb-md">污点容忍 (Tolerations)</h4>
        <div class="flex flex-col gap-sm mb-xl">
          <div v-for="(t, idx) in form.tolerations" :key="idx" class="flex gap-sm items-center flex-wrap">
            <input v-model="t.key" class="flex-1 min-w-[100px] bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="key" />
            <select v-model="t.operator" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option>Equal</option><option>Exists</option>
            </select>
            <input v-if="t.operator === 'Equal'" v-model="t.value" class="flex-1 min-w-[80px] bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="value" />
            <select v-model="t.effect" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option>NoSchedule</option><option>PreferNoSchedule</option><option>NoExecute</option>
            </select>
            <button @click="removeToleration(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined">delete</span></button>
          </div>
          <button @click="addToleration" class="self-start flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Toleration
          </button>
        </div>

        <!-- 优先级 -->
        <h4 class="text-headline-sm mb-md">优先级 (PriorityClass)</h4>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">PriorityClass</label>
          <select v-model="form.priorityClassName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option value="">None</option>
            <option v-for="pc in availablePriorityClasses" :key="pc" :value="pc">{{ pc }}</option>
          </select>
        </div>
      </div>

      <!-- Step 5: Service & Ingress -->
      <div v-if="currentStep === 4">
        <h3 class="text-headline-md mb-lg">Service & Ingress</h3>

        <div class="flex items-center gap-sm mb-lg">
          <input v-model="form.createService" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" id="createSvc" />
          <label for="createSvc" class="text-body-md font-medium cursor-pointer">Create Service</label>
        </div>

        <div v-if="form.createService" class="mb-xl">
          <div class="mb-md">
            <label class="text-label-caps text-on-surface-variant block mb-sm">Service Type</label>
            <div class="flex flex-wrap gap-sm">
              <button v-for="st in ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']" :key="st" @click="form.serviceType = st"
                class="px-lg py-sm rounded-lg border font-medium text-body-md transition-all"
                :class="form.serviceType === st ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'"
              >{{ st }}</button>
            </div>
          </div>

          <!-- ExternalName -->
          <div v-if="form.serviceType === 'ExternalName'">
            <label class="text-label-caps text-on-surface-variant block mb-xs">External Name</label>
            <input v-model="form.externalName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="my-service.example.com" />
            <p class="text-body-xs text-on-surface-variant mt-xs flex items-center gap-xs"><span class="material-symbols-outlined text-sm">info</span>ExternalName 把 Service 映射到外部 DNS 名称（无需 selector/ports）</p>
          </div>

          <!-- 多端口编辑器 -->
          <div v-else>
            <label class="text-label-caps text-on-surface-variant block mb-sm">Service Ports（可配多个，如 http + https）</label>
            <div class="flex flex-col gap-sm">
              <div v-for="(sp, idx) in form.servicePorts" :key="idx" class="flex flex-wrap gap-xs items-center p-sm bg-surface-container-low rounded-lg border border-outline-variant">
                <input v-model="sp.name" class="w-20 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono" placeholder="名称" />
                <input v-model="sp.port" class="w-20 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono" placeholder="port" />
                <span class="text-on-surface-variant text-body-sm">→</span>
                <input v-model="sp.targetPort" class="w-24 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono" placeholder="targetPort" />
                <select v-model="sp.protocol" class="bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm">
                  <option>TCP</option><option>UDP</option>
                </select>
                <input v-if="form.serviceType === 'NodePort'" v-model="sp.nodePort" class="w-24 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono" placeholder="nodePort" />
                <button v-if="form.servicePorts.length > 1" @click="removeServicePort(idx)" class="p-xs text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">delete</span></button>
              </div>
              <button @click="addServicePort" class="self-start flex items-center gap-xs px-md py-xs text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
                <span class="material-symbols-outlined text-sm">add</span> Add Port
              </button>
            </div>
            <p v-if="form.ports.filter(p => p.containerPort).length" class="text-body-xs text-on-surface-variant mt-sm flex items-center gap-xs">
              <span class="material-symbols-outlined text-sm">arrow_forward</span>容器端口 <span class="font-mono text-primary">{{ form.ports.find(p => p.containerPort)?.containerPort }}</span> 可填入 targetPort
            </p>
            <p v-else-if="form.serviceType === 'NodePort'" class="text-body-xs text-tertiary-container mt-sm flex items-center gap-xs">
              <span class="material-symbols-outlined text-sm">info</span>NodePort 可在每行指定 nodePort（留空则自动分配）
            </p>
          </div>
        </div>

        <div class="mt-lg">
          <label class="flex items-center gap-sm cursor-pointer">
            <input v-model="form.createIngress" type="checkbox" class="rounded text-primary h-4 w-4" />
            <span class="text-body-md font-medium">Create Ingress</span>
          </label>
          <div v-if="form.createIngress" class="mt-md">
            <!-- ingressClassName -->
            <div class="mb-md">
              <label class="text-label-caps text-on-surface-variant block mb-xs">Ingress Class</label>
              <select v-model="form.ingressClassName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
                <option value="">None</option>
                <option>nginx</option>
                <option>traefik</option>
                <option>kong</option>
              </select>
            </div>

            <!-- 多 Rule 编辑器 -->
            <label class="text-label-caps text-on-surface-variant block mb-sm">路由规则 Rules（多域名 + 每 host 多 path）</label>
            <div class="flex flex-col gap-md">
              <div v-for="(rule, rIdx) in form.ingressRules" :key="rIdx" class="border border-outline-variant rounded-lg p-md bg-surface-container-low">
                <div class="flex gap-sm items-center mb-sm">
                  <span class="material-symbols-outlined text-primary text-lg">language</span>
                  <input v-model="rule.host" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="app.example.com" />
                  <button v-if="form.ingressRules.length > 1" @click="removeIngressRule(rIdx)" class="p-xs text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
                </div>
                <!-- paths -->
                <div class="flex flex-col gap-xs mb-sm">
                  <div v-for="(p, pIdx) in rule.paths" :key="pIdx" class="flex gap-xs items-center">
                    <input v-model="p.path" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono" placeholder="/api" />
                    <select v-model="p.pathType" class="bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm">
                      <option>Prefix</option><option>Exact</option><option>ImplementationSpecific</option>
                    </select>
                    <button v-if="rule.paths.length > 1" @click="removeIngressPath(rIdx, pIdx)" class="p-xs text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-base">close</span></button>
                  </div>
                  <button @click="addIngressPath(rIdx)" class="self-start flex items-center gap-xs px-sm py-xs text-primary font-medium text-body-xs hover:bg-primary-container/10 rounded">
                    <span class="material-symbols-outlined text-sm">add</span> Add Path
                  </button>
                </div>
                <!-- TLS -->
                <label class="flex items-center gap-sm cursor-pointer mt-xs">
                  <input type="checkbox" v-model="rule.tls" class="rounded text-primary h-4 w-4" />
                  <span class="text-body-sm">TLS（HTTPS）</span>
                  <input v-if="rule.tls" v-model="rule.tlsSecret" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono" placeholder="tls secret 名（留空自动生成）" />
                </label>
              </div>
              <button @click="addIngressRule" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
                <span class="material-symbols-outlined text-sm">add</span> Add Rule（多域名）
              </button>
            </div>
            <p class="text-body-xs text-on-surface-variant mt-sm flex items-center gap-xs">
              <span class="material-symbols-outlined text-sm">info</span>每个 Rule 一个域名，可配多个 path 与 pathType（Prefix/Exact），后端统一指向 {{ form.name }}-svc
            </p>

            <!-- 网关性能调优（nginx 注解，留空=默认）-->
            <details class="mt-md border border-outline-variant rounded-lg p-md bg-surface-container-low">
              <summary class="cursor-pointer text-body-sm font-semibold text-on-surface flex items-center gap-sm">
                <span class="material-symbols-outlined text-primary text-lg">tune</span> 网关性能调优（高级 · nginx 注解）
              </summary>
              <p class="text-body-xs text-on-surface-variant mt-sm mb-md">参数以 <code class="font-mono bg-surface-container px-1 rounded">nginx.ingress.kubernetes.io/*</code> 注解写入；留空即用控制器默认值。</p>
              <div class="flex flex-col gap-md">
                <div v-for="g in PERF_GROUPS" :key="g.title" class="border border-outline-variant rounded-lg p-sm bg-surface-container-lowest">
                  <div class="flex items-center gap-sm mb-sm">
                    <span class="material-symbols-outlined text-primary text-base">{{ g.icon }}</span>
                    <h4 class="text-body-xs font-semibold text-on-surface">{{ g.title }}</h4>
                  </div>
                  <div class="grid grid-cols-2 gap-xs">
                    <div v-for="fld in g.fields" :key="fld.key">
                      <label class="text-body-xs text-on-surface-variant block mb-xs">{{ fld.label }}</label>
                      <textarea v-if="fld.area" v-model="form.ingressAdv[fld.key]" rows="2" class="w-full bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="fld.ph"></textarea>
                      <select v-else-if="fld.options" v-model="form.ingressAdv[fld.key]" class="w-full bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm">
                        <option v-for="o in fld.options" :key="o" :value="o">{{ o || '默认' }}</option>
                      </select>
                      <input v-else v-model="form.ingressAdv[fld.key]" class="w-full bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="fld.ph" />
                    </div>
                  </div>
                </div>
                <!-- 自定义注解 -->
                <div class="border border-outline-variant rounded-lg p-sm bg-surface-container-lowest">
                  <div class="flex items-center justify-between mb-sm">
                    <h4 class="text-body-xs font-semibold text-on-surface">自定义注解（任意 key/value）</h4>
                    <button type="button" @click="addIngressCustom" class="flex items-center gap-xs px-sm py-xs border border-outline-variant rounded text-body-xs hover:bg-surface-container-low"><span class="material-symbols-outlined text-sm">add</span>新增</button>
                  </div>
                  <div v-for="(a, i) in form.ingressCustomAnnotations" :key="i" class="flex items-center gap-xs mb-xs">
                    <input v-model="a.key" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="annotation key" />
                    <input v-model="a.value" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="value" />
                    <button type="button" @click="removeIngressCustom(i)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-base">delete</span></button>
                  </div>
                  <p v-if="!form.ingressCustomAnnotations.length" class="text-body-xs text-on-surface-variant">暂无自定义注解</p>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>

      <!-- Step 6: Review & Deploy -->
      <div v-if="currentStep === 5">
        <h3 class="text-headline-md mb-lg">Review & Deploy</h3>

        <!-- Summary Cards -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-md mb-lg">
          <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center">
            <span class="material-symbols-outlined text-primary text-2xl">info</span>
            <p class="text-headline-md font-bold mt-sm">{{ form.name || '—' }}</p>
            <p class="text-body-sm text-on-surface-variant">{{ form.workloadType }}</p>
          </div>
          <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center">
            <span class="material-symbols-outlined text-secondary text-2xl">layers</span>
            <p class="text-headline-md font-bold mt-sm">{{ form.replicas }}</p>
            <p class="text-body-sm text-on-surface-variant">Replicas</p>
          </div>
          <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center">
            <span class="material-symbols-outlined text-tertiary text-2xl">hub</span>
            <p class="text-headline-md font-bold mt-sm">{{ form.createService ? form.serviceType : '—' }}</p>
            <p class="text-body-sm text-on-surface-variant">{{ form.createService ? 'Service' : 'No Service' }}</p>
          </div>
          <div class="p-md rounded-lg border border-outline-variant bg-surface-container-low text-center">
            <span class="material-symbols-outlined text-on-surface-variant text-2xl">language</span>
            <p class="text-headline-md font-bold mt-sm">{{ form.createIngress ? (form.ingressRules.find(r => r.host)?.host || '—') : '—' }}</p>
            <p class="text-body-sm text-on-surface-variant">{{ form.createIngress ? 'Ingress' : 'No Ingress' }}</p>
          </div>
        </div>

        <!-- YAML Preview -->
        <h4 class="text-headline-sm mb-md">YAML Preview</h4>
        <YamlEditor :model-value="previewYAML" :readonly="true" height="400px" />
      </div>

      <!-- Actions -->
      <div class="flex justify-between mt-xl pt-lg border-t border-outline-variant">
        <button v-if="currentStep > 0" @click="prevStep" class="flex items-center gap-sm px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">
          <span class="material-symbols-outlined">arrow_back</span> Back
        </button>
        <div v-else></div>
        <div class="flex gap-sm">
          <button @click="router.push(`/ns/${form.namespace}`)" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
          <button v-if="currentStep < steps.length - 1" @click="nextStep" :disabled="!canProceed"
            class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            Next <span class="material-symbols-outlined">arrow_forward</span>
          </button>
          <button v-else @click="handleDeploy" :disabled="deployLoading"
            class="flex items-center gap-sm px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 active:scale-95 transition-all disabled:opacity-50">
            <span class="material-symbols-outlined" :class="deployLoading ? 'animate-spin' : ''">{{ deployLoading ? 'progress_activity' : 'rocket_launch' }}</span>
            {{ deployLoading ? 'Deploying...' : 'Deploy' }}
          </button>
        </div>
      </div>
      <p v-if="deployError" class="mt-md rounded-lg border border-error/30 bg-error-container/10 px-md py-sm text-body-sm text-error">{{ deployError }}</p>
    </div>
  </div>
</template>
