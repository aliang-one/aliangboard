<script setup>
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import PortSelect from '@/components/common/PortSelect.vue'

const store = useClusterStore()

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
const secretForm = ref({ name: '', type: 'Opaque', data: [{ key: '', value: '' }] })

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

function addRow(arr) { arr.push({ key: '', value: '' }) }
function removeRow(arr, idx) { if (arr.length > 1) arr.splice(idx, 1) }

function handleCreate() {
  emit('create', { type: props.resourceType, namespace: props.namespace })
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
type: {{ secretForm.type }}
data:
{{ secretForm.data.filter(d=>d.key).map(d=>`  ${d.key}: <base64-encoded>`).join('\n') || '  {}' }}</pre>
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
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Target Port</label><PortSelect v-model="serviceForm.targetPort" :options="store.nsContainerPorts" placeholder="8080" empty-hint="当前命名空间暂无工作负载暴露容器端口，可直接输入" input-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" /></div>
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
                <div class="grid grid-cols-2 gap-md mb-lg">
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Name *</label><input v-model="secretForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-secret" /></div>
                  <div><label class="text-label-caps text-on-surface-variant block mb-xs">Type</label>
                    <select v-model="secretForm.type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary">
                      <option>Opaque</option><option>kubernetes.io/tls</option><option>kubernetes.io/dockerconfigjson</option><option>kubernetes.io/basic-auth</option>
                    </select>
                  </div>
                </div>
                <h4 class="text-label-caps text-on-surface-variant mb-sm">DATA</h4>
                <div v-for="(d, i) in secretForm.data" :key="i" class="flex gap-sm mb-sm">
                  <input v-model="d.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="Key" />
                  <input v-model="d.value" type="password" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="Value" />
                  <button @click="removeRow(secretForm.data, i)" class="p-sm text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
                </div>
                <button @click="addRow(secretForm.data)" class="flex items-center gap-sm px-md py-sm text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined">add</span>Add Key</button>
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
