<script setup>
// 用户中心(2026-08-29 用户中心设计 §2.3):资料/安全/偏好三卡。平台层页面
// (requiresCluster:false,无集群也能进);仅头像菜单进入,侧边栏不加入口。
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { usePreferencesStore } from '@/stores/preferences'
import { notify } from '@/composables/useToast'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { uaSummary } from '@/utils/uaSummary'

const { t } = useI18n()
const authStore = useAuthStore()
const prefs = usePreferencesStore()

const user = computed(() => authStore.user || {})
const createdAtText = computed(() => (user.value.createdAt ? new Date(user.value.createdAt).toLocaleDateString() : '—'))
const initial = computed(() => (user.value.displayName || user.value.username || 'U').charAt(0).toUpperCase())

// === 资料卡 ===
const displayName = ref('')
const savingName = ref(false)
onMounted(() => { displayName.value = user.value.displayName || ''; loadSessions() })
async function saveDisplayName() {
  savingName.value = true
  try {
    const res = await authApi.updateMe({ displayName: displayName.value })
    authStore.user = { ...authStore.user, ...res.user }
    notify('success', t('userCenter.profileSaved'))
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
  finally { savingName.value = false }
}

// === 安全卡:改密 ===
const pwdForm = ref({ current: '', next: '', confirm: '' })
const pwdErrors = ref({})
const pwdLoading = ref(false)
async function changePassword() {
  const errs = {}
  if (!pwdForm.value.current) errs.current = true
  if (!pwdForm.value.next || pwdForm.value.next.length < 8) errs.next = true
  if (pwdForm.value.next !== pwdForm.value.confirm) errs.confirm = true
  pwdErrors.value = errs
  if (Object.keys(errs).length) return
  pwdLoading.value = true
  try {
    const res = await authApi.changePassword(pwdForm.value.current, pwdForm.value.next)
    pwdForm.value = { current: '', next: '', confirm: '' }
    notify('success', t('userCenter.passwordChanged', { n: res.revoked ?? 0 }))
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
  finally { pwdLoading.value = false }
}

// === 安全卡:会话 ===
const sessions = ref([])
const sessionsLoading = ref(false)
const revokeTarget = ref(null)          // {fingerprint} 或 'others'
const showRevokeConfirm = ref(false)
async function loadSessions() {
  sessionsLoading.value = true
  try { sessions.value = (await authApi.listSessions()).sessions || [] }
  catch { /* 会话列表失败不阻塞页面 */ }
  finally { sessionsLoading.value = false }
}
function askRevoke(s) { revokeTarget.value = s; showRevokeConfirm.value = true }
function askRevokeOthers() { revokeTarget.value = { fingerprint: 'others' }; showRevokeConfirm.value = true }
async function doRevoke() {
  const target = revokeTarget.value
  showRevokeConfirm.value = false
  if (!target) return
  try {
    if (target.fingerprint === 'others') await authApi.revokeOtherSessions()
    else await authApi.revokeSession(target.fingerprint)
    notify('success', t('common.success'))
    loadSessions()
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
}
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '—' }

// === 偏好卡 ===
const langOptions = [{ v: 'zh', key: 'userCenter.langZh' }, { v: 'en', key: 'userCenter.langEn' }]
const themeOptions = [{ v: 'light', icon: 'light_mode', key: 'userCenter.themeLight' }, { v: 'dark', icon: 'dark_mode', key: 'userCenter.themeDark' }, { v: 'system', icon: 'contrast', key: 'userCenter.themeSystem' }]
</script>

<template>
  <section class="animate-fade-in p-md max-w-3xl mx-auto flex flex-col gap-md">
    <div><h2 class="text-headline-lg font-bold text-on-surface">{{ $t('userCenter.title') }}</h2>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('userCenter.subtitle') }}</p></div>

    <!-- 资料卡 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
      <div class="flex items-center gap-md mb-md">
        <div class="w-14 h-14 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-headline-lg font-bold">{{ initial }}</div>
        <div class="min-w-0">
          <div class="flex items-center gap-sm">
            <p class="text-body-lg font-semibold truncate">{{ user.displayName || user.username }}</p>
            <span class="px-1.5 py-0.5 rounded text-body-xs font-medium" :class="user.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant'">{{ user.role }}</span>
          </div>
          <p class="text-body-sm text-on-surface-variant font-mono">{{ user.username }} · {{ $t('userCenter.joinedAt', { date: createdAtText }) }}</p>
        </div>
      </div>
      <div class="flex items-end gap-sm">
        <div class="flex-1">
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.displayName') }}</label>
          <input v-model="displayName" data-testid="profile-displayname-input" maxlength="64"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
        </div>
        <button data-testid="profile-displayname-save" :disabled="savingName"
          class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm disabled:opacity-50 shrink-0"
          @click="saveDisplayName">{{ $t('common.save') }}</button>
      </div>
    </div>

    <!-- 安全卡 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
      <h3 class="text-headline-sm font-bold mb-md">{{ $t('userCenter.securityTitle') }}</h3>
      <div class="grid gap-md sm:grid-cols-3">
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.currentPassword') }}</label>
          <input v-model="pwdForm.current" data-testid="pwd-current" type="password" autocomplete="current-password"
            :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm', pwdErrors.current ? 'border-error' : 'border-outline-variant']" />
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.newPassword') }}</label>
          <input v-model="pwdForm.next" data-testid="pwd-new" type="password" autocomplete="new-password"
            :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm', pwdErrors.next ? 'border-error' : 'border-outline-variant']" />
          <p v-if="pwdErrors.next" class="text-body-xs text-error mt-xs">{{ $t('userCenter.passwordMinHint') }}</p>
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.confirmPassword') }}</label>
          <input v-model="pwdForm.confirm" data-testid="pwd-confirm" type="password" autocomplete="new-password"
            :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-sm', pwdErrors.confirm ? 'border-error' : 'border-outline-variant']" />
          <p v-if="pwdErrors.confirm" class="text-body-xs text-error mt-xs">{{ $t('userCenter.passwordMismatch') }}</p>
        </div>
      </div>
      <button data-testid="pwd-submit" :disabled="pwdLoading"
        class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm disabled:opacity-50"
        @click="changePassword">{{ $t('userCenter.changePassword') }}</button>

      <div class="flex items-center justify-between mt-lg mb-sm">
        <h4 class="text-body-md font-semibold">{{ $t('userCenter.sessionsTitle') }}</h4>
        <button data-testid="sessions-revoke-others" class="text-body-sm text-error hover:underline" @click="askRevokeOthers">{{ $t('userCenter.revokeOthers') }}</button>
      </div>
      <div v-if="sessionsLoading" class="py-md text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block">progress_activity</span></div>
      <div v-else class="flex flex-col gap-xs">
        <div v-for="s in sessions" :key="s.fingerprint" data-testid="session-row"
          class="flex items-center gap-md px-md py-sm rounded-lg border border-outline-variant/50">
          <span class="material-symbols-outlined text-on-surface-variant" :class="s.current ? 'text-primary' : ''">{{ s.current ? 'phonelink_ring' : 'devices_other' }}</span>
          <div class="min-w-0 flex-1">
            <p class="text-body-sm font-medium truncate">{{ uaSummary(s.userAgent) }}<span v-if="s.current" class="ml-sm px-1 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold">{{ $t('userCenter.currentSession') }}</span></p>
            <p class="text-body-xs text-on-surface-variant truncate">{{ s.ip || '—' }} · {{ $t('userCenter.lastActive', { time: fmtTime(s.lastSeenAt) }) }}</p>
          </div>
          <button v-if="!s.current" :data-testid="`session-revoke-${s.fingerprint}`"
            class="p-1 rounded text-on-surface-variant hover:text-error hover:bg-error/10" :title="$t('userCenter.revoke')"
            @click="askRevoke(s)"><span class="material-symbols-outlined text-base">logout</span></button>
        </div>
      </div>
    </div>

    <!-- 偏好卡 -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
      <h3 class="text-headline-sm font-bold mb-md">{{ $t('userCenter.preferencesTitle') }}</h3>
      <div class="grid gap-md sm:grid-cols-2">
        <div>
          <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.language') }}</p>
          <div class="flex gap-xs">
            <button v-for="o in langOptions" :key="o.v" :data-testid="`pref-lang-${o.v}`"
              class="px-md py-sm rounded-lg border text-body-sm"
              :class="prefs.language === o.v ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'"
              @click="prefs.setLanguage(o.v)">{{ $t(o.key) }}</button>
          </div>
        </div>
        <div>
          <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.theme') }}</p>
          <div class="flex gap-xs">
            <button v-for="o in themeOptions" :key="o.v" :data-testid="`pref-theme-${o.v}`"
              class="flex items-center gap-xs px-md py-sm rounded-lg border text-body-sm"
              :class="prefs.theme === o.v ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'"
              @click="prefs.setTheme(o.v)">
              <span class="material-symbols-outlined text-base">{{ o.icon }}</span>{{ $t(o.key) }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog v-model="showRevokeConfirm" danger
      :title="$t('userCenter.revokeConfirmTitle')"
      :message="$t('userCenter.revokeConfirmMessage')"
      @confirm="doRevoke" />
  </section>
</template>
