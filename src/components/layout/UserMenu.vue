<script setup>
// 头像用户菜单(2026-08-29 用户中心设计 §2.1):点击开菜单而非登出——根治 TopNavBar
// 「头像整块=登出按钮」误触问题。登出走 ConfirmDialog 二次确认;菜单开合用 document
// 级 click 外部关闭 + ESC(与 TopNavBar 集群/ns 下拉的遮罩模式等价,这里是自包含实现)。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const router = useRouter()
const authStore = useAuthStore()
const clusterStore = useClusterStore()

const open = ref(false)
const showLogoutConfirm = ref(false)
const rootEl = ref(null)

const displayName = computed(() => authStore.user?.displayName || authStore.user?.username || 'User')
const initial = computed(() => displayName.value.charAt(0).toUpperCase())

function toggle() { open.value = !open.value }
function closeMenu() { open.value = false }
function goProfile() { closeMenu(); router.push('/profile') }
function askLogout() { closeMenu(); showLogoutConfirm.value = true }
function doLogout() {
  showLogoutConfirm.value = false
  try { clusterStore.stopPodWatch() } catch { /* 未启动时忽略 */ }
  try { clusterStore.stopEventWatch() } catch { /* 未启动时忽略 */ }
  authStore.logout()
  router.push('/login')
}
function onDocClick(e) { if (open.value && rootEl.value && !rootEl.value.contains(e.target)) closeMenu() }
function onKey(e) { if (e.key === 'Escape') closeMenu() }
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="relative shrink-0">
    <button
      data-testid="user-menu-trigger"
      class="flex items-center gap-sm cursor-pointer hover:bg-surface-container-low p-1 rounded-lg transition-colors"
      :aria-label="$t('nav.userCenter')"
      @click="toggle"
    >
      <div class="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-body-sm font-bold">{{ initial }}</div>
      <span class="text-body-sm font-semibold max-w-[120px] truncate" :title="displayName">{{ displayName }}</span>
      <span v-if="authStore.isAdmin" class="px-1 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold">ADMIN</span>
      <span class="material-symbols-outlined text-on-surface-variant text-body-sm transition-transform" :class="open ? 'rotate-180' : ''">expand_more</span>
    </button>

    <div
      v-if="open"
      data-testid="user-menu-dropdown"
      class="absolute top-full right-0 mt-1 w-60 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-50 overflow-hidden"
    >
      <div class="flex items-center gap-sm px-md py-md border-b border-outline-variant">
        <div class="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-headline-sm font-bold shrink-0">{{ initial }}</div>
        <div class="min-w-0">
          <p class="text-body-md font-semibold truncate">{{ displayName }}</p>
          <p class="text-body-xs text-on-surface-variant truncate font-mono">{{ authStore.user?.username }}</p>
        </div>
      </div>
      <button
        data-testid="user-menu-profile"
        class="flex items-center gap-sm w-full px-md py-sm text-left hover:bg-surface-container transition-colors"
        @click="goProfile"
      >
        <span class="material-symbols-outlined text-lg text-on-surface-variant">person</span>
        <span class="text-body-md">{{ $t('nav.userCenter') }}</span>
      </button>
      <div class="border-t border-outline-variant"></div>
      <button
        data-testid="user-menu-logout"
        class="flex items-center gap-sm w-full px-md py-sm text-left text-error hover:bg-error/10 transition-colors"
        @click="askLogout"
      >
        <span class="material-symbols-outlined text-lg">logout</span>
        <span class="text-body-md">{{ $t('nav.logout') }}</span>
      </button>
    </div>

    <ConfirmDialog
      v-model="showLogoutConfirm"
      :title="$t('userCenter.logoutConfirmTitle')"
      :message="$t('userCenter.logoutConfirmMessage')"
      :confirm-text="$t('nav.logout')"
      danger
      @confirm="doLogout"
    />
  </div>
</template>
