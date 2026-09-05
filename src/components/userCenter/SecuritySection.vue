<script setup>
// 安全卡(2026-09-04 Wave1 §3.1,自 UserProfile.vue 原样迁入):改密 + 会话列表/分页/吊销 + ConfirmDialog。
// createdAt 展示与刷新钮留给 Task 9,本任务先原样迁。
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import Pagination from '@/components/common/Pagination.vue'
import { uaSummary } from '@/utils/uaSummary'
import { firstFailedRule, failedRuleMessageKey, DEFAULT_PASSWORD_POLICY } from '@/utils/passwordRules'

const { t } = useI18n()

// === 改密 ===
const pwdForm = ref({ current: '', next: '', confirm: '' })
const pwdErrors = ref({})
const pwdLoading = ref(false)
const policy = ref(DEFAULT_PASSWORD_POLICY)   // 服务端策略档,挂载时拉取
const nextErrorKey = ref(null)
async function changePassword() {
  const errs = {}
  if (!pwdForm.value.current) errs.current = true
  const rule = firstFailedRule(pwdForm.value.next, policy.value)
  if (rule) { errs.next = true; nextErrorKey.value = failedRuleMessageKey(rule) }
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

// === 会话 ===
const sessions = ref([])
const sessionsLoading = ref(false)
const revokeTarget = ref(null)          // {fingerprint} 或 'others'
const showRevokeConfirm = ref(false)
// 会话列表分页(2026-08-30 设计 §4):客户端切片,>pageSize 才显示分页条;吊销重拉后页码收敛。
const currentPage = ref(1)
const pageSize = 10
const totalPages = computed(() => Math.max(1, Math.ceil(sessions.value.length / pageSize)))
const pagedSessions = computed(() => sessions.value.slice((currentPage.value - 1) * pageSize, currentPage.value * pageSize))
function clampPage() { currentPage.value = Math.min(currentPage.value, totalPages.value) }
async function loadSessions() {
  sessionsLoading.value = true
  try { sessions.value = (await authApi.listSessions()).sessions || [] }
  catch { /* 会话列表失败不阻塞页面 */ }
  finally { sessionsLoading.value = false; clampPage() }
}
onMounted(() => {
  loadSessions()
  authApi.getPasswordPolicy().then((r) => { policy.value = r.policy || DEFAULT_PASSWORD_POLICY }).catch(() => {})
})
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
</script>

<template>
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
        <p v-if="pwdErrors.next" class="text-body-xs text-error mt-xs">{{ $t(nextErrorKey || 'userCenter.passwordMinHint') }}</p>
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
      <div class="flex items-center gap-sm">
        <button data-testid="sessions-refresh" class="p-1 rounded text-on-surface-variant hover:text-primary hover:bg-primary/10" :title="$t('common.refresh')" @click="loadSessions">
          <span class="material-symbols-outlined text-base">refresh</span>
        </button>
        <button data-testid="sessions-revoke-others" class="text-body-sm text-error hover:underline" @click="askRevokeOthers">{{ $t('userCenter.revokeOthers') }}</button>
      </div>
    </div>
    <div v-if="sessionsLoading" class="py-md text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block">progress_activity</span></div>
    <div v-else class="flex flex-col gap-xs">
      <div v-for="s in pagedSessions" :key="s.fingerprint" data-testid="session-row"
        class="flex items-center gap-md px-md py-sm rounded-lg border border-outline-variant/50">
        <span class="material-symbols-outlined text-on-surface-variant" :class="s.current ? 'text-primary' : ''">{{ s.current ? 'phonelink_ring' : 'devices_other' }}</span>
        <div class="min-w-0 flex-1">
          <p class="text-body-sm font-medium truncate">{{ uaSummary(s.userAgent) }}<span v-if="s.current" class="ml-sm px-1 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold">{{ $t('userCenter.currentSession') }}</span></p>
          <p class="text-body-xs text-on-surface-variant truncate">{{ s.ip || '—' }} · {{ $t('userCenter.sessionLoginAt', { time: fmtTime(s.createdAt) }) }} · {{ $t('userCenter.lastActive', { time: fmtTime(s.lastSeenAt) }) }}</p>
        </div>
        <button v-if="!s.current" :data-testid="`session-revoke-${s.fingerprint}`"
          class="p-1 rounded text-on-surface-variant hover:text-error hover:bg-error/10" :title="$t('userCenter.revoke')"
          @click="askRevoke(s)"><span class="material-symbols-outlined text-base">logout</span></button>
      </div>
    </div>
    <Pagination v-if="sessions.length > pageSize" data-testid="sessions-pagination"
      class="mt-sm" :total="sessions.length" :page-size="pageSize" :current-page="currentPage"
      @page-change="(p) => (currentPage = p)" />
  </div>

  <ConfirmDialog v-model="showRevokeConfirm" danger
    :title="$t('userCenter.revokeConfirmTitle')"
    :message="$t('userCenter.revokeConfirmMessage')"
    @confirm="doRevoke" />
</template>
