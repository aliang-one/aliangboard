<script setup>
// 平台登录页（Layer 1）：用户名/密码 → 平台 session → 跳转集群选择
// W3 Task 4(2026-09-07):已启用 MFA 者两步——密码步返 {mfaRequired,mfaTicket} → 二步表单
// (验证码/恢复码一框)→ POST /api/auth/login/mfa → 同形响应 {token,user,prefs} → 复用落地逻辑。
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { usePreferencesStore } from '@/stores/preferences'
import { safeRedirectPath } from '@/utils/safeRedirect'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const { t } = useI18n()

const form = ref({ username: '', password: '' })
const loading = ref(false)
const errorMessage = ref('')

// MFA 二步态:mfaRequired → 单输入框(6 位 TOTP 或任一恢复码);票据 5min 单次(读即删,
// 错码同样消费),401 一律回密码表单重走密码步取新票。
const mfaStep = ref(false)
const mfaTicket = ref('')
const mfaCode = ref('')

// 二步成功直写 store(裁决 4:响应与 login 同形):store.login 的副作用已在密码步完成
// (purgeSession/prefs),此处补齐 token/user/localStorage/prefs 四件套——与 store.login 保持同构。
function applyLogin(res) {
  authStore.token = res.token
  authStore.user = res.user
  localStorage.setItem('aliangboard.platform', res.token)
  usePreferencesStore().hydrateFromServer(res.prefs)
}

// 登录后落地(两步共用,2026-09-04 事故⑥起原样保留):redirect 回跳 > landingView 偏好 > 自动连集群。
async function landing() {
  // 登录回跳(2026-09-04 事故⑥):被 401 踢来时携带 ?redirect=(原路径+query),登录后原路
  // 返回——SSH 弹窗回到 /ssh-terminal-popup 同 sid 重建 WS,而非被吞进 /cluster。
  // 全量加载(非 router.push):弹窗页需完整启动流程(main.js 交接槽/路由守卫重跑)。
  // 复审 F5:仅显式携带 redirect 才回跳;无参数保持原 auto-connect 流(下方分支可达)。
  if (route.query.redirect) {
    window.location.assign(safeRedirectPath(route.query.redirect))
    return
  }
  // 落地页偏好(Wave1 §3.4):redirect > landingView > 自动连集群(现状)
  const landingView = usePreferencesStore().landingView
  if (landingView === 'workbench') { router.push('/workbench'); return }
  if (landingView === 'last') {
    const last = localStorage.getItem('aliangboard.lastView')
    if (last && last.startsWith('/') && !last.startsWith('/login')) { window.location.href = last; return }
  }
  // 尝试自动连接上次使用的集群；成功直接进集群，失败才跳选择页
  const auto = await authStore.tryAutoConnect()
  if (auto) {
    window.location.href = '/cluster'
  } else {
    router.push('/select-cluster')
  }
}

async function handleLogin() {
  errorMessage.value = ''
  // 客户端必填拦截(服务端 400 只有 toast 语义,这里直接用行内提示)
  const username = form.value.username.trim()
  const password = form.value.password
  if (!username || !password) { errorMessage.value = t('login.missingRequired'); return }
  loading.value = true
  try {
    const res = await authStore.login(username, password)
    // 已启用 MFA:响应无 token(store.login 会把 undefined 写进 localStorage)——立即清伪
    // token 防残留,转二步表单
    if (res?.mfaRequired) {
      authStore.token = ''
      authStore.user = null
      localStorage.removeItem('aliangboard.platform')
      mfaTicket.value = res.mfaTicket || ''
      mfaCode.value = ''
      errorMessage.value = ''
      mfaStep.value = true
      return
    }
    await landing()
  } catch (error) {
    errorMessage.value = error.message || t('login.loginFailed')
  } finally {
    loading.value = false
  }
}

async function handleMfaLogin() {
  const code = mfaCode.value.trim()
  if (!code) { errorMessage.value = t('login.mfaStepMissing'); return }
  const username = form.value.username.trim()
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await authApi.mfaLogin(username, mfaTicket.value, code)
    mfaStep.value = false
    applyLogin(res)
    await landing()
  } catch (error) {
    // 401 = 码错或票据无效;票据读即删(单次),同票重试必 401——回密码表单,重新登录取新票
    if (error?.status === 401) {
      errorMessage.value = t('login.mfaStepInvalid')
      mfaStep.value = false
      mfaTicket.value = ''
      mfaCode.value = ''
    } else {
      errorMessage.value = error.message || t('login.loginFailed')
    }
  } finally {
    loading.value = false
  }
}

function backToPassword() {
  mfaStep.value = false
  mfaTicket.value = ''
  mfaCode.value = ''
  errorMessage.value = ''
}
</script>

<template>
  <div class="min-h-screen bg-surface flex items-center justify-center p-md">
    <div class="w-full max-w-sm">
      <!-- Logo -->
      <div class="text-center mb-xl">
        <img src="/aliang-logo.svg" alt="AliangBoard" class="w-16 h-auto mx-auto" width="64" height="58" />
        <h1 class="text-display-md font-bold text-on-surface mt-md">{{ $t('login.title') }}</h1>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('login.subtitle') }}</p>
      </div>

      <!-- Login Form -->
      <div class="bg-surface-container-lowest rounded-xl border border-outline-variant p-xl shadow-card">
        <!-- MFA 二步:验证码/恢复码一框(单输入) -->
        <div v-if="mfaStep" class="flex flex-col gap-md">
          <div class="text-center">
            <span class="material-symbols-outlined text-primary text-3xl">phonelink_lock</span>
            <h2 class="text-headline-sm font-bold mt-xs">{{ $t('login.mfaStepTitle') }}</h2>
            <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('login.mfaStepHint') }}</p>
            <p class="text-body-xs text-on-surface-variant mt-xs font-medium">{{ form.username.trim() }}</p>
          </div>
          <input v-model="mfaCode" data-testid="mfa-step-input" type="text" inputmode="numeric" autocomplete="one-time-code"
            :placeholder="$t('login.mfaStepPlaceholder')" @keydown.enter="handleMfaLogin"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md tracking-widest text-center focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all" />
          <p v-if="errorMessage" class="text-body-sm text-error bg-error-container/10 rounded-lg px-md py-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-base">error</span>{{ errorMessage }}
          </p>
          <button data-testid="mfa-step-submit" @click="handleMfaLogin" :disabled="loading"
            class="w-full flex items-center justify-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50">
            <span v-if="loading" class="material-symbols-outlined animate-spin">progress_activity</span>
            <span v-else class="material-symbols-outlined">verified_user</span>
            {{ $t('login.mfaStepSubmit') }}
          </button>
          <button data-testid="mfa-step-back"
            class="text-body-sm text-on-surface-variant hover:underline"
            @click="backToPassword">{{ $t('login.mfaStepBack') }}</button>
        </div>

        <!-- 密码步(原表单) -->
        <div v-else class="flex flex-col gap-md">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('login.username') }}</label>
            <input v-model="form.username" type="text" autocomplete="username"
              class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all"
              placeholder="admin" @keydown.enter="handleLogin" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('login.password') }}</label>
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
            {{ loading ? $t('login.loggingIn') : $t('login.submit') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
