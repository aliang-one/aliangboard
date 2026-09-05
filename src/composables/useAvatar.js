// 头像共享态(2026-09-04 Wave1 §3.5):模块级单例——UserMenu(顶栏)与 ProfileSection(上传处)
// 引用同一 ref,上传/清除即时全站生效。会话内缓存一次;登出后下次进入由页面重新 ensureLoaded。
import { ref } from 'vue'
import { authApi } from '@/api/client'

const avatarDataUrl = ref(null)
let fetchOnce = null

export function useAvatar() {
  function ensureLoaded() {
    if (!fetchOnce) {
      fetchOnce = authApi.getAvatar().then(r => { avatarDataUrl.value = r?.dataUrl || null }).catch(() => { avatarDataUrl.value = null })
    }
    return fetchOnce
  }
  function apply(dataUrl) { avatarDataUrl.value = dataUrl; fetchOnce = fetchOnce || Promise.resolve() }
  function clearLocal() { avatarDataUrl.value = null }
  return { avatarDataUrl, ensureLoaded, apply, clearLocal }
}

// 仅供测试隔离:单例 ref + fetchOnce 跨用例残留清理(生产代码勿调)
export function resetAvatarForTest() { avatarDataUrl.value = null; fetchOnce = null }
