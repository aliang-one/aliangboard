<script setup>
// 侧栏头像行(2026-10-23 顶栏退役·导航单源收敛 Task 4):UserMenu 从顶栏身份舱右段
// 迁为侧栏整行触发钮,菜单 Teleport 到 body + fixed 锚定(侧栏 overflow-hidden 不裁切,
// 配方=useDropdownPanel issue#4;下方放不下自动向上翻,贴合侧栏底缘)。登出仍走
// ConfirmDialog 二次确认 + document 级 click 外部关闭 + ESC(自包含实现);
// 主题/语言快捷切换退役(归设置页)。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'
import { useAvatar } from '@/composables/useAvatar'
import { useDropdownPanel } from '@/composables/useDropdownPanel'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const router = useRouter()
const authStore = useAuthStore()
const clusterStore = useClusterStore()
const { t } = useI18n()

const open = ref(false)
const showLogoutConfirm = ref(false)
// 触发钮 ref(菜单锚定目标);菜单本体已 Teleport,不再需要 rootEl contains 判定
const rowRef = ref(null)

const displayName = computed(() => authStore.user?.displayName || authStore.user?.username || 'User')
const initial = computed(() => displayName.value.charAt(0).toUpperCase())
// 角色小字(2026-08-31 设计 §3):所有用户都显示本地化角色名;role 缺失返回 '' → 模板 v-if 隐藏
const roleLabel = computed(() => {
  const role = authStore.user?.role
  if (!role) return ''
  return t(role === 'admin' ? 'admin.users.roleAdmin' : 'admin.users.roleUser')
})
// 头像共享单例(2026-09-04 Wave1 Task13):与 ProfileSection 同一 ref,上传/清除即时同步
const { avatarDataUrl, ensureLoaded } = useAvatar()
// 菜单定位:Teleport body + fixed 锚定触发行,等宽于触发行(等价原 left-0 right-0)
const { panelRef, panelStyle } = useDropdownPanel(rowRef, open, { matchTriggerWidth: true })

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
// 外点关闭:菜单已传送出组件树,rootEl.contains 不可用——按 testid closest 判定,
// 触发行与传送面板两处都算菜单内部(点菜单项不触发外点关闭)。
function onDocClick(e) { if (open.value && !e.target.closest?.('[data-testid="user-menu-trigger"], [data-testid="user-menu-dropdown"]')) closeMenu() }
function onKey(e) { if (e.key === 'Escape') closeMenu() }
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  ensureLoaded()
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="shrink-0">
    <button ref="rowRef" data-testid="user-menu-trigger" @click="toggle"
      class="w-full flex items-center gap-sm px-md py-sm text-left transition-colors"
      :class="open ? 'bg-surface-container' : 'hover:bg-surface-container'"
      :aria-label="$t('nav.userCenter')" :aria-expanded="open ? 'true' : 'false'" aria-haspopup="true">
      <img v-if="avatarDataUrl" :src="avatarDataUrl" data-testid="user-avatar-img" alt="avatar" class="w-7 h-7 rounded-full object-cover shrink-0" />
      <div v-else data-testid="user-avatar-fallback" class="w-7 h-7 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-body-sm font-bold shrink-0">{{ initial }}</div>
      <div class="min-w-0 flex-1 sb-user-txt">
        <span class="block w-full text-body-sm font-semibold truncate" :title="displayName">{{ displayName }}</span>
        <span v-if="roleLabel" data-testid="user-menu-role" class="block w-full text-[10px] text-on-surface-variant truncate">{{ roleLabel }}</span>
      </div>
      <span class="material-symbols-outlined text-on-surface-variant text-body-sm transition-transform sb-user-txt" :class="open ? 'rotate-180' : ''">expand_more</span>
    </button>

    <Teleport to="body">
      <div v-if="open" ref="panelRef" data-testid="user-menu-dropdown"
        class="bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-hidden" :style="panelStyle">
        <!-- 用户信息头(头像用独立 testid,与触发钮区分) -->
        <div class="flex items-center gap-sm px-md py-md border-b border-outline-variant">
          <img v-if="avatarDataUrl" :src="avatarDataUrl" data-testid="user-menu-avatar" alt="avatar" class="w-10 h-10 rounded-full object-cover shrink-0" />
          <div v-else data-testid="user-menu-avatar-fallback" class="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-headline-sm font-bold shrink-0">{{ initial }}</div>
          <div class="min-w-0">
            <p class="text-body-md font-semibold truncate">{{ displayName }}</p>
            <p class="text-body-xs text-on-surface-variant truncate font-mono">{{ authStore.user?.username }}</p>
          </div>
        </div>
        <button data-testid="user-menu-profile" class="flex items-center gap-sm w-full px-md py-sm text-left hover:bg-surface-container transition-colors" @click="goProfile">
          <span class="material-symbols-outlined text-lg text-on-surface-variant">person</span>
          <span class="text-body-md">{{ $t('nav.userCenter') }}</span>
        </button>
        <div class="border-t border-outline-variant"></div>
        <button data-testid="user-menu-logout" class="flex items-center gap-sm w-full px-md py-sm text-left text-error hover:bg-error/10 transition-colors" @click="askLogout">
          <span class="material-symbols-outlined text-lg">logout</span>
          <span class="text-body-md">{{ $t('nav.logout') }}</span>
        </button>
      </div>
    </Teleport>

    <ConfirmDialog v-model="showLogoutConfirm" :title="$t('userCenter.logoutConfirmTitle')"
      :message="$t('userCenter.logoutConfirmMessage')" :confirm-text="$t('nav.logout')" danger @confirm="doLogout" />
  </div>
</template>
