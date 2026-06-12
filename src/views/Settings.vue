<script setup>
import { ref } from 'vue'
import { useClusterStore } from '@/stores/cluster'

const store = useClusterStore()
const activeTab = ref('general')

const tabs = [
  { key: 'general', label: 'General', icon: 'info' },
  { key: 'components', label: 'Components', icon: 'extension' },
  { key: 'api', label: 'API Server', icon: 'api' },
  { key: 'customcols', label: 'Custom Columns', icon: 'view_column' },
]

const components = [
  { name: 'etcd', status: 'Healthy', endpoint: '10.0.1.10:2379' },
  { name: 'kube-apiserver', status: 'Healthy', endpoint: '10.0.1.10:6443' },
  { name: 'kube-controller-manager', status: 'Healthy', endpoint: '10.0.1.10:10257' },
  { name: 'kube-scheduler', status: 'Healthy', endpoint: '10.0.1.10:10259' },
  { name: 'coredns', status: 'Healthy', endpoint: '10.96.0.10:53' },
  { name: 'kube-proxy', status: 'Healthy', endpoint: '10.0.1.10:10256' },
]
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Settings</h2>
        <p class="text-on-surface-variant text-body-md mt-1">Cluster configuration, component health, and display preferences.</p>
      </div>
    </div>

    <div class="grid grid-cols-12 gap-gutter">
      <!-- Sidebar Tabs -->
      <div class="col-span-12 lg:col-span-3">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-sm shadow-card">
          <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
            class="w-full flex items-center gap-md px-md py-sm rounded-lg text-body-md transition-all"
            :class="activeTab === tab.key ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'"
          >
            <span class="material-symbols-outlined">{{ tab.icon }}</span>
            {{ tab.label }}
          </button>
        </div>
      </div>

      <!-- Content -->
      <div class="col-span-12 lg:col-span-9">
        <!-- General -->
        <div v-if="activeTab === 'general'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-md mb-lg">Cluster Information</h3>
          <div class="space-y-md">
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-md text-on-surface-variant">Cluster Name</span>
              <span class="text-body-md font-medium">{{ store.cluster.name }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-md text-on-surface-variant">Kubernetes Version</span>
              <span class="font-mono text-code-sm">{{ store.cluster.version }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-md text-on-surface-variant">API Server</span>
              <span class="font-mono text-code-sm text-primary">{{ store.cluster.apiServer }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-md text-on-surface-variant">Status</span>
              <span class="flex items-center gap-sm text-primary font-medium">
                <span class="w-2 h-2 bg-primary rounded-full animate-pulse-status"></span> {{ store.cluster.status }}
              </span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-md text-on-surface-variant">Nodes</span>
              <span class="font-medium">{{ store.cluster.nodeCount }}</span>
            </div>
            <div class="flex justify-between py-sm">
              <span class="text-body-md text-on-surface-variant">Pods</span>
              <span class="font-medium">{{ store.cluster.podCount }}</span>
            </div>
          </div>
        </div>

        <!-- Components -->
        <div v-if="activeTab === 'components'" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
          <div class="p-lg"><h3 class="text-headline-md">Component Status</h3></div>
          <table class="w-full text-left">
            <thead>
              <tr class="bg-surface-container-low border-y border-outline-variant">
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Component</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Endpoint</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/30">
              <tr v-for="c in components" :key="c.name" class="hover:bg-surface-container-low/50">
                <td class="px-lg py-md font-medium text-body-md">{{ c.name }}</td>
                <td class="px-lg py-md">
                  <span class="flex items-center gap-sm">
                    <span class="w-2 h-2 bg-primary rounded-full"></span>
                    <span class="text-body-sm text-primary font-medium">{{ c.status }}</span>
                  </span>
                </td>
                <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ c.endpoint }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- API Server -->
        <div v-if="activeTab === 'api'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-md mb-lg">API Server Configuration</h3>
          <div class="space-y-md">
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-md text-on-surface-variant">Endpoint</span>
              <span class="font-mono text-code-sm text-primary">{{ store.cluster.apiServer }}:6443</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-md text-on-surface-variant">Authentication</span>
              <span class="text-body-md">TLS Client Certificates</span>
            </div>
            <div class="flex justify-between py-sm">
              <span class="text-body-md text-on-surface-variant">API Version</span>
              <span class="font-mono text-code-sm">v1</span>
            </div>
          </div>
        </div>

        <!-- Custom Columns -->
        <div v-if="activeTab === 'customcols'" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-md mb-lg">Custom Display Columns</h3>
          <p class="text-body-md text-on-surface-variant mb-lg">Configure which columns are shown in resource tables.</p>
          <div class="space-y-md">
            <div v-for="res in ['Workloads', 'Pods', 'Services', 'Nodes']" :key="res" class="flex items-center justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-md font-medium">{{ res }}</span>
              <button class="px-md py-sm text-primary text-body-sm font-medium hover:bg-primary-container/10 rounded-lg">Edit Columns</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
