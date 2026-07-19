<script setup>
import { ref } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const store = useClusterStore()
const { applyYaml } = useResourceApply()
const expanded = ref(null)
function toggleExpand(name) { expanded.value = expanded.value === name ? null : name }
const yamlOf = (c) => store.generateYAML('ingressclass', c)
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[{ label: 'IngressClasses' }]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">IngressClasses</h2>
        <p class="text-on-surface-variant text-body-md mt-1">{{ store.ingressClassList.length }} 个 IngressClass — 定义可用的 Ingress 控制器</p>
      </div>
    </div>

    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Controller</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Default</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-20">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <template v-for="row in store.ingressClassList" :key="row.name">
            <tr class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary text-lg">language</span>
                  <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ row.controller }}</td>
              <td class="px-lg py-md">
                <span v-if="row.isDefault" class="flex items-center gap-xs text-primary"><span class="material-symbols-outlined text-lg">check_circle</span> Yes</span>
                <span v-else class="text-on-surface-variant">—</span>
              </td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
              <td class="px-lg py-md" @click.stop>
                <button @click="toggleExpand(row.name)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="查看 / 编辑 YAML">
                  <span class="material-symbols-outlined text-lg" :class="expanded === row.name ? 'rotate-180' : ''">expand_more</span>
                </button>
              </td>
            </tr>
            <tr v-if="expanded === row.name">
              <td colspan="5" class="px-lg py-md bg-surface-container-low">
                <YamlEditor :model-value="yamlOf(row)" :readonly="false" height="320px" @save="applyYaml" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>
</template>
