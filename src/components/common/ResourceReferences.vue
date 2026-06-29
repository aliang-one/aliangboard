<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import StatusChip from '@/components/common/StatusChip.vue'

const props = defineProps({
  // 被引用的资源类型：'ConfigMap' | 'Secret'
  kind: { type: String, required: true },
  // 被引用的资源名称
  name: { type: String, required: true },
})

const route = useRoute()
const router = useRouter()
const store = useClusterStore()

const references = computed(() =>
  store.getResourceReferences(props.kind, props.name, route.params.namespace)
)

// 按引用方式分组统计
const refTypeStats = computed(() => {
  const stats = { envFrom: 0, env: 0, volume: 0, imagePullSecrets: 0 }
  references.value.forEach(r => { stats[r.reference.type] = (stats[r.reference.type] || 0) + 1 })
  return stats
})

const refTypeMeta = {
  envFrom: { label: 'EnvFrom', icon: 'code', desc: '整体注入为环境变量', color: 'bg-primary-container/10 text-primary border-primary/20' },
  env: { label: 'Env', icon: 'terminal', desc: '单个 Key 作为环境变量', color: 'bg-tertiary-container/10 text-tertiary border-tertiary/20' },
  volume: { label: 'Volume', icon: 'folder', desc: '作为数据卷挂载', color: 'bg-secondary-container/10 text-secondary border-secondary/20' },
  imagePullSecrets: { label: 'Image Pull', icon: 'key', desc: '镜像拉取凭证', color: 'bg-surface-container text-on-surface-variant border-outline-variant' },
}

function typeMeta(type) {
  return refTypeMeta[type] || { label: type, icon: 'link', desc: '', color: 'bg-surface-container text-on-surface-variant border-outline-variant' }
}

function goToWorkload(wl) {
  router.push({
    name: 'NsWorkloadDetail',
    params: { namespace: route.params.namespace, type: wl.type, name: wl.name },
  })
}
</script>

<template>
  <div>
    <!-- 影响摘要 -->
    <div v-if="references.length" class="grid grid-cols-1 lg:grid-cols-12 gap-lg mb-lg">
      <!-- 左侧：受影响的 Workload 列表 -->
      <div class="lg:col-span-8">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
          <div class="px-lg py-md border-b border-outline-variant bg-surface-container-low flex items-center justify-between">
            <h3 class="text-headline-sm">引用此 {{ kind }} 的 Workload ({{ references.length }})</h3>
            <span class="text-body-sm text-on-surface-variant">修改 {{ kind }} 将影响这些服务</span>
          </div>
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-surface-container-low border-b border-outline-variant">
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Workload</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">引用方式</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">详情</th>
                <th class="px-lg py-md text-label-caps text-on-surface-variant">状态</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/30">
              <tr v-for="(ref, idx) in references" :key="idx" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="goToWorkload(ref.workload)">
                <td class="px-lg py-md">
                  <div class="flex items-center gap-sm">
                    <span class="material-symbols-outlined text-secondary text-lg">apps</span>
                    <span class="font-mono text-code-sm font-semibold text-on-surface">{{ ref.workload.name }}</span>
                  </div>
                </td>
                <td class="px-lg py-md">
                  <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">{{ ref.workload.type }}</span>
                </td>
                <td class="px-lg py-md">
                  <div class="flex items-center gap-sm">
                    <span class="material-symbols-outlined text-base" :class="typeMeta(ref.reference.type).color.split(' ')[1]">{{ typeMeta(ref.reference.type).icon }}</span>
                    <span class="text-body-sm font-medium text-on-surface">{{ typeMeta(ref.reference.type).label }}</span>
                  </div>
                </td>
                <td class="px-lg py-md text-body-sm text-on-surface-variant">
                  <span v-if="ref.reference.type === 'volume'" class="font-mono text-code-sm text-primary">{{ ref.reference.mountPath }}</span>
                  <span v-else-if="ref.reference.type === 'env'" class="font-mono text-code-sm">
                    <span class="text-primary">{{ ref.reference.envName }}</span>
                    <span class="text-on-surface-variant"> ← {{ kind }}.{{ ref.reference.key }}</span>
                  </span>
                  <span v-else-if="ref.reference.type === 'envFrom'">所有 Key → 环境变量</span>
                  <span v-else-if="ref.reference.type === 'imagePullSecrets'">拉取镜像时认证</span>
                  <span v-else>-</span>
                </td>
                <td class="px-lg py-md"><StatusChip :status="ref.workload.status" size="sm" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 右侧：引用方式统计 -->
      <div class="lg:col-span-4 flex flex-col gap-lg">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">引用方式分布</h3>
          <div class="flex flex-col gap-md">
            <div v-for="(meta, type) in refTypeMeta" :key="type" class="flex items-center justify-between p-sm rounded-lg" :class="refTypeStats[type] ? meta.color : 'opacity-40'">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-lg">{{ meta.icon }}</span>
                <div>
                  <p class="text-body-sm font-semibold">{{ meta.label }}</p>
                  <p class="text-body-xs opacity-70">{{ meta.desc }}</p>
                </div>
              </div>
              <span class="text-body-lg font-bold">{{ refTypeStats[type] || 0 }}</span>
            </div>
          </div>
        </div>

        <!-- 影响提示 -->
        <div class="bg-tertiary-container/5 border border-tertiary-container/20 rounded-xl p-lg">
          <div class="flex gap-sm">
            <span class="material-symbols-outlined text-tertiary-container">info</span>
            <div>
              <p class="text-body-sm font-semibold text-on-surface mb-xs">修改影响提示</p>
              <p class="text-body-sm text-on-surface-variant">此 {{ kind }} 被 <span class="font-semibold text-tertiary-container">{{ references.length }}</span> 个 Workload 引用。修改内容后，引用它的 Pod 需要 <span class="font-semibold">重启</span> 才能生效（envFrom/env）或会自动反映（volume 挂载的配置文件，取决于应用是否热加载）。</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 无引用 -->
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">link_off</span>
      <h3 class="text-headline-sm text-on-surface mt-md">暂无引用</h3>
      <p class="text-body-md text-on-surface-variant mt-sm">当前命名空间内没有 Workload 引用此 {{ kind }}</p>
      <p class="text-body-sm text-on-surface-variant mt-xs opacity-70">这意味着此资源可能是孤立的，或仅被外部工具/Pod 直接引用</p>
    </div>
  </div>
</template>
