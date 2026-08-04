<script setup>
// 平台登录页（Layer 1）：用户名/密码 → 平台 session → 跳转集群选择
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()

const form = ref({ username: '', password: '' })
const loading = ref(false)
const errorMessage = ref('')

async function handleLogin() {
  loading.value = true
  errorMessage.value = ''
  try {
    await authStore.login(form.value.username, form.value.password)
    // 尝试自动连接上次使用的集群；成功直接进集群，失败才跳选择页
    const auto = await authStore.tryAutoConnect()
    if (auto) {
      window.location.href = '/cluster'
    } else {
      router.push('/select-cluster')
    }
  } catch (error) {
    errorMessage.value = error.message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-surface flex items-center justify-center p-md">
    <div class="w-full max-w-sm">
      <!-- Logo -->
      <div class="text-center mb-xl">
        <div class="w-16 h-16 rounded-2xl bg-primary-container/20 flex items-center justify-center mx-auto">
          <span class="material-symbols-outlined text-primary text-4xl">kubernetes</span>
        </div>
        <h1 class="text-display-md font-bold text-on-surface mt-md">AliangBoard</h1>
        <p class="text-body-sm text-on-surface-variant mt-xs">Kubernetes 管理平台</p>
      </div>

      <!-- Login Form -->
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant p-xl shadow-card">
        <div class="flex flex-col gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">用户名</label>
            <input v-model="form.username" type="text" autocomplete="username"
              class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all"
              placeholder="admin" @keydown.enter="handleLogin" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">密码</label>
            <input v-model="form.password" type="password" autocomplete="current-password"
              class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all"
              placeholder="••••••••" @keydown.enter="handleLogin" />
          </div>
          <p v-if="errorMessage" class="text-body-sm text-error bg-error-container/10 rounded-lg px-md py-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-base">error</span>{{ errorMessage }}
          </p>
          <button @click="handleLogin" :disabled="loading"
            class="w-full flex items-center justify-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50">
            <span v-if="loading" class="material-symbols-outlined animate-spin">progress_activity</span>
            <span v-else class="material-symbols-outlined">login</span>
            {{ loading ? '登录中…' : '登录' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
