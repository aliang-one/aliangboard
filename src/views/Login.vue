<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, saveSession } from '@/api/client'
import { useClusterStore } from '@/stores/cluster'

const router = useRouter()
const store = useClusterStore()

const form = ref({
  apiServer: 'https://api.prod-cluster.kubezen.io:6443',
  token: '',
  username: '',
  password: '',
  kubeconfig: '',
  authMethod: 'token', // 'token' | 'basic' | 'kubeconfig'
  insecure: false,
  remember: true,
})

const loading = ref(false)
const errorMessage = ref('')

async function handleLogin() {
  loading.value = true
  errorMessage.value = ''
  try {
    const result = await api.connect({
      apiServer: form.value.apiServer,
      authMethod: form.value.authMethod,
      token: form.value.token,
      username: form.value.username,
      password: form.value.password,
      kubeconfig: form.value.kubeconfig,
      insecure: form.value.insecure,
    })
    saveSession(result.token, form.value.remember)
    store.setConnectedCluster(result.cluster)
    await store.hydrateCoreResources()
    router.push('/cluster')
  } catch (error) {
    errorMessage.value = error.message || '连接集群失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-surface flex items-center justify-center p-md">
    <!-- Background decoration -->
    <div class="fixed inset-0 overflow-hidden pointer-events-none">
      <div class="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-primary/5 blur-3xl"></div>
      <div class="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-secondary/5 blur-3xl"></div>
    </div>

    <div class="w-full max-w-md relative z-10">
      <!-- Logo -->
      <div class="text-center mb-xl">
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary shadow-card mb-lg">
          <span class="material-symbols-outlined text-on-primary text-3xl filled">hub</span>
        </div>
        <h1 class="text-display-lg text-on-surface">AliangBoard</h1>
        <p class="text-body-lg text-on-surface-variant mt-sm">Kubernetes 管理面板</p>
      </div>

      <!-- Login Card -->
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant shadow-dropdown p-xl">
        <h2 class="text-headline-md mb-lg">连接集群</h2>

        <!-- Auth Method Tabs -->
        <div class="flex border-b border-outline-variant mb-lg">
          <button
            @click="form.authMethod = 'token'"
            class="flex-1 py-sm text-body-md font-medium border-b-2 transition-colors"
            :class="form.authMethod === 'token' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant'"
          >
            <span class="material-symbols-outlined text-sm align-middle mr-1">key</span> Token
          </button>
          <button
            @click="form.authMethod = 'basic'"
            class="flex-1 py-sm text-body-md font-medium border-b-2 transition-colors"
            :class="form.authMethod === 'basic' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant'"
          >
            <span class="material-symbols-outlined text-sm align-middle mr-1">person</span> 账号密码
          </button>
          <button
            @click="form.authMethod = 'kubeconfig'"
            class="flex-1 py-sm text-body-md font-medium border-b-2 transition-colors"
            :class="form.authMethod === 'kubeconfig' ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant'"
          >
            <span class="material-symbols-outlined text-sm align-middle mr-1">description</span> kubeconfig
          </button>
        </div>

        <!-- API Server（token / basic 需手填；kubeconfig 模式由文件解析） -->
        <div v-if="form.authMethod !== 'kubeconfig'" class="mb-md">
          <label class="text-label-caps text-on-surface-variant block mb-xs">API Server 地址</label>
          <div class="relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">language</span>
            <input
              v-model="form.apiServer"
              class="w-full bg-surface-container-low border border-outline-variant rounded-lg pl-10 pr-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary transition-all"
              placeholder="https://kubernetes.default.svc:6443"
            />
          </div>
        </div>

        <!-- Token Auth -->
        <template v-if="form.authMethod === 'token'">
          <div class="mb-lg">
            <label class="text-label-caps text-on-surface-variant block mb-xs">Bearer Token</label>
            <textarea
              v-model="form.token"
              class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary transition-all h-24 resize-none font-mono text-code-sm"
              placeholder="粘贴您的 Kubernetes Token..."
            ></textarea>
            <p class="text-body-sm text-on-surface-variant mt-xs flex items-center gap-xs">
              <span class="material-symbols-outlined text-sm">info</span>
              可通过 <code class="bg-surface-container px-1 rounded">kubectl get secrets</code> 获取 Token
            </p>
          </div>
        </template>

        <!-- Basic Auth -->
        <template v-if="form.authMethod === 'basic'">
          <div class="mb-md">
            <label class="text-label-caps text-on-surface-variant block mb-xs">用户名</label>
            <div class="relative">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">person</span>
              <input v-model="form.username" class="w-full bg-surface-container-low border border-outline-variant rounded-lg pl-10 pr-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary" placeholder="admin" />
            </div>
          </div>
          <div class="mb-lg">
            <label class="text-label-caps text-on-surface-variant block mb-xs">密码</label>
            <div class="relative">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">lock</span>
              <input v-model="form.password" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg pl-10 pr-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary" placeholder="••••••••" />
            </div>
          </div>
        </template>

        <!-- Kubeconfig Auth -->
        <template v-if="form.authMethod === 'kubeconfig'">
          <div class="mb-md">
            <label class="text-label-caps text-on-surface-variant block mb-xs">粘贴 kubeconfig 内容</label>
            <textarea
              v-model="form.kubeconfig"
              class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary transition-all h-32 resize-none font-mono text-code-sm"
              placeholder="apiVersion: v1&#10;kind: Config&#10;clusters:&#10;- cluster:&#10;    server: https://...&#10;    certificate-authority-data: ...&#10;users:&#10;- user:&#10;    client-certificate-data: ...&#10;    client-key-data: ..."
            ></textarea>
            <p class="text-body-sm text-on-surface-variant mt-xs flex items-center gap-xs">
              <span class="material-symbols-outlined text-sm">info</span>
              直接粘贴 <code class="bg-surface-container px-1 rounded">~/.kube/config</code> 全文；server / CA / 客户端证书自动解析
            </p>
          </div>
        </template>

        <!-- 跳过 TLS 校验（自签集群 / token|basic 模式常用） -->
        <label v-if="form.authMethod !== 'kubeconfig'" class="flex items-center gap-sm mb-md cursor-pointer">
          <input v-model="form.insecure" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
          <span class="text-body-sm text-on-surface-variant">跳过 TLS 证书校验（自签集群）</span>
        </label>

        <div v-if="errorMessage" class="mb-md rounded-lg border border-error/30 bg-error-container/10 px-md py-sm text-body-sm text-error">
          {{ errorMessage }}
        </div>

        <!-- Remember -->
        <label class="flex items-center gap-sm mb-lg cursor-pointer">
          <input v-model="form.remember" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
          <span class="text-body-md text-on-surface-variant">记住连接信息</span>
        </label>

        <!-- Login Button -->
        <button
          @click="handleLogin"
          :disabled="loading"
          class="w-full py-sm bg-primary text-on-primary rounded-lg font-semibold shadow-sm hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-sm disabled:opacity-50"
        >
          <span v-if="loading" class="material-symbols-outlined animate-spin">progress_activity</span>
          <span v-else class="material-symbols-outlined">login</span>
          {{ loading ? '连接中...' : '连接集群' }}
        </button>
      </div>

      <!-- Footer -->
      <div class="text-center mt-lg">
        <p class="text-body-sm text-on-surface-variant">
          <span class="material-symbols-outlined text-sm align-middle">info</span>
          AliangBoard v1.0.0 · 支持 Kubernetes 1.24+
        </p>
      </div>
    </div>
  </div>
</template>
