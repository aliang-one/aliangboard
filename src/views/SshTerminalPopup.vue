<script setup>
// SSH 终端独立弹窗页(新浏览器标签页打开):全屏 xterm,无侧栏/顶栏。
// URL: /ssh-terminal-popup?serverId=xxx&sid=xxx&name=xxx
// 平台 token 走 localStorage(同源新标签页自动可用),SshTerminal→sshTerminalStream 自取。
// 同 sid + 网关保活 → 打开即回放续跑(比 pod 的 per-connection exec 更顺)。
// 关闭语义(2026-09-04 收敛,2026-09-08 单行头部收编:外部顶条退役,红点承接):
// 终端头部红点是该标签页唯一杀会话入口——点击 = 杀网关会话 + 关标签页;
// F5/标签页丢弃(pagehide)只发墓碑摘本地记录,绝不杀会话(多开保护)。
import { computed, onUnmounted, ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import SshTerminal from '@/components/ssh/SshTerminal.vue'
import { startPopupHeartbeat } from '@/utils/popupSync'
import { sshApi } from '@/api/client'
import { genSid, useSshTerminalStore } from '@/stores/sshTerminals'

const { t } = useI18n()
const route = useRoute()
const serverId = computed(() => route.query.serverId || '')
const sid = computed(() => route.query.sid || '')
const name = computed(() => route.query.name || serverId.value || 'SSH')
// 起始目录(2026-10-04「+」新建终端):URL query 带来,透传 SshTerminal → WS → 网关注入 cd。
// 仅本会话属主首建时生效;后续 F5 重连同 sid 再带 = 服务端 no-op。
const startCwd = computed(() => String(route.query.cwd || ''))
const termRef = ref(null)   // SshTerminal 暴露的 lastCwd(旁路 cwd 帧维护)是「+」的数据源
const sshStore = useSshTerminalStore()
// sid 缺失守卫(2026-08-29 审计):绝不允许空 sid 建连——旧网关会随机补位造孤儿会话,
// 新网关也会硬拒绝。URL 无 sid(手输/收藏/历史恢复)直接给错误态。
const sidMissing = computed(() => !sid.value)

// 会话名(2026-10-23 居中改名):store 记录优先(localStorage 重建,label||name 回退链),
// URL query 兜底——改名后 F5 同 URL 不回退旧 query 名;无记录(换浏览器/清存储)仍可用。
const record = computed(() => sshStore.windows.find(w => w.id === sid.value))
const sessionName = computed(() => (record.value ? (record.value.label || record.value.name) : name.value))
// 左段身份 = 服务器行名(record.name),不被会话名/label 污染;无记录回退 query/服务器 id
const serverTitle = computed(() => record.value?.name || name.value || serverId.value)

// 页面标题跟随会话名(改名即刷新,替代原 setup 一次性赋值)
watchEffect(() => { document.title = t('ssh.popupTitle', { name: sessionName.value }) })

// 存活信标(2026-09-01 状态对账):opener 借此即时感知本弹窗生死(F5 复活/关闭墓碑),
// 替代纯内存轮询——opener 刷新后不再失明(详见 utils/popupSync.js 头注)。
// meta 传 getter(2026-10-23):改名后心跳自动带新名,opener 按信标重建记录不回退旧名。
const stopHeartbeat = sidMissing.value ? null : startPopupHeartbeat('ssh', sid.value, () => ({ serverId: serverId.value, name: sessionName.value }))
onUnmounted(() => { if (stopHeartbeat) stopHeartbeat() })

// 改名(头部中段双击/✏️):renameWindow 双写 localStorage + 网关 label 端点 → opener 任务栏
// chip 与他标签页经 storage 对账即时跟随。无记录时 store 内 no-op。
function onRename(v) { if (!sidMissing.value) sshStore.renameWindow(sid.value, v) }

// 显式关闭(2026-10-04 补完跨页摘记录):三件事——①同步直调 killSession(keepalive 使请求
// 在标签页卸载后仍送达;store 内的 best-effort 是微任务,window.close 的同步关窗竞态下可能
// 永不发出,故此处保底,重复 kill 幂等);②store.closeWindow 摘全端记录(跨页墓碑 + merge-on-write
// persist → 主页面 storage 对账摘 chip——此前缺这步,弹窗关了任务栏 chip 永挂,点开才知已死);
// ③关标签页。window.close 须在用户手势的同步调用栈里,故全部不 await。
function closeWindow() {
  if (!sidMissing.value) {
    try { sshApi.killSession(sid.value).catch(() => {}) } catch { /* noop */ }
    try { sshStore.closeWindow(sid.value) } catch { /* store 异常不阻关窗 */ }
  }
  window.close()
}

// 「+」新建终端(2026-10-04):同服务器新开一个标签页;起始目录取 SshTerminal 旁路维护的
// lastCwd(远端 shell 上报过标题才有;拿不到就不带 cwd,新终端落在默认登录目录,不报错)。
// 窗口名=新 sid(确定性):与 store.openExternal 同语义,再点「+」各开各的、互不顶号。
function openNewTerminal() {
  const newSid = genSid()
  // name 取当前会话名(sessionName,含改名后的 label):改名后「+」新开的标签页不再回退旧 query 名
  const params = new URLSearchParams({ serverId: serverId.value, sid: newSid, name: sessionName.value })
  const cwd = termRef.value?.lastCwd || ''
  if (cwd) params.set('cwd', cwd)
  window.open(`${window.location.origin}/ssh-terminal-popup?${params}`, newSid)
}
</script>

<template>
  <div class="h-screen w-screen flex flex-col bg-code-surface">
    <div class="flex-1 min-h-0">
      <div v-if="sidMissing" data-test="sid-missing" class="h-full flex items-center justify-center px-md">
        <div class="text-center max-w-md">
          <span class="material-symbols-outlined text-3xl text-error">link_off</span>
          <p class="mt-sm text-body-md text-on-surface-variant">{{ t('ssh.popupMissingSid') }}</p>
        </div>
      </div>
      <SshTerminal v-else ref="termRef" :server-id="serverId" :server-name="serverTitle" :sid="sid" :title="sessionName" :editable="!!record" :auto-connect="true" :cwd="startCwd" chrome="page" @win-close="closeWindow" @new-terminal="openNewTerminal" @rename="onRename" />
    </div>
  </div>
</template>
