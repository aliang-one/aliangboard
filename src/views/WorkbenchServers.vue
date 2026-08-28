<script setup>
// 工作台·服务器 tab:SSH 服务器清单 + 增删改查 + 试连 + 暴露 AI 控制。
// 数据层 Vue Query(['ssh','servers']);终端/文件入口由 Task 8/15 挂接(本任务 emit 预留)。
// 全部 SSH REST 端点 admin-only(Task 3 裁决):非 admin 不发 list 请求、只渲染只读提示,
// 试连/编辑/删除按钮同样 admin 门禁;终端/文件按钮留给 Task 8/15 接线。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { sshApi } from '@/api/client'
import SshServerForm from '@/components/ssh/SshServerForm.vue'
import SshTerminalWindow from '@/components/ssh/SshTerminalWindow.vue'
import SshFileBrowserWindow from '@/components/ssh/SshFileBrowserWindow.vue'
import { useSshTerminalStore } from '@/stores/sshTerminals'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const qc = useQueryClient()
const auth = useAuthStore()
const isAdmin = computed(() => auth.isAdmin)

const { data, isLoading } = useQuery({
  queryKey: ['ssh', 'servers'],
  queryFn: () => sshApi.list().then(r => r.servers || []),
  enabled: isAdmin,   // 非 admin list 端点 403,不发请求
})
const servers = computed(() => data.value || [])

const showForm = ref(false)
const editing = ref(null)
const busy = ref(false)
const testResult = ref(null)   // {name, ok, message}
const emit = defineEmits(['openFiles'])   // Task 15 消费;终端浮窗在本地 store 内渲染
const sshTerminals = useSshTerminalStore()
// 文件浏览浮窗:本地 ref 数组,同机去重(每服务器一窗);close 即销毁(传输中止在 Body onBeforeUnmount)
const sshBrowsers = ref([])
function openFiles(s) {
  emit('openFiles', s)
  if (!sshBrowsers.value.some(b => b.serverId === s.id)) sshBrowsers.value.push({ serverId: s.id, name: s.name })
}
const closeBrowser = s => { sshBrowsers.value = sshBrowsers.value.filter(b => b.serverId !== s) }

function openCreate() { editing.value = null; showForm.value = true }
function openEdit(s) { editing.value = s; showForm.value = true }
async function onSubmit(payload) {
  busy.value = true
  try {
    if (editing.value) await sshApi.update(editing.value.id, payload)
    else await sshApi.create(payload)
    showForm.value = false
    await qc.invalidateQueries({ queryKey: ['ssh', 'servers'] })
  } catch (e) { testResult.value = { name: '-', ok: false, message: e?.message } }
  finally { busy.value = false }
}
async function onTest(s) {
  testResult.value = { name: s.name, ok: null, message: t('ssh.testing') }
  try {
    const r = await sshApi.testSaved(s.id)
    // 主机密钥变更(spec §5/§9):确认后清旧指纹并自动重试一次(重连时重录新指纹);拒绝则保留防护
    if (!r.ok && r.errorKind === 'hostkey') {
      if (window.confirm(t('ssh.hostKeyChangedConfirm', { name: s.name }))) {
        await sshApi.update(s.id, { hostKeyFingerprint: '' })
        const r2 = await sshApi.testSaved(s.id)
        testResult.value = { name: s.name, ok: r2.ok, message: r2.ok ? t('ssh.testOk') : r2.message }
        return
      }
    }
    testResult.value = { name: s.name, ok: r.ok, message: r.ok ? t('ssh.testOk') : r.message }
  }
  catch (e) { testResult.value = { name: s.name, ok: false, message: e?.message } }
}
async function onDelete(s) {
  if (!window.confirm(t('ssh.deleteConfirm', { name: s.name }))) return
  await sshApi.remove(s.id)
  await qc.invalidateQueries({ queryKey: ['ssh', 'servers'] })
}
const credState = s => s.authMethod === 'password'
  ? (s.hasPassword ? t('ssh.credOk') : t('ssh.credMissing'))
  : (s.hasPrivateKey ? t('ssh.credOk') : t('ssh.credMissing'))
defineExpose({ servers })
</script>

<template>
  <section class="flex flex-col gap-md">
    <div class="flex items-center justify-between">
      <h3 class="text-title-md font-bold">{{ t('ssh.title') }}</h3>
      <button v-if="isAdmin" data-test="btnAdd" @click="openCreate" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">
        {{ t('ssh.addServer') }}</button>
    </div>
    <template v-if="isAdmin">
      <div v-if="isLoading" class="text-body-sm text-on-surface-variant">{{ t('common.loading') }}</div>
      <table v-else class="w-full text-body-sm border-collapse">
        <thead><tr class="text-left text-on-surface-variant border-b border-outline-variant">
          <th class="py-sm px-sm">{{ t('ssh.name') }}</th><th class="py-sm px-sm">{{ t('ssh.host') }}</th>
          <th class="py-sm px-sm">{{ t('ssh.username') }}</th><th class="py-sm px-sm">{{ t('ssh.authMethod') }}</th>
          <th class="py-sm px-sm">{{ t('ssh.credState') }}</th><th class="py-sm px-sm">{{ t('ssh.exposeToAi') }}</th>
          <th class="py-sm px-sm">{{ t('ssh.actions') }}</th>
        </tr></thead>
        <tbody>
          <tr v-for="s in servers" :key="s.id" data-test="serverRow" class="border-b border-outline-variant/40 hover:bg-surface-container/50">
            <td class="py-sm px-sm font-mono">{{ s.name }}<span v-if="s.description" class="text-on-surface-variant/60 text-body-xs ml-xs">{{ s.description }}</span></td>
            <td class="py-sm px-sm font-mono">{{ s.host }}:{{ s.port }}</td>
            <td class="py-sm px-sm font-mono">{{ s.username }}</td>
            <td class="py-sm px-sm">{{ s.authMethod === 'password' ? t('ssh.authPassword') : t('ssh.authPrivateKey') }}</td>
            <td class="py-sm px-sm">{{ credState(s) }}</td>
            <td class="py-sm px-sm">
              <span v-if="s.exposeToAi" class="text-primary">✓ {{ t(`ssh.policy${s.aiApprovalPolicy[0].toUpperCase()}${s.aiApprovalPolicy.slice(1)}`) }}</span>
              <span v-else class="text-on-surface-variant/50">—</span>
            </td>
            <td class="py-sm px-sm">
              <div class="flex gap-xs">
                <button data-test="btnTerm" @click="sshTerminals.openTerminal(s)" class="px-sm py-xs rounded-lg bg-primary-container/60 text-body-xs">{{ t('ssh.terminal') }}</button>
                <button data-test="btnFiles" @click="openFiles(s)" class="px-sm py-xs rounded-lg bg-secondary-container/60 text-body-xs">{{ t('ssh.files') }}</button>
                <button v-if="isAdmin" data-test="btnTest" @click="onTest(s)" class="px-sm py-xs rounded-lg bg-surface-container text-body-xs">{{ t('ssh.testConnection') }}</button>
                <button v-if="isAdmin" data-test="btnEdit" @click="openEdit(s)" class="px-sm py-xs rounded-lg bg-surface-container text-body-xs">{{ t('common.edit') }}</button>
                <button v-if="isAdmin" data-test="btnDel" @click="onDelete(s)" class="px-sm py-xs rounded-lg bg-error-container/40 text-body-xs">{{ t('common.delete') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="testResult" data-test="testResult" class="text-body-sm" :class="testResult.ok ? 'text-primary' : 'text-error'">
        [{{ testResult.name }}] {{ testResult.message }}</p>

      <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="showForm = false">
        <div class="bg-surface-container-low rounded-xl p-lg w-[720px] max-h-[90vh] overflow-y-auto">
          <h4 class="text-title-md font-bold mb-md">{{ editing ? t('ssh.editServer') : t('ssh.addServer') }}</h4>
          <SshServerForm :server="editing" :busy="busy" @submit="onSubmit" @cancel="showForm = false" />
        </div>
      </div>
    </template>
    <p v-else class="text-body-sm text-on-surface-variant">{{ t('ssh.readonlyNotice') }}</p>
    <!-- SSH 终端浮窗:每服务器一窗,sid 恒定(刷新回放续跑) -->
    <SshTerminalWindow v-for="w in sshTerminals.openWindows" :key="w.id" :window="w" />
    <!-- SSH 文件浏览浮窗:同机去重,close 即销毁 -->
    <SshFileBrowserWindow v-for="(b, i) in sshBrowsers" :key="b.serverId" :server-id="b.serverId" :name="b.name"
      :cascade-index="sshTerminals.openWindows.length + i" @close="closeBrowser(b.serverId)" />
  </section>
</template>
