// sshTerminals store 契约:①sid 非 secure context(HTTP 局域网 IP,crypto.randomUUID 缺失)仍可生成
// ②同 serverId 复用同一 sid(刷新重连回放的前提)③localStorage 持久化。
// 2026-08-28 真机事故:局域网 HTTP 下 crypto.randomUUID is not a function → 打开终端直接抛。
import { test, expect, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSshTerminalStore } from '../sshTerminals'

const SID_KEY = 'aliangboard.ssh.sid.sv1'

function mountInsecure() {
  setActivePinia(createPinia())
  // 模拟非安全上下文:crypto 存在但无 randomUUID(浏览器 HTTP 非受限 API 仅剩 getRandomValues)
  vi.stubGlobal('crypto', { getRandomValues: arr => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 11) % 256; return arr } })
}
const unstub = () => vi.unstubAllGlobals()

test('无 crypto.randomUUID(非安全上下文)仍生成 sid 并持久化+复用', () => {
  mountInsecure()
  localStorage.removeItem(SID_KEY)
  try {
    const store = useSshTerminalStore()
    const w1 = store.openTerminal({ id: 'sv1', name: 'web' })
    expect(w1.id).toMatch(/^ssh-/)
    expect(localStorage.getItem(SID_KEY)).toBe(w1.id)
    const w2 = store.openTerminal({ id: 'sv1', name: 'web' })
    expect(w2.id).toBe(w1.id)   // 同服务器复用 → 刷新重连同 sid 回放
  } finally { unstub() }
})

test('已有持久化 sid 时直接复用(不重新生成)', () => {
  setActivePinia(createPinia())
  localStorage.setItem(SID_KEY, 'ssh-existing-sid')
  try {
    const store = useSshTerminalStore()
    const w = store.openTerminal({ id: 'sv1', name: 'web' })
    expect(w.id).toBe('ssh-existing-sid')
  } finally { localStorage.removeItem(SID_KEY) }
})
