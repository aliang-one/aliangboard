<script setup>
import { useRoute } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'

const route = useRoute()
const store = useClusterStore()
store.setNamespace(route.params.namespace)
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Events' }
    ]" />
    <div class="mt-sm mb-lg">
      <h2 class="text-display-lg text-on-surface">Events</h2>
      <p class="text-on-surface-variant text-body-md mt-1">Recent events in namespace <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
    </div>

    <div v-if="store.nsEvents.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-14">Type</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Reason</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Message</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Time</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="(event, idx) in store.nsEvents" :key="idx" class="hover:bg-surface-container-low/50 transition-colors">
            <td class="px-lg py-md">
              <div class="w-8 h-8 rounded-full flex items-center justify-center"
                :class="{
                  'bg-primary-container text-on-primary-container': event.color === 'primary',
                  'bg-tertiary-fixed-dim text-on-tertiary-fixed': event.color === 'tertiary',
                  'bg-error-container text-on-error-container': event.color === 'error',
                  'bg-surface-container text-on-surface-variant': event.color === 'surface',
                }">
                <span class="material-symbols-outlined text-lg">{{ event.icon }}</span>
              </div>
            </td>
            <td class="px-lg py-md">
              <span class="font-semibold text-on-surface text-body-md">{{ event.reason }}</span>
              <span class="ml-sm px-2 py-0.5 rounded text-label-caps" :class="event.type === 'warning' ? 'bg-tertiary-container/10 text-tertiary-container' : 'bg-primary-container/10 text-primary'">{{ event.type }}</span>
            </td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant max-w-md">{{ event.message }}</td>
            <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant whitespace-nowrap">{{ event.time }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">event_available</span>
      <p class="text-on-surface-variant mt-md">No recent events in this namespace</p>
    </div>
  </section>
</template>
