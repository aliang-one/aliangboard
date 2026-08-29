<script setup>
// 工作台·服务器 tab:SSH 服务器清单 + 增删改查 + 试连 + 暴露 AI 控制。
// 2026-08-29 列展示迭代:
// - 首列 = OS 图标(OsIcon,OS 探测落库的 osId 映射发行版图标)+ 名称/描述;
// - 状态列 = ok(正常)/fail(异常)/unknown(未测)三态 badge,试连即刷新;
// - 暴露 AI 列 = 状态展示 + 快速编辑 icon(原地切换开关与审批策略,即时 PUT);
// - 操作列 = 终端/文件 + 更多▾(测试连接/编辑/删除收进菜单,降低行内按钮密度)。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { sshApi } from '@/api/client'
import SshServerForm from '@/components/ssh/SshServerForm.vue'
import SshFileBrowserWindow from '@/components/ssh/SshFileBrowserWindow.vue'
import OsIcon from '@/components/ssh/OsIcon.vue'
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
const emit = defineEmits(['openFiles'])
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
        qc.invalidateQueries({ queryKey: ['ssh', 'servers'] })   // 指纹列即时刷新
        const r2 = await sshApi.testSaved(s.id)
        testResult.value = { name: s.name, ok: r2.ok, message: r2.ok ? t('ssh.testOk') : r2.message }
        return
      }
    }
    testResult.value = { name: s.name, ok: r.ok, message: r.ok ? t('ssh.testOk') : r.message }
    qc.invalidateQueries({ queryKey: ['ssh', 'servers'] })   // 状态/OS 图标即时刷新
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

// —— 暴露 AI 快速编辑(原地):exposeQuick = 行 id;开关/策略即时 PUT ——
const exposeQuick = ref('')
const exposeBusy = ref(false)
const quickPolicy = ref('always')
function startQuickExpose(s) {
  exposeQuick.value = s.id
  quickPolicy.value = s.aiApprovalPolicy || 'always'
}
async function saveQuickExpose(s, expose) {
  exposeBusy.value = true
  try {
    await sshApi.update(s.id, { exposeToAi: expose, aiApprovalPolicy: quickPolicy.value })
    await qc.invalidateQueries({ queryKey: ['ssh', 'servers'] })
    exposeQuick.value = ''
  } catch (e) { testResult.value = { name: s.name, ok: false, message: e?.message } }
  finally { exposeBusy.value = false }
}

// —— 更多菜单(每行一个,同时至多一个展开)——
const moreOpenFor = ref('')
function toggleMore(s) { moreOpenFor.value = moreOpenFor.value === s.id ? '' : s.id }
async function moreAction(s, action) {
  moreOpenFor.value = ''
  if (action === 'test') await onTest(s)
  else if (action === 'edit') openEdit(s)
  else if (action === 'delete') await onDelete(s)
}
const statusBadge = s => s.status === 'ok'
  ? { cls: 'bg-primary-container/40 text-primary border-primary/30', dot: 'bg-primary', label: t('ssh.statusOk') }
  : s.status === 'fail'
    ? { cls: 'bg-error-container/40 text-error border-error/30', dot: 'bg-error', label: t('ssh.statusFail') }
    : { cls: 'bg-surface-container text-on-surface-variant border-outline-variant/40', dot: 'bg-on-surface-variant/40', label: t('ssh.statusUnknown') }
const policyLabel = p => t(`ssh.policy${String(p || 'always')[0].toUpperCase()}${String(p || 'always').slice(1)}`)
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
          <th class="py-sm px-sm">{{ t('ssh.name') }}</th><th class="py-sm px-sm">{{ t('ssh.statusCol') }}</th>
          <th class="py-sm px-sm">{{ t('ssh.host') }}</th>
          <th class="py-sm px-sm">{{ t('ssh.username') }}</th><th class="py-sm px-sm">{{ t('ssh.credState') }}</th>
          <th class="py-sm px-sm">{{ t('ssh.exposeToAi') }}</th>
          <th class="py-sm px-sm">{{ t('ssh.actions') }}</th>
        </tr></thead>
        <tbody>
          <tr v-for="s in servers" :key="s.id" data-test="serverRow" class="border-b border-outline-variant/40 hover:bg-surface-container/50">
            <!-- 首列:OS 图标 + 名称/描述 -->
            <td class="py-sm px-sm">
              <div class="flex items-center gap-sm">
                <OsIcon :os-id="s.osId" :os-name="s.osName || s.name" />
                <div class="min-w-0">
                  <div class="font-mono truncate">{{ s.name }}</div>
                  <div v-if="s.description || s.osName" class="text-on-surface-variant/60 text-body-xs truncate">
                    {{ s.osName || s.description }}</div>
                </div>
              </div>
            </td>
            <!-- 状态:三态 badge -->
            <td class="py-sm px-sm">
              <span data-test="statusBadge" class="inline-flex items-center gap-xs px-sm py-0.5 rounded-full border text-body-xs" :class="statusBadge(s).cls">
                <span class="w-1.5 h-1.5 rounded-full" :class="statusBadge(s).dot"></span>{{ statusBadge(s).label }}
              </span>
            </td>
            <td class="py-sm px-sm font-mono">{{ s.host }}:{{ s.port }}</td>
            <td class="py-sm px-sm font-mono">{{ s.username }}</td>
            <td class="py-sm px-sm">{{ credState(s) }}</td>
            <!-- 暴露 AI:状态 + 快速编辑 -->
            <td class="py-sm px-sm">
              <template v-if="exposeQuick === s.id">
                <div class="flex items-center gap-xs" data-test="quickExpose">
                  <label class="flex items-center gap-xs cursor-pointer">
                    <input type="checkbox" :checked="s.exposeToAi" data-test="quickExposeSwitch"
                      @change="saveQuickExpose(s, $event.target.checked)" :disabled="exposeBusy" class="w-4 h-4" />
                    <select data-test="quickExposePolicy" v-model="quickPolicy" :disabled="exposeBusy"
                      class="bg-surface-container-lowest border border-outline-variant rounded px-xs py-0.5 text-body-xs">
                      <option value="always">{{ policyLabel('always') }}</option>
                      <option value="readonly">{{ policyLabel('readonly') }}</option>
                      <option value="none">{{ policyLabel('none') }}</option>
                    </select>
                  </label>
                  <button @click="exposeQuick = ''" class="px-xs py-0.5 rounded text-body-xs text-on-surface-variant hover:bg-surface-container">{{ t('common.cancel') }}</button>
                </div>
              </template>
              <template v-else>
                <div class="flex items-center gap-xs">
                  <span v-if="s.exposeToAi" class="text-primary">{{ policyLabel(s.aiApprovalPolicy) }}</span>
                  <span v-else class="text-on-surface-variant/50" :title="t('ssh.exposeHint')">—</span>
                  <button v-if="isAdmin" data-test="btnQuickExpose" @click="startQuickExpose(s)"
                    class="p-xs rounded hover:bg-surface-container text-on-surface-variant/60 hover:text-primary" :title="t('ssh.quickExposeTitle')">
                    <span class="material-symbols-outlined text-sm">edit</span>
                  </button>
                </div>
              </template>
            </td>
            <!-- 操作:终端/文件 + 更多▾ -->
            <td class="py-sm px-sm">
              <div class="flex items-center gap-xs">
                <button data-test="btnTerm" @click="sshTerminals.openOrFocus(s)" class="px-sm py-xs rounded-lg bg-primary-container/60 text-body-xs">{{ t('ssh.terminal') }}</button>
                <button data-test="btnFiles" @click="openFiles(s)" class="px-sm py-xs rounded-lg bg-secondary-container/60 text-body-xs">{{ t('ssh.files') }}</button>
                <div class="relative">
                  <button v-if="isAdmin" data-test="btnMore" @click="toggleMore(s)"
                    class="px-xs py-xs rounded-lg bg-surface-container text-body-xs text-on-surface-variant hover:text-primary"
                    :title="t('ssh.moreActions')">
                    <span class="material-symbols-outlined text-base align-middle">more_vert</span>
                  </button>
                  <!-- 更多菜单:任务栏同款遮罩+下拉 -->
                  <div v-if="moreOpenFor === s.id" class="absolute bottom-full mb-xs left-0 min-w-[140px] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-xl p-xs whitespace-nowrap" style="z-index: 101">
                    <button data-test="moreTest" @click="moreAction(s, 'test')" class="w-full flex items-center gap-xs px-sm py-xs rounded-md text-body-xs hover:bg-surface-container text-left">
                      <span class="material-symbols-outlined text-sm">network_check</span>{{ t('ssh.testConnection') }}</button>
                    <button data-test="moreEdit" @click="moreAction(s, 'edit')" class="w-full flex items-center gap-xs px-sm py-xs rounded-md text-body-xs hover:bg-surface-container text-left">
                      <span class="material-symbols-outlined text-sm">edit</span>{{ t('common.edit') }}</button>
                    <button data-test="moreDelete" @click="moreAction(s, 'delete')" class="w-full flex items-center gap-xs px-sm py-xs rounded-md text-body-xs text-error hover:bg-error/10 text-left">
                      <span class="material-symbols-outlined text-sm">delete</span>{{ t('common.delete') }}</button>
                  </div>
                </div>
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
    <!-- SSH 终端浮窗已迁 AppLayout 全局宿主:切页/刷新不丢,进任务栏 SSH 分区 -->
    <!-- SSH 文件浏览浮窗:同机去重,close 即销毁 -->
    <SshFileBrowserWindow v-for="(b, i) in sshBrowsers" :key="b.serverId" :server-id="b.serverId" :name="b.name"
      :cascade-index="i" @close="closeBrowser(b.serverId)" />
  </section>
</template>
