<script setup>
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { extractContainerPorts } from '@/composables/usePorts'
import PortSelect from '@/components/common/PortSelect.vue'
import { SECRET_TEMPLATES, buildSecretData } from '@/composables/useSecretTemplates'
import { useEscClose } from '@/composables/useEscClose'

const { t } = useI18n()
const store = useClusterStore()
const _cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const _wlsQ = useResourceList({ key: ['cluster', _cid.value, 'workloads'], fetcher: () => store.fetchWorkloads(), mock: store.workloadList, mockMode: !store.remoteMode, options: { refetchInterval: store.remoteMode ? 30000 : false } })
const nsContainerPorts = computed(() => extractContainerPorts((_wlsQ.data.value || [])))

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  resourceType: { type: String, required: true }, // 'deployment', 'service', 'configmap', 'secret', 'ingress', 'pvc'
  namespace: { type: String, default: 'default' },
})

const emit = defineEmits(['update:modelValue', 'create'])

const activeTab = ref('form') // 'form' | 'yaml'

// Forms for each resource type
const deploymentForm = ref({
  name: '', replicas: 1, image: '', imagePullPolicy: 'IfNotPresent',
  containerPort: '', cpuRequest: '250m', cpuLimit: '500m', memoryRequest: '256Mi', memoryLimit: '512Mi',
  labels: [{ key: 'app', value: '' }],
  envVars: [{ key: '', value: '' }],
})

const serviceForm = ref({
  name: '', type: 'ClusterIP', port: 80, targetPort: 8080, protocol: 'TCP',
  selector: [{ key: 'app', value: '' }],
})

const configMapForm = ref({ name: '', data: [{ key: '', value: '' }] })
const secretForm = ref({ name: '', templateId: 'opaque', fields: { data: [{ key: '', value: '' }] } })

const ingressForm = ref({
  name: '', host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: 80, enableTLS: true,
})

const pvcForm = ref({
  name: '', storageClass: '', accessMode: 'ReadWriteOnce', capacity: '10Gi',
})

const titles = {
  deployment: 'Create Deployment',
  service: 'Create Service',
  configmap: 'Create ConfigMap',
  secret: 'Create Secret',
  ingress: 'Create Ingress',
  pvc: 'Create PersistentVolumeClaim',
}

const title = computed(() => titles[props.resourceType] || 'Create Resource')

function close() { emit('update:modelValue', false) }
const isOpen = computed(() => props.modelValue)
useEscClose(isOpen, close)

function addRow(arr) { arr.push({ key: '', value: '' }) }
function removeRow(arr, idx) { if (arr.length > 1) arr.splice(idx, 1) }

function handleCreate() {
  if (props.resourceType === 'secret') {
    const tpl = SECRET_TEMPLATES.find(t => t.id === secretForm.value.templateId)
    const data = buildSecretData(secretForm.value.templateId, secretForm.value.fields)
    emit('create', { type: 'secret', namespace: props.namespace, name: secretForm.value.name, k8sType: tpl?.k8sType || 'Opaque', data })
  } else {
    emit('create', { type: props.resourceType, namespace: props.namespace })
  }
  close()
}
</script>

<template>
  <Teleport to="body">
    <transition name="fade">
      <div v-if="modelValue" class="fixed inset-0 z-[100] flex items-center justify-center">
        <div class="absolute inset-0 bg-on-surface/30 backdrop-blur-sm" @click="close"></div>
        <div class="relative bg-surface-container-lowest rounded-xl border border-outline-variant shadow-dropdown w-full max-w-2xl max-h-[85vh] flex flex-col z-10 animate-slide-up">
          <!-- Header -->
          <div class="flex items-center justify-between px-lg py-md border-b border-outline-variant shrink-0">
            <div class="flex items-center gap-md">
              <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <span class="material-symbols-outlined text-primary">add</span>
              </div>
              <div>
                <h3 class="text-headline-sm font-bold">{{ title }}</h3>
                <p class="text-body-sm text-on-surface-variant">Namespace: <span class="text-primary font-medium">{{ namespace }}</span></p>
              </div>
            </div>
            <button @click="close" class="p-1 text-on-surface-variant hover:bg-surface-container rounded-lg"><span class="material-symbols-outlined">close</span></button>
          </div>

          <!-- Tabs -->
          <div class="flex border-b border-outline-variant shrink-0">
            <button @click="activeTab = 'form'" class="px-xl py-sm border-b-2 text-body-md font-medium" :class="activeTab === 'form' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant'">
              <span class="material-symbols-outlined text-sm align-middle mr-1">edit</span>Form
            </button>
            <button @click="activeTab = 'yaml'" class="px-xl py-sm border-b-2 text-body-md font-medium" :class="activeTab === 'yaml' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant'">
              <span class="material-symbols-outlined text-sm align-middle mr-1">description</span>YAML
            </button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto p-lg">
            <!-- YAML Preview -->
            <div v-if="activeTab === 'yaml'" class="bg-[#0b1c30] rounded-lg p-md font-mono text-code-sm text-[#cfe3ff]">
              <pre v-if="resourceType === 'deployment'">apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ deploymentForm.name }}
  namespace: {{ namespace }}
  labels:
{{ deploymentForm.labels.filter(l=>l.key).map(l=>`    ${l.key}: ${l.value}`).join('\n') || '    app: ' + deploymentForm.name }}
spec:
  replicas: {{ deploymentForm.replicas }}
  selector:
    matchLabels:
{{ deploymentForm.labels.filter(l=>l.key).map(l=>`      ${l.key}: ${l.value}`).join('\n') || '      app: ' + deploymentForm.name }}
  template:
    spec:
      containers:
      - name: {{ deploymentForm.name }}
        image: {{ deploymentForm.image }}
        ports:
{{ deploymentForm.containerPort ? '        - containerPort: ' + deploymentForm.containerPort : '' }}
        resources:
          requests:
            cpu: "{{ deploymentForm.cpuRequest }}"
            memory: "{{ deploymentForm.memoryRequest }}"
          limits:
            cpu: "{{ deploymentForm.cpuLimit }}"
            memory: "{{ deploymentForm.memoryLimit }}"</pre>
              <pre v-else-if="resourceType === 'service'">apiVersion: v1
kind: Service
metadata:
  name: {{ serviceForm.name }}
  namespace: {{ namespace }}
spec:
  type: {{ serviceForm.type }}
  ports:
    - port: {{ serviceForm.port }}
      targetPort: {{ serviceForm.targetPort }}
      protocol: {{ serviceForm.protocol }}
  selector:
{{ serviceForm.selector.filter(l=>l.key).map(l=>`    ${l.key}: ${l.value}`).join('\n') }}</pre>
              <pre v-else-if="resourceType === 'configmap'">apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ configMapForm.name }}
  namespace: {{ namespace }}
data:
{{ configMapForm.data.filter(d=>d.key).map(d=>`  ${d.key}: |-\n    ${d.value}`).join('\n') || '  {}' }}</pre>
              <pre v-else-if="resourceType === 'secret'">apiVersion: v1
kind: Secret
metadata:
  name: {{ secretForm.name }}
  namespace: {{ namespace }}
type: {{ SECRET_TEMPLATES.find(t => t.id === secretForm.templateId)?.k8sType || 'Opaque' }}
data:
{{ Object.keys(buildSecretData(secretForm.templateId, secretForm.fields)).map(k => `  ${k}: <base64-encoded>`).join('\n') || '  {}' }}</pre>
              <pre v-else-if="resourceType === 'ingress'">apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ ingressForm.name }}
  namespace: {{ namespace }}
spec:
  {{ ingressForm.enableTLS ? 'tls:' : '' }}
  {{ ingressForm.enableTLS ? '- hosts: [' + ingressForm.host + ']' : '' }}
  rules:
  - host: {{ ingressForm.host }}
    http:
      paths:
      - path: {{ ingressForm.path }}
        pathType: {{ ingressForm.pathType }}
        backend:
          service:
            name: {{ ingressForm.serviceName }}
            port:
              number: {{ ingressForm.servicePort }}</pre>
              <pre v-else-if="resourceType === 'pvc'">apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ pvcForm.name }}
  namespace: {{ namespace }}
spec:
  accessModes:
    - {{ pvcForm.accessMode }}
  resources:
    requests:
      storage: {{ pvcForm.capacity }}
{{ pvcForm.storageClass ? '  storageClassName: ' + pvcForm.storageClass : '' }}</pre>
            </div>

            <!-- Form -->
            <div v-else>
              <!-- Deployment Form -->
              <template v-if="resourceType === 'deployment'">
                <div class="grid grid-cols-2 gap-md mb-lg">
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Name *</label><input v-model="deploymentForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-deployment" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Replicas</label><input v-model.number="deploymentForm.replicas" type="number" min="1" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" /></div>
                  <div class="col-span-2"><label class="text-label-caps text-on-surface-variant block mb-xs">Image *</label><input v-model="deploymentForm.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="nginx:latest" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Container Port</label><input v-model="deploymentForm.containerPort" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="8080" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Pull Policy</label>
                    <select v-model="deploymentForm.imagePullPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary"><option>IfNotPresent</option><option>Always</option><option>Never</option></select>
                  </div>
                </div>
                <h4 class="text-label-caps text-on-surface-variant mb-sm">RESOURCES</h4>
                <div class="grid grid-cols-4 gap-sm">
                  <div><label class="text-body-sm text-on-surface-variant block mb-xs">CPU Req</label><input v-model="deploymentForm.cpuRequest" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
                  <div><label class="text-body-sm text-on-surface-variant block mb-xs">CPU Limit</label><input v-model="deploymentForm.cpuLimit" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
                  <div><label class="text-body-sm text-on-surface-variant block mb-xs">Mem Req</label><input v-model="deploymentForm.memoryRequest" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
                  <div><label class="text-body-sm text-on-surface-variant block mb-xs">Mem Limit</label><input v-model="deploymentForm.memoryLimit" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
                </div>
              </template>

              <!-- Service Form -->
              <template v-if="resourceType === 'service'">
                <div class="grid grid-cols-2 gap-md mb-lg">
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Name *</label><input v-model="serviceForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-service" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-sm">Type</label>
                    <div class="flex gap-sm">
                      <button v-for="t in ['ClusterIP','NodePort','LoadBalancer']" :key="t" @click="serviceForm.type = t" class="px-md py-sm rounded-lg border text-body-md transition-all" :class="serviceForm.type === t ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant'">{{ t }}</button>
                    </div>
                  </div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Port</label><input v-model.number="serviceForm.port" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Target Port</label><PortSelect v-model="serviceForm.targetPort" :options="nsContainerPorts" placeholder="8080" :empty-hint="t('component.createDialog.serviceEmptyHint')" input-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
                </div>
              </template>

              <!-- ConfigMap Form -->
              <template v-if="resourceType === 'configmap'">
                <div class="mb-lg"><label class="text-label-caps text-on-surface-variant block mb-xs">Name *</label><input v-model="configMapForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-config" /></div>
                <h4 class="text-label-caps text-on-surface-variant mb-sm">DATA</h4>
                <div v-for="(d, i) in configMapForm.data" :key="i" class="flex gap-sm mb-sm">
                  <input v-model="d.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="Key" />
                  <input v-model="d.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="Value" />
                  <button @click="removeRow(configMapForm.data, i)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
                </div>
                <button @click="addRow(configMapForm.data)" class="flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined">add</span>Add Key</button>
              </template>

              <!-- Secret Form -->
              <template v-if="resourceType === 'secret'">
              <!-- Secret 模板选择器 -->
              <div>
                <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('component.createDialog.secretTemplateLabel') }}</label>
                <div class="grid grid-cols-2 gap-xs">
                  <button v-for="tpl in SECRET_TEMPLATES" :key="tpl.id" type="button" @click="secretForm.templateId = tpl.id"
                    class="flex items-center gap-sm px-md py-sm rounded-lg border text-left transition-all"
                    :class="secretForm.templateId === tpl.id ? 'border-primary bg-primary-container/10 text-primary' : 'border-outline-variant text-on-surface hover:bg-surface-container-low'">
                    <span class="material-symbols-outlined text-base">{{ tpl.icon }}</span>
                    <div class="min-w-0">
                      <p class="text-body-sm font-medium truncate">{{ t(tpl.labelKey) }}</p>
                      <p class="text-[10px] text-on-surface-variant truncate">{{ t(tpl.descriptionKey) }}</p>
                    </div>
                  </button>
                </div>
              </div>
              <!-- 名称 -->
              <div class="mt-md">
                <label class="text-label-caps text-on-surface-variant block mb-xs">Secret Name *</label>
                <input v-model="secretForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-secret" />
              </div>
              <!-- Opaque: key-value 列表 -->
              <div v-if="secretForm.templateId === 'opaque'" class="mt-md">
                <label class="text-label-caps text-on-surface-variant block mb-xs">Data</label>
                <div v-for="(d, i) in secretForm.fields.data" :key="i" class="flex gap-xs mb-xs">
                  <input v-model="d.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono" placeholder="key" />
                  <input v-model="d.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono" placeholder="value" />
                  <button @click="() => { if (secretForm.fields.data.length > 1) secretForm.fields.data.splice(i, 1) }" class="p-xs text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-lg">close</span></button>
                </div>
                <button @click="secretForm.fields.data.push({ key: '', value: '' })" class="text-body-sm text-primary font-medium hover:underline">{{ t('component.createDialog.addData') }}</button>
              </div>
              <!-- 非 Opaque: 按模板 fields 动态渲染 -->
              <div v-else class="mt-md">
                <div v-for="f in SECRET_TEMPLATES.find(t => t.id === secretForm.templateId)?.fields" :key="f.key" class="mb-sm">
                  <label class="text-label-caps text-on-surface-variant block mb-xs">{{ f.labelKey !== undefined ? t(f.labelKey) : f.label }}{{ f.optional ? t('component.createDialog.optionalSuffix') : '' }}</label>
                  <!-- select -->
                  <select v-if="f.type === 'select'" v-model="secretForm.fields[f.key]" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
                    <option v-for="opt in f.options" :key="opt.value" :value="opt.value">{{ opt.labelKey ? t(opt.labelKey) : opt.label }}</option>
                  </select>
                  <!-- password -->
                  <input v-else-if="f.type === 'password'" v-model="secretForm.fields[f.key]" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" :placeholder="f.placeholder || ''" />
                  <!-- textarea -->
                  <textarea v-else-if="f.type === 'textarea'" v-model="secretForm.fields[f.key]" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono h-24 resize-y" :placeholder="f.placeholder || ''"></textarea>
                  <!-- text -->
                  <input v-else v-model="secretForm.fields[f.key]" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" :placeholder="f.placeholder || ''" />
                  <!-- hint -->
                  <p v-if="f.hintKey || (f.type === 'select' && f.options?.find(o => o.value === secretForm.fields[f.key])?.hintKey)" class="text-[10px] text-on-surface-variant mt-xs">{{ t(f.options?.find(o => o.value === secretForm.fields[f.key])?.hintKey || f.hintKey) }}</p>
                </div>
                <!-- Docker 快捷 registry -->
                <div v-if="secretForm.templateId === 'docker'" class="flex gap-xs flex-wrap mt-xs">
                  <button v-for="qf in SECRET_TEMPLATES.find(t => t.id === 'docker').quickFills" :key="qf.server" type="button" @click="secretForm.fields.server = qf.server"
                    class="px-sm py-xs text-xs rounded border" :class="secretForm.fields.server === qf.server ? 'border-primary text-primary bg-primary-container/10' : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-low'">
                    {{ qf.label }}
                  </button>
                </div>
              </div>
              </template>

              <!-- Ingress Form -->
              <template v-if="resourceType === 'ingress'">
                <div class="grid grid-cols-2 gap-md mb-lg">
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Name *</label><input v-model="ingressForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-ingress" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Host</label><input v-model="ingressForm.host" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="app.example.com" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Service Name</label><input v-model="ingressForm.serviceName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="my-service" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Service Port</label><input v-model.number="ingressForm.servicePort" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Path</label><input v-model="ingressForm.path" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="/" /></div>
                  <div class="flex items-end"><label class="flex items-center gap-sm cursor-pointer"><input v-model="ingressForm.enableTLS" type="checkbox" class="rounded text-primary h-4 w-4" /><span class="text-body-md">Enable TLS</span></label></div>
                </div>
              </template>

              <!-- PVC Form -->
              <template v-if="resourceType === 'pvc'">
                <div class="grid grid-cols-2 gap-md mb-lg">
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Name *</label><input v-model="pvcForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-pvc" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Capacity</label><input v-model="pvcForm.capacity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="10Gi" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Storage Class</label><input v-model="pvcForm.storageClass" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="standard" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-sm">Access Mode</label>
                    <div class="flex gap-sm">
                      <button v-for="m in ['RWO','RWX','ROX']" :key="m" @click="pvcForm.accessMode = {RWO:'ReadWriteOnce',RWX:'ReadWriteMany',ROX:'ReadOnlyMany'}[m]" class="px-md py-sm rounded-lg border text-body-md transition-all" :class="pvcForm.accessMode === {RWO:'ReadWriteOnce',RWX:'ReadWriteMany',ROX:'ReadOnlyMany'}[m] ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant'">{{ m }}</button>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex justify-end gap-sm px-lg py-md border-t border-outline-variant shrink-0">
            <button @click="close" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high transition-colors">Cancel</button>
            <button @click="handleCreate" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 active:scale-95 transition-all flex items-center gap-sm">
              <span class="material-symbols-outlined text-lg">add</span> Create
            </button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>
