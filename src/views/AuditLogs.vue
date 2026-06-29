<script setup>
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'

const store = useClusterStore()

const userFilter = ref('All Users')
const verbFilter = ref('All')
const searchQuery = ref('')

// 从 auditLogList 提取去重的用户列表
const userList = computed(() => {
  const users = [...new Set(store.auditLogList.map(l => l.user))]
  return ['All Users', ...users]
})

// verb 颜色 + 图标映射
const verbMeta = {
  create: { icon: 'add_circle', color: 'bg-primary-container/10 text-primary' },
  update: { icon: 'edit', color: 'bg-tertiary-container/10 text-tertiary-container' },
  delete: { icon: 'delete', color: 'bg-error-container/10 text-error' },
  patch: { icon: 'build', color: 'bg-secondary-container/10 text-secondary' },
  get: { icon: 'search', color: 'bg-surface-container text-on-surface-variant' },
}

// 操作类型筛选按钮颜色（选中态）
const verbButtonColor = {
  create: 'bg-primary text-on-primary border-primary',
  update: 'bg-tertiary text-on-tertiary border-tertiary',
  delete: 'bg-error text-on-error border-error',
  patch: 'bg-secondary text-on-secondary border-secondary',
  get: 'bg-surface-container-high text-on-surface border-surface-container-high',
}

const verbOptions = ['All', 'create', 'update', 'delete', 'patch']

const filtered = computed(() => {
  let list = store.auditLogList
  if (userFilter.value !== 'All Users') list = list.filter(l => l.user === userFilter.value)
  if (verbFilter.value !== 'All') list = list.filter(l => l.verb === verbFilter.value)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) list = list.filter(l => (l.user || '').toLowerCase().includes(q) || (l.resource || '').toLowerCase().includes(q))
  return list
})

// 统计：今日操作总数 + create / update / delete 数
const stats = computed(() => {
  const list = store.auditLogList
  return {
    total: list.length,
    create: list.filter(l => l.verb === 'create').length,
    update: list.filter(l => l.verb === 'update').length,
    delete: list.filter(l => l.verb === 'delete').length,
  }
})

// HTTP 状态码 badge 颜色
function codeClass(code) {
  if (code >= 200 && code < 300) return 'bg-primary-container/10 text-primary'
  if (code >= 300 && code < 400) return 'bg-tertiary-container/10 text-tertiary-container'
  if (code >= 400 && code < 500) return 'bg-error-container/10 text-error'
  if (code >= 500) return 'bg-error text-on-error'
  return 'bg-surface-container text-on-surface-variant'
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: 'Cluster', route: '/cluster' },
      { label: 'Audit Logs' }
    ]" />

    <!-- 标题区 -->
    <div class="flex justify-between items-end mb-lg">
      <div>
        <h2 class="text-headline-sm text-on-surface">审计日志 <span class="text-on-surface-variant font-normal">· {{ store.auditLogList.length }}</span></h2>
        <p class="text-on-surface-variant text-body-md mt-1">记录用户对集群资源的操作</p>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-md mb-lg">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-md">
        <div class="flex items-center gap-sm text-on-surface-variant mb-xs">
          <span class="material-symbols-outlined text-lg">history</span>
          <span class="text-label-caps">今日操作</span>
        </div>
        <p class="text-headline-sm text-on-surface font-semibold">{{ stats.total }}</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-md">
        <div class="flex items-center gap-sm text-primary mb-xs">
          <span class="material-symbols-outlined text-lg">add_circle</span>
          <span class="text-label-caps">创建</span>
        </div>
        <p class="text-headline-sm text-primary font-semibold">{{ stats.create }}</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-md">
        <div class="flex items-center gap-sm text-tertiary-container mb-xs">
          <span class="material-symbols-outlined text-lg">edit</span>
          <span class="text-label-caps">更新</span>
        </div>
        <p class="text-headline-sm text-tertiary-container font-semibold">{{ stats.update }}</p>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-md">
        <div class="flex items-center gap-sm text-error mb-xs">
          <span class="material-symbols-outlined text-lg">delete</span>
          <span class="text-label-caps">删除</span>
        </div>
        <p class="text-headline-sm text-error font-semibold">{{ stats.delete }}</p>
      </div>
    </div>

    <!-- 筛选区 -->
    <div class="flex flex-wrap items-center gap-md mb-lg">
      <!-- 用户筛选下拉 -->
      <div class="relative">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">person</span>
        <select v-model="userFilter" class="appearance-none bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-lg py-sm text-body-md text-on-surface focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all min-w-[180px]">
          <option v-for="u in userList" :key="u" :value="u">{{ u }}</option>
        </select>
        <span class="material-symbols-outlined absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">expand_more</span>
      </div>

      <!-- 操作类型筛选按钮组 -->
      <div class="flex gap-xs flex-wrap">
        <button v-for="opt in verbOptions" :key="opt" @click="verbFilter = opt"
          class="px-md py-xs rounded-full text-body-sm font-medium border transition-all flex items-center gap-1 capitalize"
          :class="verbFilter === opt
            ? (opt === 'All' ? 'bg-primary text-on-primary border-primary' : verbButtonColor[opt])
            : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:border-primary'">
          <span v-if="opt !== 'All'" class="material-symbols-outlined text-base">{{ verbMeta[opt].icon }}</span>
          {{ opt === 'All' ? '全部' : opt }}
        </button>
      </div>

      <!-- 搜索框 -->
      <div class="relative flex-1 min-w-[200px] max-w-md ml-auto">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="搜索用户或资源..." />
        <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>

      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ store.auditLogList.length }}</span>
    </div>

    <!-- 日志表格 -->
    <div v-if="filtered.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="bg-surface-container-low border-b border-outline-variant">
              <th class="px-lg py-md text-label-caps text-on-surface-variant">User</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Verb</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Resource</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Namespace</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">IP</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Code</th>
              <th class="px-lg py-md text-label-caps text-on-surface-variant">Time</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/30">
            <tr v-for="(log, idx) in filtered" :key="idx" class="hover:bg-surface-container-low/50 transition-colors">
              <!-- User -->
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <div class="w-7 h-7 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant shrink-0">
                    <span class="material-symbols-outlined text-base">person</span>
                  </div>
                  <span class="text-body-sm text-on-surface font-medium">{{ log.user }}</span>
                </div>
              </td>
              <!-- Verb badge -->
              <td class="px-lg py-md">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-label-caps capitalize" :class="verbMeta[log.verb].color">
                  <span class="material-symbols-outlined text-base">{{ verbMeta[log.verb].icon }}</span>
                  {{ log.verb }}
                </span>
              </td>
              <!-- Resource -->
              <td class="px-lg py-md font-mono text-code-sm text-on-surface whitespace-nowrap">{{ log.resource }}</td>
              <!-- Namespace -->
              <td class="px-lg py-md">
                <span v-if="log.namespace" class="px-2 py-0.5 bg-surface-container rounded-full text-label-caps text-on-surface-variant border border-outline-variant">{{ log.namespace }}</span>
                <span v-else class="text-on-surface-variant text-body-sm">—</span>
              </td>
              <!-- IP -->
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant whitespace-nowrap">{{ log.ip }}</td>
              <!-- Code -->
              <td class="px-lg py-md">
                <span class="inline-flex items-center px-2 py-0.5 rounded font-mono text-code-sm font-semibold" :class="codeClass(log.code)">{{ log.code }}</span>
              </td>
              <!-- Time -->
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant whitespace-nowrap">{{ log.time }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">manage_history</span>
      <p class="text-on-surface-variant mt-md">没有匹配的审计日志记录</p>
    </div>
  </section>
</template>
