<script setup>
import { ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'

const route = useRoute()
const store = useClusterStore()
if (route.params.namespace) store.setNamespace(route.params.namespace)

const pod = computed(() => store.getPodByName(route.params.name))
const activeTab = ref('logs')

const tabs = [
  { key: 'logs', label: 'Logs', icon: 'terminal' },
  { key: 'yaml', label: 'YAML', icon: 'description' },
  { key: 'terminal', label: 'Terminal', icon: 'keyboard' },
  { key: 'events', label: 'Events', icon: 'event_note' },
]

function levelColor(level) {
  const map = { INFO: 'text-primary-container', WARN: 'text-tertiary-fixed-dim', ERROR: 'text-error' }
  return map[level] || 'text-outline-variant'
}
</script>

<template>
  <div class="animate-fade-in" v-if="pod">
    <!-- Header -->
    <div class="mb-lg flex items-center justify-between">
      <div class="flex flex-col">
        <Breadcrumbs :items="[
          { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
          { label: 'Pods', route: `/ns/${route.params.namespace}/pods` },
          { label: pod.name }
        ]" />
        <div class="flex items-center gap-3 mt-2">
          <div class="w-3 h-3 rounded-full bg-primary-container animate-pulse-status"></div>
          <h2 class="text-display-lg">Pod: {{ pod.name }}</h2>
          <StatusChip :status="pod.status" />
        </div>
      </div>
      <div class="flex gap-2">
        <button class="flex items-center gap-2 px-md py-2 border border-outline-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-error">delete</span>
          <span class="font-medium text-body-md">Delete</span>
        </button>
        <button class="flex items-center gap-2 px-md py-2 bg-primary text-on-primary rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">refresh</span>
          <span class="font-medium text-body-md">Restart</span>
        </button>
      </div>
    </div>

    <div class="flex-1 grid grid-cols-12 gap-gutter">
      <!-- Main Console Area -->
      <div class="col-span-12 lg:col-span-9 flex flex-col bg-surface-container-lowest rounded-xl border border-outline-variant shadow-card overflow-hidden">
        <!-- Tabs -->
        <div class="flex border-b border-outline-variant bg-surface-container-low">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            @click="activeTab = tab.key"
            class="px-xl py-4 flex items-center gap-2 border-b-2 font-medium transition-colors"
            :class="activeTab === tab.key
              ? 'border-primary text-primary font-bold'
              : 'border-transparent text-on-surface-variant hover:bg-surface-container'"
          >
            <span class="material-symbols-outlined">{{ tab.icon }}</span>
            {{ tab.label }}
          </button>
        </div>

        <!-- Logs View -->
        <div v-if="activeTab === 'logs'" class="flex-1 flex flex-col">
          <div class="bg-surface-container-highest/50 px-md py-2 flex items-center justify-between border-b border-outline-variant">
            <div class="flex items-center gap-md">
              <span class="text-body-sm text-on-surface-variant font-medium">Container: {{ pod.containers?.[0] || 'main' }}</span>
              <div class="flex items-center gap-2">
                <input checked type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
                <span class="text-body-sm text-on-surface-variant">Follow</span>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">download</span></button>
              <button class="p-1 hover:bg-surface-container-low rounded"><span class="material-symbols-outlined text-body-md">content_copy</span></button>
            </div>
          </div>
          <div class="flex-1 bg-[#0b1c30] p-md font-mono text-code-sm code-scroll overflow-y-auto max-h-[600px]">
            <div class="space-y-1">
              <p v-for="(log, idx) in store.logEntries" :key="idx" class="text-outline-variant">
                {{ log.timestamp }} <span :class="levelColor(log.level)">[{{ log.level }}]</span> {{ log.message }}
              </p>
              <div class="w-1.5 h-4 bg-primary inline-block animate-pulse ml-1 align-middle"></div>
            </div>
          </div>
        </div>

        <!-- YAML View -->
        <div v-if="activeTab === 'yaml'" class="flex-1 grid grid-cols-2 h-full overflow-hidden">
          <div class="border-r border-outline-variant flex flex-col">
            <div class="p-2 bg-surface-container text-label-caps text-on-surface-variant text-center border-b border-outline-variant">LIVE CONFIGURATION</div>
            <div class="flex-1 bg-[#1a1c1e] p-md font-mono text-code-sm text-surface-variant overflow-auto">
              <pre>apiVersion: v1
kind: Pod
metadata:
  name: {{ pod.name }}
  namespace: {{ pod.namespace }}
  labels:
{{ Object.entries(pod.labels || {}).map(([k,v]) => `    ${k}: ${v}`).join('\n') }}
spec:
  containers:
  - name: {{ pod.containers?.[0] || 'main' }}
    image: {{ pod.image }}
    ports:
    - containerPort: 80
    resources:
      limits:
        cpu: "500m"
        memory: "512Mi"
      requests:
        cpu: "250m"
        memory: "256Mi"</pre>
            </div>
          </div>
          <div class="flex flex-col">
            <div class="p-2 bg-primary-container/10 text-label-caps text-primary text-center border-b border-outline-variant">DESIRED STATE (EDITABLE)</div>
            <div class="flex-1 bg-[#1a1c1e] p-md font-mono text-code-sm text-surface-variant overflow-auto">
              <pre>apiVersion: v1
kind: Pod
metadata:
  name: {{ pod.name }}
  namespace: {{ pod.namespace }}
  labels:
{{ Object.entries(pod.labels || {}).map(([k,v]) => `    ${k}: ${v}`).join('\n') }}
spec:
  containers:
  - name: {{ pod.containers?.[0] || 'main' }}
    image: {{ pod.image }}
    ports:
    - containerPort: 80
    resources:
      limits:
        cpu: "1000m"
        memory: "1Gi"
      requests:
        cpu: "500m"
        memory: "512Mi"</pre>
            </div>
          </div>
        </div>
        <div v-if="activeTab === 'yaml'" class="p-md bg-surface-container flex justify-end gap-md">
          <button class="px-md py-1.5 border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Discard</button>
          <button class="px-md py-1.5 bg-primary text-on-primary rounded-lg text-body-md font-semibold">Apply Changes</button>
        </div>

        <!-- Terminal View -->
        <div v-if="activeTab === 'terminal'" class="flex-1 bg-[#0b1c30] p-md font-mono text-code-sm code-scroll overflow-y-auto max-h-[600px]">
          <div class="text-outline-variant space-y-1">
            <p>$ kubectl exec -it {{ pod.name }} -n {{ pod.namespace }} -- /bin/sh</p>
            <p class="text-primary-container"># Connected to {{ pod.name }}</p>
            <p>$ ls /app</p>
            <p>config/  node_modules/  package.json  src/</p>
            <p>$ cat /app/package.json | head -5</p>
            <p>{</p>
            <p>  "name": "frontend-api",</p>
            <p>  "version": "2.4.1",</p>
            <p>  "main": "src/index.js"</p>
            <p>}</p>
            <p class="flex items-center">$ <span class="w-1.5 h-4 bg-primary inline-block animate-pulse ml-1"></span></p>
          </div>
        </div>

        <!-- Events View -->
        <div v-if="activeTab === 'events'" class="flex-1 p-lg overflow-y-auto max-h-[600px]">
          <div class="flex flex-col gap-md">
            <div v-for="(event, idx) in store.eventList" :key="idx" class="flex gap-md border-b border-outline-variant pb-md">
              <div class="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                :class="event.color === 'primary' ? 'bg-primary-container text-on-primary-container' : event.color === 'error' ? 'bg-error-container text-on-error-container' : 'bg-surface-container text-on-surface-variant'">
                <span class="material-symbols-outlined text-lg">{{ event.icon }}</span>
              </div>
              <div class="flex-1">
                <div class="flex justify-between items-start">
                  <h4 class="text-body-md font-semibold">{{ event.reason }}</h4>
                  <span class="font-mono text-code-sm text-on-surface-variant">{{ event.time }}</span>
                </div>
                <p class="text-body-sm text-on-surface-variant mt-xs">{{ event.message }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Sidebar -->
      <aside class="col-span-12 lg:col-span-3 flex flex-col gap-gutter">
        <!-- Resource Utilization -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Resource Utilization</h3>
          <div class="space-y-md">
            <ProgressBar :value="25" show-label label="CPU Usage" />
            <p class="font-mono text-code-sm text-on-surface-variant -mt-2">{{ pod.cpu }}</p>
            <ProgressBar :value="35" show-label label="Memory Usage" />
            <p class="font-mono text-code-sm text-on-surface-variant -mt-2">{{ pod.memory }}</p>
          </div>
        </div>

        <!-- Metadata -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Metadata</h3>
          <div class="space-y-lg">
            <div>
              <h4 class="text-label-caps text-on-surface-variant mb-2">LABELS</h4>
              <div class="flex flex-wrap gap-2">
                <span v-for="(val, key) in pod.labels" :key="key" class="px-2 py-1 bg-surface-container rounded text-body-sm border border-outline-variant">
                  {{ key }}: {{ val }}
                </span>
              </div>
            </div>
            <div>
              <h4 class="text-label-caps text-on-surface-variant mb-2">ANNOTATIONS</h4>
              <div class="text-body-sm bg-surface-container p-sm rounded border border-outline-variant font-mono text-code-sm text-on-surface-variant">
                <div v-for="(val, key) in pod.annotations" :key="key">{{ key }}: "{{ val }}"</div>
              </div>
            </div>
            <div>
              <h4 class="text-label-caps text-on-surface-variant mb-2">OWNER REFERENCES</h4>
              <div class="flex items-center gap-2 p-sm bg-surface-container-low rounded border border-outline-variant cursor-pointer hover:border-primary transition-colors">
                <span class="material-symbols-outlined text-primary">account_tree</span>
                <span class="text-body-sm font-medium">ReplicaSet/{{ pod.name }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Node Info -->
        <div class="bg-surface-container-lowest border border-outline-variant p-lg rounded-xl shadow-card">
          <h3 class="text-headline-sm mb-md">Node Placement</h3>
          <div class="flex items-center gap-3">
            <div class="p-2 bg-secondary/10 text-secondary rounded">
              <span class="material-symbols-outlined">dns</span>
            </div>
            <div>
              <p class="text-body-md font-semibold">{{ pod.node || 'Unscheduled' }}</p>
              <p class="text-body-sm text-on-surface-variant">{{ pod.ip || 'No IP assigned' }}</p>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>
