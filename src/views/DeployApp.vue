<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
if (route.params.namespace) store.setNamespace(route.params.namespace)

const currentStep = ref(0)
const showDeploySuccess = ref(false)

const form = ref({
  name: '',
  namespace: route.params.namespace || 'default',
  workloadType: 'Deployment',
  description: '',
  replicas: 1,
  tier: 'svc',
  // Container
  containerName: '',
  image: '',
  pullPolicy: 'IfNotPresent',
  command: '',
  args: '',
  cpuRequest: '250m',
  cpuLimit: '500m',
  memoryRequest: '256Mi',
  memoryLimit: '512Mi',
  envVars: [{ key: '', value: '' }],
  envFromConfigMap: '',
  envFromSecret: '',
  // Storage & Network
  ports: [{ containerPort: '', protocol: 'TCP' }],
  volumeMounts: [{ name: '', mountPath: '', pvcName: '' }],
  // Service & Ingress
  createService: true,
  serviceType: 'ClusterIP',
  servicePort: '',
  createIngress: false,
  ingressHost: '',
  ingressPath: '/',
  enableTLS: false,
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
})

const steps = [
  { title: 'Basic Information', icon: 'info' },
  { title: 'Container Config', icon: 'layers' },
  { title: 'Storage & Volumes', icon: 'storage' },
  { title: 'Scheduling & Update', icon: 'tune' },
  { title: 'Service & Ingress', icon: 'hub' },
  { title: 'Review & Deploy', icon: 'rocket_launch' },
]

const workloadTypes = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']

function addEnvVar() { form.value.envVars.push({ key: '', value: '' }) }
function removeEnvVar(idx) { form.value.envVars.splice(idx, 1) }
function addPort() { form.value.ports.push({ containerPort: '', protocol: 'TCP' }) }
function removePort(idx) { form.value.ports.splice(idx, 1) }
function addVolume() { form.value.volumeMounts.push({ name: '', mountPath: '', pvcName: '' }) }
function removeVolume(idx) { form.value.volumeMounts.splice(idx, 1) }
function addLabel() { form.value.labels.push({ key: '', value: '' }) }
function removeLabel(idx) { form.value.labels.splice(idx, 1) }
function addAnnotation() { form.value.annotations.push({ key: '', value: '' }) }
function removeAnnotation(idx) { form.value.annotations.splice(idx, 1) }
function addNodeSelector() { form.value.nodeSelectors.push({ key: '', value: '' }) }
function removeNodeSelector(idx) { form.value.nodeSelectors.splice(idx, 1) }
function addToleration() { form.value.tolerations.push({ key: '', operator: 'Equal', value: '', effect: 'NoSchedule' }) }
function removeToleration(idx) { form.value.tolerations.splice(idx, 1) }

function nextStep() { if (currentStep.value < steps.length - 1) currentStep.value++ }
function prevStep() { if (currentStep.value > 0) currentStep.value-- }

const canProceed = computed(() => {
  if (currentStep.value === 0) return form.value.name && form.value.namespace
  if (currentStep.value === 1) return form.value.image
  return true
})

// Available ConfigMaps/Secrets for envFrom
const availableConfigMaps = computed(() => store.nsConfigMaps.map(c => c.name))
const availableSecrets = computed(() => store.nsSecrets.map(s => s.name))
const availablePVCs = computed(() => store.nsPVCs.map(p => p.name))
const availablePriorityClasses = computed(() => store.priorityClassList.map(p => p.name))
const availableServiceAccounts = computed(() => store.nsServiceAccounts.map(s => s.name))

const tierOptions = [
  { value: 'web', label: '表现层 Web', icon: 'web' },
  { value: 'gateway', label: '网关层 Gateway', icon: 'dns' },
  { value: 'svc', label: '服务层 Service', icon: 'apps' },
  { value: 'cloud', label: '中间件 Middleware', icon: 'cloud' },
  { value: 'db', label: '持久层 Database', icon: 'database' },
  { value: 'monitor', label: '监控层 Monitor', icon: 'monitoring' },
  { value: 'default', label: '默认层 Default', icon: 'workspaces' },
]

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
    .map(e => `        - name: ${e.key}
          value: "${e.value}"`)
    .join('\n')

  const envFromYaml = []
  if (f.envFromConfigMap) envFromYaml.push(`        - configMapRef:
            name: ${f.envFromConfigMap}`)
  if (f.envFromSecret) envFromYaml.push(`        - secretRef:
            name: ${f.envFromSecret}`)

  const volumeMountsYaml = f.volumeMounts
    .filter(v => v.name && v.mountPath)
    .map(v => `        - name: ${v.name}
          mountPath: ${v.mountPath}`)
    .join('\n')

  const volumesYaml = f.volumeMounts
    .filter(v => v.name && v.pvcName)
    .map(v => `      - name: ${v.name}
        persistentVolumeClaim:
          claimName: ${v.pvcName}`)
    .join('\n')

  let yaml = `apiVersion: apps/v1
kind: ${f.workloadType}
metadata:
  name: ${f.name}
  namespace: ${f.namespace}
  labels:
${Object.entries(labels).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
spec:
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
  template:
    metadata:
      labels:
${Object.entries(labels).map(([k, v]) => `        ${k}: ${v}`).join('\n')}
    spec:`
  if (f.serviceAccountName) yaml += `\n      serviceAccountName: ${f.serviceAccountName}`
  if (f.priorityClassName) yaml += `\n      priorityClassName: ${f.priorityClassName}`
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
  if (portsYaml) yaml += `\n        ports:\n${portsYaml}`
  if (envYaml || envFromYaml.length) {
    yaml += `\n        env:`
    if (envYaml) yaml += `\n${envYaml}`
    if (envFromYaml.length) {
      yaml += `\n        envFrom:\n${envFromYaml.join('\n')}`
    }
  }
  yaml += `\n        resources:
          requests:
            cpu: ${f.cpuRequest}
            memory: ${f.memoryRequest}
          limits:
            cpu: ${f.cpuLimit}
            memory: ${f.memoryLimit}`
  if (volumeMountsYaml) yaml += `\n        volumeMounts:\n${volumeMountsYaml}`
  if (volumesYaml) yaml += `\n      volumes:\n${volumesYaml}`

  // Service
  if (f.createService && f.servicePort) {
    yaml += `\n---
apiVersion: v1
kind: Service
metadata:
  name: ${f.name}-svc
  namespace: ${f.namespace}
spec:
  type: ${f.serviceType}
  selector:
    app: ${f.name}
  ports:
    - port: ${f.servicePort}
      targetPort: ${f.ports[0]?.containerPort || f.servicePort}
      protocol: TCP`
  }

  // Ingress
  if (f.createIngress && f.ingressHost) {
    yaml += `\n---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${f.name}-ingress
  namespace: ${f.namespace}
  annotations:
    kubernetes.io/ingress.class: nginx${f.enableTLS ? '\n    cert-manager.io/cluster-issuer: letsencrypt-prod' : ''}
spec:${f.enableTLS ? `\n  tls:
  - hosts:
    - ${f.ingressHost}
    secretName: ${f.name}-tls` : ''}
  rules:
  - host: ${f.ingressHost}
    http:
      paths:
      - path: ${f.ingressPath}
        pathType: Prefix
        backend:
          service:
            name: ${f.name}-svc
            port:
              number: ${f.servicePort || 80}`
  }

  return yaml
})

// Deploy action
function handleDeploy() {
  const f = form.value
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
  if (f.createService && f.servicePort) {
    store.addService({
      name: f.name + '-svc',
      namespace: f.namespace,
      type: f.serviceType,
      clusterIP: '10.96.' + Math.floor(Math.random() * 255) + '.' + Math.floor(Math.random() * 255),
      externalIP: '-',
      ports: f.servicePort + ':' + (f.ports[0]?.containerPort || f.servicePort) + '/TCP',
      selector: { app: f.name },
    })
  }

  // Add ingress if requested
  if (f.createIngress && f.ingressHost) {
    store.addIngress({
      name: f.name + '-ingress',
      namespace: f.namespace,
      hosts: f.ingressHost,
      path: f.ingressPath,
      backend: f.name + '-svc:' + (f.servicePort || 80),
      tls: f.enableTLS,
      tlsSecret: f.enableTLS ? f.name + '-tls' : '',
      className: 'nginx',
      annotations: { 'kubernetes.io/ingress.class': 'nginx' },
      rules: [{
        host: f.ingressHost,
        http: { paths: [{ path: f.ingressPath, pathType: 'Prefix', backend: { serviceName: f.name + '-svc', servicePort: parseInt(f.servicePort) || 80 } }] }
      }],
    })
  }

  showDeploySuccess.value = true
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
        <button @click="showDeploySuccess = false; currentStep = 0; form.name = ''" class="px-lg py-sm border border-outline-variant rounded-lg hover:bg-surface-container-high">
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
          <div v-if="form.workloadType !== 'DaemonSet'">
            <label class="text-label-caps text-on-surface-variant block mb-xs">Replicas</label>
            <input v-model.number="form.replicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" />
          </div>
          <div class="md:col-span-2">
            <label class="text-label-caps text-on-surface-variant block mb-xs">Description</label>
            <textarea v-model="form.description" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary h-20 resize-none" placeholder="Optional description..."></textarea>
          </div>
          <div class="md:col-span-2">
            <label class="text-label-caps text-on-surface-variant block mb-xs">服务分层 (Tier) <span class="text-tertiary-container normal-case">决定在分层拓扑中的归属</span></label>
            <div class="flex flex-wrap gap-sm">
              <button v-for="t in tierOptions" :key="t.value" @click="form.tier = t.value"
                class="flex items-center gap-xs px-md py-sm rounded-lg border text-body-sm font-medium transition-all"
                :class="form.tier === t.value ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">
                <span class="material-symbols-outlined text-sm">{{ t.icon }}</span>{{ t.label }}
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
        </div>

        <!-- Resources -->
        <h4 class="text-headline-sm mt-xl mb-md">Resources</h4>
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
        <div class="grid grid-cols-2 gap-md">
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
      </div>

      <!-- Step 3: Storage & Volumes -->
      <div v-if="currentStep === 2">
        <h3 class="text-headline-md mb-lg">Storage & Network</h3>

        <h4 class="text-headline-sm mb-md">Container Ports</h4>
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

        <h4 class="text-headline-sm mt-xl mb-md">Volume Mounts (PVC)</h4>
        <div class="flex flex-col gap-sm mb-xl">
          <div v-for="(vol, idx) in form.volumeMounts" :key="idx" class="flex gap-sm items-center">
            <input v-model="vol.name" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="Volume Name" />
            <input v-model="vol.mountPath" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="/data" />
            <select v-model="vol.pvcName" class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="">No PVC</option>
              <option v-for="pvc in availablePVCs" :key="pvc" :value="pvc">{{ pvc }}</option>
            </select>
            <button @click="removeVolume(idx)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined">delete</span></button>
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

        <!-- 优先级与身份 -->
        <h4 class="text-headline-sm mb-md">优先级与身份</h4>
        <div class="grid grid-cols-2 gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">PriorityClass</label>
            <select v-model="form.priorityClassName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="">None</option>
              <option v-for="pc in availablePriorityClasses" :key="pc" :value="pc">{{ pc }}</option>
            </select>
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">ServiceAccount</label>
            <select v-model="form.serviceAccountName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
              <option value="">Default</option>
              <option v-for="sa in availableServiceAccounts" :key="sa" :value="sa">{{ sa }}</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Step 5: Service & Ingress -->
      <div v-if="currentStep === 4">
        <h3 class="text-headline-md mb-lg">Service & Ingress</h3>

        <div class="flex items-center gap-sm mb-lg">
          <input v-model="form.createService" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" id="createSvc" />
          <label for="createSvc" class="text-body-md font-medium cursor-pointer">Create Service</label>
        </div>

        <div v-if="form.createService" class="grid grid-cols-1 md:grid-cols-2 gap-lg mb-xl">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-sm">Service Type</label>
            <div class="flex gap-sm">
              <button v-for="st in ['ClusterIP', 'NodePort', 'LoadBalancer']" :key="st" @click="form.serviceType = st"
                class="px-lg py-sm rounded-lg border font-medium text-body-md transition-all"
                :class="form.serviceType === st ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'"
              >{{ st }}</button>
            </div>
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">Service Port</label>
            <input v-model="form.servicePort" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="80" />
          </div>
        </div>

        <div class="mt-lg">
          <label class="flex items-center gap-sm cursor-pointer">
            <input v-model="form.createIngress" type="checkbox" class="rounded text-primary h-4 w-4" />
            <span class="text-body-md font-medium">Create Ingress</span>
          </label>
          <div v-if="form.createIngress" class="mt-md grid grid-cols-1 md:grid-cols-2 gap-lg">
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Host</label><input v-model="form.ingressHost" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="app.example.com" /></div>
            <div><label class="text-label-caps text-on-surface-variant block mb-xs">Path</label><input v-model="form.ingressPath" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="/" /></div>
            <div><label class="flex items-center gap-sm cursor-pointer"><input v-model="form.enableTLS" type="checkbox" class="rounded text-primary h-4 w-4" /><span class="text-body-md">Enable TLS/SSL</span></label></div>
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
            <p class="text-headline-md font-bold mt-sm">{{ form.createIngress ? form.ingressHost || '—' : '—' }}</p>
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
          <button v-else @click="handleDeploy"
            class="flex items-center gap-sm px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 active:scale-95 transition-all">
            <span class="material-symbols-outlined">rocket_launch</span> Deploy
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
