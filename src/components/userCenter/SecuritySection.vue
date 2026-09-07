<script setup>
// 安全卡(2026-09-04 Wave1 §3.1,自 UserProfile.vue 原样迁入):改密 + 会话列表/分页/吊销 + ConfirmDialog。
// W3 Task 4(2026-09-07)增:两步验证(MFA)区——扫码启用(二维码/密钥/otpauth 三通道)→ 恢复码
// 一次性弹窗;已启用态徽章 + 重新生成恢复码 + 禁用(账户安全面 409 stepUpRequired → StepUpDialog 验过重放)。
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { authApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { notify } from '@/composables/useToast'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import Pagination from '@/components/common/Pagination.vue'
import StepUpDialog from '@/components/common/StepUpDialog.vue'
import Modal from '@/components/common/Modal.vue'
import KubectlCard from '@/components/userCenter/KubectlCard.vue'
import { uaSummary } from '@/utils/uaSummary'
import { firstFailedRule, failedRuleMessageKey, DEFAULT_PASSWORD_POLICY } from '@/utils/passwordRules'

const { t } = useI18n()
const authStore = useAuthStore()

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
  } catch (e) {
    // step-up 周界(W3 §1.4):stepUpAt 过期 → 409 {stepUpRequired};弹 StepUpDialog,验过重放同一次改密
    if (e?.status === 409 && e?.details?.stepUpRequired) {
      pendingStepUpAction.value = changePassword
      showStepUp.value = true
      return   // finally 复位 loading;表单保留(密码不丢),验过重放
    }
    notify('error', e.message || t('common.opFailed'))
  }
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
  refreshMfa()
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

// === 两步验证 MFA(W3 Task 4) ===
const mfaEnrolled = ref(false)
const mfaRestricted = ref(false)   // 挂载时会话受限(mfaPending=1):enable 成功后引导重新登录
// 启停以响应应为权威(成功即翻转本地态),挂载时 /me 校准 + 同步 store(顶栏等消费方)。
async function refreshMfa() {
  try {
    const res = await authApi.me()
    mfaEnrolled.value = !!res.user?.totpEnabled
    // 真实载荷是 JSON 布尔(服务端 ps.mfaPending === 1);truthy 判定对布尔/数字斯通(review round 1)
    mfaRestricted.value = !!res.mfaPending
  } catch { mfaEnrolled.value = !!authStore.user?.totpEnabled }
  syncMfaToStore()
}
function syncMfaToStore() {
  if (authStore.user) authStore.user = { ...authStore.user, totpEnabled: mfaEnrolled.value }
}

// 启用弹窗:二维码(otpauth URI)+ otpauth 文本 + 手输密钥三通道
const showEnroll = ref(false)
const enrollQr = ref('')
const enrollSecret = ref('')
const enrollUri = ref('')
const enrollCode = ref('')
const enrollError = ref('')
const enrollLoading = ref(false)
async function startEnroll() {
  enrollCode.value = ''
  enrollError.value = ''
  try {
    const res = await authApi.mfaSetup()
    enrollSecret.value = res.secret
    enrollUri.value = res.otpauthUri
    // qrcode.toString(type:svg) 产 SVG 标记 → 包成 data URL 喂 <img>(测试桩直出 data: 则原样透传)
    const raw = await QRCode.toString(res.otpauthUri, { type: 'svg', margin: 1 })
    enrollQr.value = raw.startsWith('data:') ? raw : `data:image/svg+xml;utf8,${encodeURIComponent(raw)}`
    showEnroll.value = true
  } catch (e) {
    // 409 step-up(外评 2026-09-07 修复 3,双 tab 失配:另一处已启用、本地态仍「未启用」):
    // 验过重放 setup——与 regenRecoveryCodes 同款分支(已启用者 setup 需 step-up)。
    if (e?.status === 409 && e?.details?.stepUpRequired) {
      pendingStepUpAction.value = startEnroll
      showStepUp.value = true
      return
    }
    notify('error', e.message || t('common.opFailed'))
  }
}
// 重新生成恢复码(spec §1.4):已启用者 setup 必 409 step-up → 验过重放 setup(新 secret)→ 复用启用
// 弹窗走完整 enable——server W3-A 裁决:已启用再 enable = 同时轮换 TOTP 密钥 + 恢复码组(旧恢复码全作废)。
async function regenRecoveryCodes() {
  try {
    const res = await authApi.mfaSetup()
    enrollCode.value = ''
    enrollError.value = ''
    enrollSecret.value = res.secret
    enrollUri.value = res.otpauthUri
    const raw = await QRCode.toString(res.otpauthUri, { type: 'svg', margin: 1 })
    enrollQr.value = raw.startsWith('data:') ? raw : `data:image/svg+xml;utf8,${encodeURIComponent(raw)}`
    showEnroll.value = true
  } catch (e) {
    if (e?.status === 409 && e?.details?.stepUpRequired) {
      pendingStepUpAction.value = regenRecoveryCodes
      showStepUp.value = true
      return
    }
    notify('error', e.message || t('common.opFailed'))
  }
}
async function confirmEnroll() {
  const code = enrollCode.value.trim()
  if (!code) { enrollError.value = t('userCenter.mfa.codeMissing'); return }
  enrollLoading.value = true
  enrollError.value = ''
  try {
    const res = await authApi.mfaEnable({ secret: enrollSecret.value, code })
    recoveryCodes.value = res.recoveryCodes || []
    usedCodes.value = [] // 新码组下发:划掉标记重置
    showEnroll.value = false
    showRecovery.value = true
    mfaEnrolled.value = true
    syncMfaToStore()
  } catch (e) {
    // 409 step-up(外评 2026-09-07 修复 3,双 tab 失配):enable 对已启用者 409——server W3-A 裁决
    // 落在 step-up 禁改面。弹 StepUpDialog,验过同 secret+码重放(等价 regen:轮换 TOTP 密钥+恢复码组);
    // 启用弹窗保留(码不丢),与 confirmDisable 同款分支。
    if (e?.status === 409 && e?.details?.stepUpRequired) {
      pendingStepUpAction.value = confirmEnroll
      showStepUp.value = true
      return   // finally 复位 loading
    }
    enrollError.value = e.message || t('common.opFailed')
  } finally { enrollLoading.value = false }
}

// 恢复码一次性弹窗:明文仅此次下发;受限会话在此引导重新登录(W3-A review:重登得完整 token,
// 不引导重复 enable)
const showRecovery = ref(false)
const recoveryCodes = ref([])
// 逐个划掉(残余收尾 fix 2):纯前端「我已抄录这条」标记,新码下发/关闭弹窗即重置
const usedCodes = ref([])
function markUsed(code) { if (!usedCodes.value.includes(code)) usedCodes.value.push(code) }
// 关闭即清空:恢复码明文不滞留组件态/DOM(review round 1 minor)
function closeRecovery() {
  showRecovery.value = false
  recoveryCodes.value = []
  usedCodes.value = []
}
async function copyRecoveryCodes() {
  try {
    await navigator.clipboard.writeText(recoveryCodes.value.join('\n'))
    notify('success', t('common.copySuccess'))
  } catch { notify('error', t('common.copyFailed')) }
}

// 禁用:需验码 + step-up 周界;409 {stepUpRequired} → StepUpDialog 验过同码重放
const showDisable = ref(false)
const disableCode = ref('')
const disableError = ref('')
const disableLoading = ref(false)
const showStepUp = ref(false)
const pendingStepUpAction = ref(null)
function openDisable() {
  disableCode.value = ''
  disableError.value = ''
  showDisable.value = true
}
async function confirmDisable() {
  const code = disableCode.value.trim()
  if (!code) { disableError.value = t('userCenter.mfa.codeMissing'); return }
  disableLoading.value = true
  disableError.value = ''
  try {
    await authApi.mfaDisable(code)
    showDisable.value = false
    disableCode.value = ''
    mfaEnrolled.value = false
    syncMfaToStore()
    notify('success', t('common.success'))
  } catch (e) {
    if (e?.status === 409 && e?.details?.stepUpRequired) {
      pendingStepUpAction.value = confirmDisable
      showStepUp.value = true
      return   // finally 复位 loading;禁用弹窗保留(码不丢),验过重放
    }
    disableError.value = e.message || t('common.opFailed')
  } finally { disableLoading.value = false }
}
async function onStepUpDone() {
  showStepUp.value = false
  const replay = pendingStepUpAction.value
  pendingStepUpAction.value = null
  if (replay) await replay()
}
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

    <!-- 两步验证(W3 Task 4):未启用=启用钮;已启用=徽章+禁用钮 -->
    <div class="mt-lg pt-lg border-t border-outline-variant/50 flex items-center justify-between gap-md">
      <div class="min-w-0">
        <h4 class="text-body-md font-semibold flex items-center gap-xs">
          {{ $t('userCenter.mfa.title') }}
          <span v-if="mfaEnrolled" data-testid="mfa-enabled-badge"
            class="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold">{{ $t('userCenter.mfa.enrolled') }}</span>
        </h4>
        <p class="text-body-xs text-on-surface-variant mt-xs">{{ $t('userCenter.mfa.desc') }}</p>
      </div>
      <button v-if="!mfaEnrolled" data-testid="mfa-enable-btn"
        class="shrink-0 px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm"
        @click="startEnroll">{{ $t('userCenter.mfa.enable') }}</button>
      <div v-else class="shrink-0 flex items-center gap-sm">
        <button data-testid="mfa-regen-btn"
          class="px-md py-sm border border-outline-variant rounded-lg font-semibold text-body-sm text-on-surface-variant hover:bg-surface-container-high"
          @click="regenRecoveryCodes">{{ $t('userCenter.mfa.regen') }}</button>
        <button data-testid="mfa-disable-btn"
          class="px-md py-sm border border-error/40 text-error rounded-lg font-semibold text-body-sm hover:bg-error/10"
          @click="openDisable">{{ $t('userCenter.mfa.disable') }}</button>
      </div>
    </div>

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

  <!-- kubectl 访问卡(W3 Task 6):独立组件 —— 本文件已超行数预算,卡自持容器 -->
  <KubectlCard />

  <ConfirmDialog v-model="showRevokeConfirm" danger
    :title="$t('userCenter.revokeConfirmTitle')"
    :message="$t('userCenter.revokeConfirmMessage')"
    @confirm="doRevoke" />

  <!-- MFA 启用弹窗:二维码 + otpauth URI + 手输密钥 + 验码 -->
  <Modal :model-value="showEnroll" :title="$t('userCenter.mfa.enrollTitle')" width="max-w-sm"
    @update:model-value="(v) => (showEnroll = v)">
    <div class="flex flex-col gap-md">
      <p class="text-body-sm text-on-surface-variant">{{ $t('userCenter.mfa.enrollHint') }}</p>
      <img v-if="enrollQr" :src="enrollQr" data-testid="mfa-qr" :alt="$t('userCenter.mfa.title')"
        class="w-44 h-44 mx-auto bg-white p-sm border border-outline-variant rounded-lg" />
      <div class="min-w-0">
        <p class="text-label-caps text-on-surface-variant mb-xs">{{ $t('userCenter.mfa.secretLabel') }}</p>
        <p data-testid="mfa-secret" class="font-mono text-body-sm break-all select-all">{{ enrollSecret }}</p>
      </div>
      <div class="min-w-0">
        <p class="text-label-caps text-on-surface-variant mb-xs">{{ $t('userCenter.mfa.otpauthLabel') }}</p>
        <p data-testid="mfa-otpauth" class="font-mono text-body-xs text-on-surface-variant break-all">{{ enrollUri }}</p>
      </div>
      <input v-model="enrollCode" data-testid="mfa-code-input" type="text" inputmode="numeric" autocomplete="one-time-code"
        :placeholder="$t('userCenter.mfa.codePlaceholder')" @keydown.enter="confirmEnroll"
        :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-md tracking-widest outline-none transition-all', enrollError ? 'border-error' : 'border-outline-variant']" />
      <p v-if="enrollError" data-testid="mfa-enroll-error" class="text-body-sm text-error">{{ enrollError }}</p>
      <div class="flex justify-end gap-sm">
        <button data-testid="mfa-enroll-cancel"
          class="px-md py-sm rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container-high"
          @click="showEnroll = false">{{ $t('common.cancel') }}</button>
        <button data-testid="mfa-confirm" :disabled="enrollLoading"
          class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm disabled:opacity-50"
          @click="confirmEnroll">{{ $t('userCenter.mfa.enrollConfirm') }}</button>
      </div>
    </div>
  </Modal>

  <!-- 恢复码一次性弹窗:明文仅此次下发;受限会话引导重新登录;关闭即清空明文 -->
  <Modal :model-value="showRecovery" :title="$t('userCenter.mfa.recoveryTitle')" width="max-w-sm"
    @update:model-value="(v) => { if (!v) closeRecovery() }">
    <div class="flex flex-col gap-md">
      <p class="text-body-sm text-error font-medium">{{ $t('userCenter.mfa.recoveryHint') }}</p>
      <ul data-testid="mfa-recovery-codes"
        class="grid grid-cols-2 gap-x-md gap-xs bg-surface-container-low rounded-lg p-md font-mono text-body-sm">
        <li v-for="(c, i) in recoveryCodes" :key="i" :data-testid="`recovery-code-${i}`"
          :data-used="usedCodes.includes(c) || undefined" :title="$t('userCenter.mfa.markUsedHint')"
          :class="['break-all cursor-pointer select-none', usedCodes.includes(c) ? 'line-through text-on-surface-variant' : 'hover:text-primary']"
          @click="markUsed(c)">{{ c }}</li>
      </ul>
      <p v-if="mfaRestricted" data-testid="mfa-relogin-hint"
        class="flex items-start gap-xs text-body-sm text-primary bg-primary/10 rounded-lg px-md py-sm">
        <span class="material-symbols-outlined text-base">info</span>{{ $t('userCenter.mfa.reloginHint') }}
      </p>
      <div class="flex justify-end gap-sm">
        <button data-testid="mfa-recovery-copy"
          class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high"
          @click="copyRecoveryCodes">{{ $t('userCenter.mfa.copyAll') }}</button>
        <button data-testid="mfa-recovery-close"
          class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm"
          @click="closeRecovery">{{ $t('userCenter.mfa.recoveryDone') }}</button>
      </div>
    </div>
  </Modal>

  <!-- MFA 禁用弹窗:验码 + step-up 周界(409 → StepUpDialog 验过重放) -->
  <Modal :model-value="showDisable" :title="$t('userCenter.mfa.disableTitle')" width="max-w-sm"
    @update:model-value="(v) => (showDisable = v)">
    <div class="flex flex-col gap-md">
      <p class="text-body-sm text-on-surface-variant">{{ $t('userCenter.mfa.disableHint') }}</p>
      <input v-model="disableCode" data-testid="mfa-disable-input" type="text" inputmode="numeric" autocomplete="one-time-code"
        :placeholder="$t('userCenter.mfa.codePlaceholder')" @keydown.enter="confirmDisable"
        :class="['w-full bg-surface-container-low border rounded-lg px-md py-sm text-body-md tracking-widest outline-none transition-all', disableError ? 'border-error' : 'border-outline-variant']" />
      <p v-if="disableError" data-testid="mfa-disable-error" class="text-body-sm text-error">{{ disableError }}</p>
      <div class="flex justify-end gap-sm">
        <button data-testid="mfa-disable-cancel"
          class="px-md py-sm rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container-high"
          @click="showDisable = false">{{ $t('common.cancel') }}</button>
        <button data-testid="mfa-disable-confirm" :disabled="disableLoading"
          class="px-md py-sm bg-error text-on-error rounded-lg font-semibold text-body-sm disabled:opacity-50"
          @click="confirmDisable">{{ $t('userCenter.mfa.disableConfirm') }}</button>
      </div>
    </div>
  </Modal>

  <StepUpDialog :visible="showStepUp" @done="onStepUpDone" @close="showStepUp = false" />
</template>
