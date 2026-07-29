<script setup>
// 资源归属拓扑：沿 ownerReferences 向上解析（Pod→ReplicaSet→Deployment…），根在上、叶在下。
import { ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { resourceTreeApi } from '@/api/client'

const props = defineProps({
  namespace: { type: String, default: '' },
  kind: { type: String, default: '' },
  name: { type: String, default: '' },
  apiVersion: { type: String, default: 'v1' },
})

const router = useRouter()
const chain = ref([])   // root … leaf
const loading = ref(false)
const error = ref('')

async function load() {
  if (!props.namespace || !props.kind || !props.name) return
  loading.value = true
  error.value = ''
  try {
    const tree = await resourceTreeApi.get({ namespace: props.namespace, kind: props.kind, name: props.name, apiVersion: props.apiVersion })
    const arr = []
    let cur = tree
    while (cur) { arr.push(cur); cur = cur.owner }
    chain.value = arr.reverse()
  } catch (e) {
    error.value = e.message || '解析归属链失败'
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => [props.kind, props.name, props.namespace], load)

const WL = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']
function go(node) {
  if (WL.includes(node.kind)) router.push({ name: 'NsWorkloadDetail', params: { namespace: node.namespace, type: node.kind.toLowerCase(), name: node.name } })
  else if (node.kind === 'Pod') router.push({ name: 'NsPodDetail', params: { namespace: node.namespace, name: node.name } })
  else if (node.kind === 'Service') router.push({ name: 'NsServiceDetail', params: { namespace: node.namespace, name: node.name } })
}
</script>

<template>
  <div>
    <p v-if="loading" class="text-body-sm text-on-surface-variant">解析归属链…</p>
    <p v-else-if="error" class="text-body-sm text-error">{{ error }}</p>
    <ol v-else class="relative border-l border-outline-variant/40 ml-xs pl-md space-y-sm">
      <li v-for="(node, i) in chain" :key="i" class="relative">
        <span class="absolute -left-[1.40rem] top-0.5 material-symbols-outlined text-base"
          :class="i === chain.length - 1 ? 'text-primary' : 'text-on-surface-variant'">{{ i === chain.length - 1 ? 'adjust' : 'account_tree' }}</span>
        <button v-if="i < chain.length - 1" @click="go(node)" class="font-mono text-code-sm text-on-surface hover:text-primary transition-colors">
          <span class="text-on-surface-variant">{{ node.kind }}/</span>{{ node.name }}
        </button>
        <span v-else class="font-mono text-code-sm">
          <span class="text-on-surface-variant">{{ node.kind }}/</span><span class="text-primary font-semibold">{{ node.name }}</span>
        </span>
        <span v-if="node.error" class="block text-body-xs text-error">{{ node.error }}</span>
      </li>
    </ol>
  </div>
</template>
