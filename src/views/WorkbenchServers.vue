<script setup>
// 工作台·服务器 tab:SSH 服务器清单 + 增删改查 + 试连 + 暴露 AI 控制。
// 2026-08-29 列展示迭代:
// - 首列 = OS 图标(OsIcon,OS 探测落库的 osId 映射发行版图标)+ 名称/描述;
// - 状态列 = ok(正常)/fail(异常)/unknown(未测)三态 badge,试连即刷新;
// - 暴露 AI 列 = 状态展示 + 快速编辑 icon(原地切换开关与审批策略,即时 PUT);
// - 操作列 = 终端/文件 + 更多▾(测试连接/编辑/删除收进菜单,降低行内按钮密度);
//   手机档(Wave5 R5)清单迁 DataTable 卡片化,更多▾在卡片 overflow 链里会被裁 → 五钮扁平组。
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { sshApi } from '@/api/client'
import SshServerForm from '@/components/ssh/SshServerForm.vue'
import SshFileBrowserWindow from '@/components/ssh/SshFileBrowserWindow.vue'
import OsIcon from '@/components/ssh/OsIcon.vue'
import ToggleSwitch from '@/components/ssh/ToggleSwitch.vue'
import ServerLedgerPanel from '@/components/ssh/ServerLedgerPanel.vue'
import { useSshTerminalStore } from '@/stores/sshTerminals'
import { useAuthStore } from '@/stores/auth'
import { Z } from '@/styles/zScale'
import DataTable from '@/components/common/DataTable.vue'
import { useIsPhone } from '@/composables/useBreakpoint'

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
    await sshApi.update(s.id, { exposeToAi: expose ?? s.exposeToAi, aiApprovalPolicy: quickPolicy.value })
    await qc.invalidateQueries({ queryKey: ['ssh', 'servers'] })
    if (expose == null) exposeQuick.value = ''
  } catch (e) { testResult.value = { name: s.name, ok: false, message: e?.message } }
  finally { exposeBusy.value = false }
}

// —— 暴露 toggle:行内直改(所见即所改);chevron 进策略微调 ——
async function onExposeToggle(s, v) {
  exposeBusy.value = true
  try {
    await sshApi.update(s.id, { exposeToAi: v, aiApprovalPolicy: v ? (s.aiApprovalPolicy || 'always') : s.aiApprovalPolicy })
    await qc.invalidateQueries({ queryKey: ['ssh', 'servers'] })
  } catch (e) { testResult.value = { name: s.name, ok: false, message: e?.message } }
  finally { exposeBusy.value = false }
}

// —— 台账弹窗(2026-08-29 双域化):内容迁 ServerLedgerPanel,弹窗只留壳 ——
const showLedger = ref(false)

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

// —— 清单迁 DataTable(Wave5 R5):手机自动卡片化(首列=标题),列 slot 双分支同源 ——
const { isPhone } = useIsPhone()
const serverHeaders = computed(() => [
  { key: 'name', label: t('ssh.name') },
  { key: 'status', label: t('ssh.statusCol') },
  { key: 'host', label: t('ssh.host') },
  { key: 'username', label: t('ssh.username') },
  { key: 'cred', label: t('ssh.credState') },
  { key: 'expose', label: t('ssh.exposeToAi') },
  { key: 'actions', label: t('ssh.actions') },
])
const serverRows = computed(() => servers.value.map(s => ({ ...s, cred: credState(s) })))
defineExpose({ servers })
</script>

<template>
  <section class="flex flex-col gap-md">
    <div class="flex items-center justify-between">
      <h3 class="text-title-md font-bold">{{ t('ssh.title') }}</h3>
      <div v-if="isAdmin" class="flex items-center gap-sm">
        <button data-test="btnLedger" @click="showLedger = true" class="px-md py-sm bg-secondary-container/60 text-on-secondary-container rounded-lg text-body-sm font-semibold flex items-center gap-xs">
          <span class="material-symbols-outlined text-base">menu_book</span>{{ t('ssh.ledger') }}</button>
        <button data-test="btnAdd" @click="openCreate" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold">
          {{ t('ssh.addServer') }}</button>
      </div>
    </div>
    <template v-if="isAdmin">
      <div v-if="isLoading" class="text-body-sm text-on-surface-variant">{{ t('common.loading') }}</div>
      <DataTable v-else :headers="serverHeaders" :rows="serverRows" row-key="id">
        <template #name="{ row }">
          <div data-test="serverRow" class="flex items-center gap-sm min-w-0">
            <OsIcon :os-id="row.osId" :os-name="row.osName || row.name" />
            <div class="min-w-0">
              <div class="font-mono truncate">{{ row.name }}</div>
              <div v-if="row.description || row.osName" class="text-on-surface-variant/60 text-body-xs truncate">{{ row.osName || row.description }}</div>
            </div>
          </div>
        </template>
        <template #status="{ row }">
          <span data-test="statusBadge" class="inline-flex items-center gap-xs px-sm py-0.5 rounded-full border text-body-xs" :class="statusBadge(row).cls">
            <span class="w-1.5 h-1.5 rounded-full" :class="statusBadge(row).dot"></span>{{ statusBadge(row).label }}
          </span>
        </template>
        <template #host="{ row }"><span class="font-mono text-body-xs break-all">{{ row.host }}:{{ row.port }}</span></template>
        <template #username="{ row }"><span class="font-mono text-body-xs truncate">{{ row.username }}</span></template>
        <template #cred="{ row }"><span class="text-body-xs">{{ row.cred }}</span></template>
        <template #expose="{ row }">
          <div class="flex items-center gap-xs flex-wrap" data-test="exposeCell">
            <ToggleSwitch :checked="row.exposeToAi" data-test="exposeSwitch" :disabled="exposeBusy"
              :title="t('ssh.exposeToggleTitle')" @update:checked="v => onExposeToggle(row, v)" />
            <template v-if="exposeQuick === row.id">
              <select data-test="quickExposePolicy" v-model="quickPolicy" :disabled="exposeBusy"
                class="bg-surface-container-lowest border border-outline-variant rounded px-xs py-0.5 text-body-xs"
                @change="saveQuickExpose(row, row.exposeToAi)">
                <option value="always">{{ policyLabel('always') }}</option>
                <option value="readonly">{{ policyLabel('readonly') }}</option>
                <option value="none">{{ policyLabel('none') }}</option>
              </select>
            </template>
            <span v-else-if="row.exposeToAi" class="text-body-xs text-primary truncate max-w-[120px]" :title="t('ssh.quickExposeTitle')">{{ policyLabel(row.aiApprovalPolicy) }}</span>
            <button v-if="isAdmin && row.exposeToAi && exposeQuick !== row.id" data-test="btnQuickExpose" @click="startQuickExpose(row)"
              class="p-xs rounded hover:bg-surface-container text-on-surface-variant/60 hover:text-primary" :title="t('ssh.quickExposeTitle')">
              <span class="material-symbols-outlined text-sm">tune</span>
            </button>
          </div>
        </template>
        <template #actions="{ row }">
          <!-- 手机:下拉在卡片 overflow 链里会被裁 → 扁平按钮组 -->
          <div v-if="isPhone" class="flex flex-wrap items-center gap-xs">
            <button data-test="btnTerm" @click="sshTerminals.openOrFocus(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg bg-primary-container/60 text-body-xs">{{ t('ssh.terminal') }}</button>
            <button data-test="btnFiles" @click="openFiles(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg bg-secondary-container/60 text-body-xs">{{ t('ssh.files') }}</button>
            <button data-test="btnTest" @click="onTest(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg border border-outline-variant text-body-xs">{{ t('ssh.testConnection') }}</button>
            <button data-test="btnEdit" @click="openEdit(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg border border-outline-variant text-body-xs">{{ t('common.edit') }}</button>
            <button data-test="btnDelete" @click="onDelete(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg border border-error/30 text-error text-body-xs">{{ t('common.delete') }}</button>
          </div>
          <!-- 桌面:终端/文件 + 更多▾ 下拉 -->
          <div v-else class="flex items-center gap-xs">
            <button data-test="btnTerm" @click="sshTerminals.openOrFocus(row)" class="relative px-sm py-xs rounded-lg bg-primary-container/60 text-body-xs max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">{{ t('ssh.terminal') }}</button>
            <button data-test="btnFiles" @click="openFiles(row)" class="relative px-sm py-xs rounded-lg bg-secondary-container/60 text-body-xs max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">{{ t('ssh.files') }}</button>
            <div class="relative">
              <button v-if="isAdmin" data-test="btnMore" @click="toggleMore(row)"
                class="px-xs py-xs rounded-lg bg-surface-container text-body-xs text-on-surface-variant hover:text-primary"
                :title="t('ssh.moreActions')">
                <span class="material-symbols-outlined text-base align-middle">more_vert</span>
              </button>
              <!-- 更多菜单:任务栏同款遮罩+下拉 -->
              <div v-if="moreOpenFor === row.id" class="absolute bottom-full mb-xs left-0 min-w-[140px] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-xl p-xs whitespace-nowrap" style="z-index: 101">
                <button data-test="moreTest" @click="moreAction(row, 'test')" class="w-full flex items-center gap-xs px-sm py-xs rounded-md text-body-xs hover:bg-surface-container text-left">
                  <span class="material-symbols-outlined text-sm">network_check</span>{{ t('ssh.testConnection') }}</button>
                <button data-test="moreEdit" @click="moreAction(row, 'edit')" class="w-full flex items-center gap-xs px-sm py-xs rounded-md text-body-xs hover:bg-surface-container text-left">
                  <span class="material-symbols-outlined text-sm">edit</span>{{ t('common.edit') }}</button>
                <button data-test="moreDelete" @click="moreAction(row, 'delete')" class="w-full flex items-center gap-xs px-sm py-xs rounded-md text-body-xs text-error hover:bg-error/10 text-left">
                  <span class="material-symbols-outlined text-sm">delete</span>{{ t('common.delete') }}</button>
              </div>
            </div>
          </div>
        </template>
      </DataTable>
      <p v-if="testResult" data-test="testResult" class="text-body-sm" :class="testResult.ok ? 'text-primary' : 'text-error'">
        [{{ testResult.name }}] {{ testResult.message }}</p>

      <!-- 弹窗 Teleport body(2026-09-05):wb-rise fill 事故前 pane 带常驻 transform 会把
           position:fixed 变相降级为「相对 pane 定位+被 stage 裁切」;即便根因已修(backwards),
           入场动画进行中的 0.28s 窗口内 transform 仍在——传送型浮层一律挂 body 走 Z 阶梯(issue#4 配方) -->
      <teleport to="body">
        <div v-if="showForm" class="fixed inset-0 flex items-center justify-center bg-on-surface/40" :style="{ zIndex: Z.modal }" @click.self="showForm = false">
          <div class="bg-surface-container-low rounded-xl p-lg w-[min(720px,calc(100vw-2rem))] max-h-[90vh] overflow-y-auto">
            <h4 class="text-title-md font-bold mb-md">{{ editing ? t('ssh.editServer') : t('ssh.addServer') }}</h4>
            <SshServerForm :server="editing" :busy="busy" @submit="onSubmit" @cancel="showForm = false" />
          </div>
        </div>
      </teleport>
    </template>
    <p v-else class="text-body-sm text-on-surface-variant">{{ t('ssh.readonlyNotice') }}</p>
    <!-- 台账弹窗:内容为 ServerLedgerPanel(结构层只读+自由层编辑,与知识 tab 服务器区同源);Teleport body 同上 -->
    <teleport to="body">
      <div v-if="showLedger" data-test="ledgerModal" class="fixed inset-0 flex items-center justify-center bg-on-surface/40" :style="{ zIndex: Z.modal }" @click.self="showLedger = false">
        <div class="bg-surface-container-low rounded-xl p-lg w-[min(860px,calc(100vw-2rem))] max-h-[90vh] overflow-y-auto flex flex-col gap-md">
          <h4 class="text-title-md font-bold">{{ t('ssh.ledger') }}</h4>
          <ServerLedgerPanel />
          <div class="flex justify-end">
            <button @click="showLedger = false" class="px-lg py-sm rounded-lg border text-body-sm">{{ t('common.close') }}</button>
          </div>
        </div>
      </div>
    </teleport>
    <!-- SSH 终端浮窗已迁 AppLayout 全局宿主:切页/刷新不丢,进任务栏 SSH 分区 -->
    <!-- SSH 文件浏览浮窗:同机去重,close 即销毁;Teleport body(浮窗坐标是视口系,受困同上) -->
    <teleport to="body">
      <SshFileBrowserWindow v-for="(b, i) in sshBrowsers" :key="b.serverId" :server-id="b.serverId" :name="b.name"
        :cascade-index="i" @close="closeBrowser(b.serverId)" />
    </teleport>
  </section>
</template>
