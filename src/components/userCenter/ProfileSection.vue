<script setup>
// 资料卡(2026-09-04 Wave1 §3.1,自 UserProfile.vue 原样迁入):头像初字 + displayName 就地编辑。
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { notify } from '@/composables/useToast'
import { fileToAvatarDataUrl } from '@/utils/avatarImage'
import { useAvatar } from '@/composables/useAvatar'

const { t } = useI18n()
const authStore = useAuthStore()
const { avatarDataUrl, ensureLoaded, apply, clearLocal } = useAvatar()
const avatarFileEl = ref(null)

const user = computed(() => authStore.user || {})
const createdAtText = computed(() => (user.value.createdAt ? new Date(user.value.createdAt).toLocaleDateString() : '—'))
const initial = computed(() => (user.value.displayName || user.value.username || 'U').charAt(0).toUpperCase())

const displayName = ref('')
const savingName = ref(false)
onMounted(() => { displayName.value = user.value.displayName || ''; ensureLoaded() })
async function saveDisplayName() {
  savingName.value = true
  try {
    const res = await authApi.updateMe({ displayName: displayName.value })
    authStore.user = { ...authStore.user, ...res.user }
    notify('success', t('userCenter.profileSaved'))
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
  finally { savingName.value = false }
}

function pickAvatar() { avatarFileEl.value?.click() }
async function onAvatarFile(e) {
  const file = e.target?.files?.[0]
  e.target.value = ''
  if (!file) return
  const dataUrl = await fileToAvatarDataUrl(file)
  if (!dataUrl) { notify('error', t('userCenter.avatarInvalid')); return }
  try {
    await authApi.uploadAvatar(dataUrl)
    apply(dataUrl)
    notify('success', t('common.save'))
  } catch (err) { notify('error', err.message || t('common.opFailed')) }
}
async function onClearAvatar() {
  try {
    await authApi.clearAvatar()
    clearLocal()
    notify('success', t('common.save'))
  } catch (err) { notify('error', err.message || t('common.opFailed')) }
}
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
    <div class="flex items-center gap-md mb-md">
      <div class="relative shrink-0">
        <img v-if="avatarDataUrl" :src="avatarDataUrl" data-testid="avatar-img" alt="avatar"
          class="w-14 h-14 rounded-full object-cover border border-outline-variant" />
        <div v-else data-testid="avatar-fallback"
          class="w-14 h-14 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-headline-lg font-bold">{{ initial }}</div>
      </div>
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
    <div class="flex items-center gap-sm mt-sm">
      <input type="file" accept="image/png,image/jpeg,image/webp" data-testid="avatar-input" class="hidden" ref="avatarFileEl" @change="onAvatarFile" />
      <button data-testid="avatar-pick"
        class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container transition-colors"
        @click="pickAvatar">{{ $t('userCenter.avatarUpload') }}</button>
      <button data-testid="avatar-clear"
        class="px-md py-sm border border-outline-variant rounded-lg text-body-sm text-error hover:bg-error/10 transition-colors"
        @click="onClearAvatar">{{ $t('userCenter.avatarClear') }}</button>
    </div>
  </div>
</template>
