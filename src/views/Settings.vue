<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useAuthStore } from '@/stores/auth'
import { api, adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useTableColumns } from '@/composables/useTableColumns'
import ColumnManager from '@/components/common/ColumnManager.vue'
import DataTable from '@/components/common/DataTable.vue'
import SettingsAboutPanel from '@/components/settings/SettingsAboutPanel.vue'
import AdminStatePanel from '@/components/settings/AdminStatePanel.vue'
import { i18n } from '@/i18n'
import { usePreferencesStore } from '@/stores/preferences'

const { t } = useI18n()
// 语言切换走 preferences store 单写路径(2026-08-29 终审发现 3):store 内含 setLocale+localStorage+服务端双写,
// 直调 setLocale 会绕过 store,导致 /profile 偏好卡不高亮 + fetchMe 回灌回滚用户选择。
const preferences = usePreferencesStore()

const store = useClusterStore()
const auth = useAuthStore()
const activeTab = ref('general')

const tabs = computed(() => [
  { key: 'general', label: t('settings.tabs.general'), icon: 'info' },
  { key: 'components', label: t('settings.tabs.components'), icon: 'extension' },
  { key: 'api', label: t('settings.tabs.api'), icon: 'api' },
  { key: 'customcols', label: t('settings.tabs.customcols'), icon: 'view_column' },
  { key: 'about', label: t('settings.tabs.about'), icon: 'update' },
  ...(auth.isAdmin ? [{ key: 'mcp', label: t('settings.tabs.mcp'), icon: 'hub' }] : []),
  ...(auth.isAdmin ? [{ key: 'transfers', label: t('settings.tabs.transfers'), icon: 'swap_vert' }] : []),
  ...(auth.isAdmin ? [{ key: 'ssh', label: t('settings.tabs.terminal'), icon: 'terminal' }] : []),
  ...(auth.isAdmin ? [{ key: 'security', label: t('admin.securityPolicy.title'), icon: 'security' }] : []),
  ...(auth.isAdmin ? [{ key: 'state', label: t('settings.tabs.state'), icon: 'monitor_heart' }] : []),
])

// === Components: real cluster component health ===
const components = ref([])
const apiReady = ref(null)        // null=unknown, true=ready, false=not ready
const csState = ref('idle')       // 'idle' | 'loading' | 'loaded' | 'error'
const csError = ref('')

async function loadComponents() {
  csState.value = 'loading'
  csError.value = ''
  // API Server readiness probe (/readyz returns 200 'ok' means healthy; componentstatuses deprecated since K8s 1.19)
  try { await api.k8s('/readyz'); apiReady.value = true } catch { apiReady.value = false }
  // Control plane component health (componentstatuses; most modern clusters return empty or Unhealthy, so readyz is the primary signal)
  try {
    const data = await api.k8s('/api/v1/componentstatuses')
    components.value = (data.items || []).map(it => {
      const cond = (it.conditions || []).find(c => c.type === 'Healthy') || (it.conditions || [])[0]
      return {
        name: it.metadata?.name,
        status: cond?.status === 'True' ? 'Healthy' : 'Unhealthy',
        message: cond?.message || '',
      }
    })
    csState.value = 'loaded'
  } catch (e) {
    csState.value = 'error'
    csError.value = e.message || 'Failed to read component status'
  }
}

// Components 表头(DataTable 双分支共用:桌面=表列,手机=首列卡片标题+其余键值行;Wave5 B11 裸表迁移)
const compHeaders = computed(() => [
  { key: 'name', label: t('settings.component') },
  { key: 'status', label: t('settings.componentStatus') },
  { key: 'message', label: t('settings.message') },
])

watch(activeTab, tab => { if (tab === 'components' && csState.value === 'idle') loadComponents() })
onMounted(() => {
  if (activeTab.value === 'components') loadComponents()
  if (auth.isAdmin) { loadMcpConfig(); loadTransfersConfig(); loadSshPolicy(); loadSecurityPolicy() }
})

// === MCP Service toggle (admin only) ===
const mcpEnabled = ref(true)
const mcpLoading = ref(false)
// 可直接复制执行的客户端命令；{HOST} = AliangBoard 网关地址(默认端口 8787)，<YOUR_API_KEY> = 「API Keys」签发的 key
const mcpCurrentOrigin = window.location.origin
const mcpAddCmd = 'claude mcp add --transport http aliangboard {HOST}/mcp --header "Authorization: Bearer <YOUR_API_KEY>"'
const mcpRemoveCmd = 'claude mcp remove aliangboard'
const mcpInstallCliCmd = 'npm install -g @anthropic-ai/claude-code'
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); notify('success', t('common.copySuccess')) }
  catch { notify('error', t('common.copyFailed')) }
}
async function loadMcpConfig() {
  try { const r = await adminApi.mcpConfig.get(); mcpEnabled.value = r.enabled } catch { /* 非 admin 或无权限→静默 */ }
}
async function toggleMcp() {
  mcpLoading.value = true
  try { const r = await adminApi.mcpConfig.update(!mcpEnabled.value); mcpEnabled.value = r.enabled } catch { /* notify or silent */ } finally { mcpLoading.value = false }
}

// === 文件传输限额 (admin only) ===
const tfLimit = ref(1024)
const tfSaving = ref(false)
const tfLoaded = ref(false)
async function loadTransfersConfig() {
  try { const r = await adminApi.podfileConfig.get(); tfLimit.value = r.limitMb; tfLoaded.value = true }
  catch { /* 非 admin/无权限静默 */ }
}
async function saveTransfersConfig() {
  const v = parseInt(tfLimit.value, 10)
  if (!(v >= 1 && v <= 10240)) { notify('error', t('settings.transfersInvalid')); return }
  tfSaving.value = true
  try {
    const r = await adminApi.podfileConfig.update(v)
    tfLimit.value = r.limitMb; notify('success', t('settings.transfersSaved'))
  } catch (e) { notify('error', e.message || t('settings.transfersLoadFailed')) }
  finally { tfSaving.value = false }
}

// === 终端与会话策略 (admin only;2026-09-05 由 SSH 策略卡扩展为三组统一页) ===
// 三组各自端点部分更新;一次保存串发三个 PUT,任一失败报错但不阻断其余组回显。
const sshPolicy = ref({ detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0, backendIdleMin: 10080 })
const podPolicy = ref({ idleReapMin: 30 })
const jobPolicy = ref({ ttlMin: 120, maxPerServer: 4 })
const sshPolicySaving = ref(false)
async function loadSshPolicy() {
  try { sshPolicy.value = await adminApi.sshSessionPolicy.get() } catch { /* 非 admin 静默 */ }
  try { podPolicy.value = await adminApi.podTerminalPolicy.get() } catch { /* 同上 */ }
  try { jobPolicy.value = await adminApi.sshJobPolicy.get() } catch { /* 同上 */ }
}
// 空输入→NaN(序列化为 null,服务端 400 报错),与「显式 0=禁用」区分;非法输入不静默改语义
function toInt(v) {
  if (v === '' || v === null || v === undefined) return NaN
  const n = Number(v)
  return Number.isNaN(n) ? NaN : Math.trunc(n)
}
async function saveSshPolicy() {
  sshPolicySaving.value = true
  try {
    const r = await adminApi.sshSessionPolicy.update({
      detachedIdleMin: toInt(sshPolicy.value.detachedIdleMin),
      attachedIdleMin: toInt(sshPolicy.value.attachedIdleMin),
      maxLifetimeMin: toInt(sshPolicy.value.maxLifetimeMin),
      backendIdleMin: toInt(sshPolicy.value.backendIdleMin),
    })
    sshPolicy.value = r.policy
    const r2 = await adminApi.podTerminalPolicy.update({ idleReapMin: toInt(podPolicy.value.idleReapMin) })
    podPolicy.value = r2.policy
    const r3 = await adminApi.sshJobPolicy.update({
      ttlMin: toInt(jobPolicy.value.ttlMin),
      maxPerServer: toInt(jobPolicy.value.maxPerServer),
    })
    jobPolicy.value = r3.policy
    notify('success', t('settings.sshPolicySaved'))
  } catch (e) { notify('error', e.message || t('settings.sshPolicyInvalid')) }
  finally { sshPolicySaving.value = false }
}

// === 安全策略 (admin only;2026-09-04 Wave1):密码策略 + 令牌 TTL 上限 ===
const pwPolicy = ref({ minLength: 8, requireMixed: false, requireDigit: false, requireSymbol: false })
const pwPolicySaving = ref(false)
const tokenTtl = ref(90)
const tokenTtlSaving = ref(false)
// 强制两步验证(W3 §1.5,外评 2026-09-07 修复 1):开关态 + 切换中
const mfaRequired = ref(false)
const mfaPolicyLoading = ref(false)
async function loadSecurityPolicy() {
  try { const r = await adminApi.passwordPolicy.get(); pwPolicy.value = { ...pwPolicy.value, ...r.policy } } catch { /* 非 admin 静默 */ }
  try { const r = await adminApi.tokenPolicy.get(); tokenTtl.value = r.maxTtlDays } catch { /* 非 admin 静默 */ }
  try { const r = await adminApi.mfaPolicy.get(); mfaRequired.value = !!r.enabled } catch { /* 非 admin 静默 */ }
  loadOidcConfig()
}

// === SSO 登录(OIDC)(W4 Task 5):安全策略 tab 第四卡 ===
// GET 只回 publicConfig(clientSecret 永不回传,只回 hasSecret);表单 secret 恒空,占位=已设置,
// 留空保存=保持现值(与 llm.apiKey 同惯例);redirectUri 服务端推导,只读展示+复制。
const oidc = ref({ enabled: false, issuer: '', clientId: '', clientSecret: '', scopes: '', groupsClaim: '', usernameClaim: '' })
const oidcHasSecret = ref(false)
const oidcRedirectUri = ref('')
const oidcSaving = ref(false)
const oidcTesting = ref(false)
const oidcTest = ref(null) // null=未测 | {ok:true,...} | {ok:false,error}
async function loadOidcConfig() {
  try {
    const r = await adminApi.oidcConfig.get()
    oidc.value = {
      enabled: !!r.enabled,
      issuer: r.issuer || '',
      clientId: r.clientId || '',
      clientSecret: '',   // GET 不回传,表单恒空
      scopes: r.scopes || '',
      groupsClaim: r.groupsClaim || '',
      usernameClaim: r.usernameClaim || '',
    }
    oidcHasSecret.value = !!r.hasSecret
    oidcRedirectUri.value = r.redirectUri || ''
  } catch { /* 非 admin 静默 */ }
}
async function saveOidcConfig() {
  oidcSaving.value = true
  try {
    const payload = {
      enabled: !!oidc.value.enabled,
      issuer: oidc.value.issuer.trim(),
      clientId: oidc.value.clientId.trim(),
      scopes: oidc.value.scopes.trim(),
      groupsClaim: oidc.value.groupsClaim.trim(),
      usernameClaim: oidc.value.usernameClaim.trim(),
    }
    // 空 secret 不发键 = 服务端保持现值;填了才下发
    if (oidc.value.clientSecret) payload.clientSecret = oidc.value.clientSecret
    await adminApi.oidcConfig.save(payload)
    notify('success', t('admin.securityPolicy.saved'))
    oidcTest.value = null            // 配置已变,旧测试结果作废
    await loadOidcConfig()           // 刷新回显(hasSecret 翻转)
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
  finally { oidcSaving.value = false }
}
// 测试连接:打的是「已保存」配置(服务端读库),不是表单草稿——先保存再测
async function testOidcConnection() {
  oidcTesting.value = true
  try { oidcTest.value = await adminApi.oidcConfig.test() }
  catch (e) { oidcTest.value = { ok: false, error: e?.message || 'network' } }
  finally { oidcTesting.value = false }
}
// 强制两步验证开关(W3 §1.5,外评 2026-09-07 修复 1):开后未启用用户登录只进 MFA 引导(受限 token)。
// 回传态为权威(成功即翻转本地态)。
async function toggleMfaPolicy() {
  mfaPolicyLoading.value = true
  try {
    const r = await adminApi.mfaPolicy.save({ enabled: !mfaRequired.value })
    mfaRequired.value = !!r?.enabled
    notify('success', t('admin.securityPolicy.saved'))
  } catch (e) { notify('error', e.message || t('common.opFailed')) }
  finally { mfaPolicyLoading.value = false }
}
async function savePasswordPolicy() {
  pwPolicySaving.value = true
  try {
    const r = await adminApi.passwordPolicy.save({
      minLength: Number(pwPolicy.value.minLength) || 8,
      requireMixed: !!pwPolicy.value.requireMixed,
      requireDigit: !!pwPolicy.value.requireDigit,
      requireSymbol: !!pwPolicy.value.requireSymbol,
    })
    if (r.policy) pwPolicy.value = { ...pwPolicy.value, ...r.policy }
    notify('success', t('admin.securityPolicy.saved'))
  } catch (e) { notify('error', e.message || t('admin.securityPolicy.password')) }
  finally { pwPolicySaving.value = false }
}
async function saveTokenTtl() {
  const n = Math.floor(Number(tokenTtl.value))
  if (!(n >= 1 && n <= 365)) { notify('error', t('admin.securityPolicy.tokenTtlInvalid')); return }
  tokenTtlSaving.value = true
  try {
    const r = await adminApi.tokenPolicy.save({ maxTtlDays: n })
    tokenTtl.value = r.maxTtlDays ?? n
    notify('success', t('admin.securityPolicy.saved'))
  } catch (e) { notify('error', e.message || t('admin.securityPolicy.tokenTtl')) }
  finally { tokenTtlSaving.value = false }
}

// === Custom Columns: toggleable columns + localStorage persistence (instant effect) ===
const { catalog, resetAll } = useTableColumns()
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('settings.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('settings.subtitle') }}</p>
      </div>
    </div>

    <div class="grid grid-cols-12 gap-md">
      <!-- Sidebar Tabs -->
      <div class="col-span-12 lg:col-span-3">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-sm">
          <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
            class="w-full flex items-center gap-sm px-sm py-1.5 rounded-lg text-body-sm transition-all max-sm:min-h-[40px]"
            :class="activeTab === tab.key ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'"
          >
            <span class="material-symbols-outlined text-sm">{{ tab.icon }}</span>
            {{ tab.label }}
          </button>
        </div>
      </div>

      <!-- Content -->
      <div class="col-span-12 lg:col-span-9">
        <!-- General -->
        <div v-if="activeTab === 'general'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">info</span>
            <span class="text-body-sm font-semibold">{{ t('settings.clusterInfo') }}</span>
          </div>
          <div class="p-md space-y-md">
            <!-- Language -->
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.language') }}</span>
              <div class="flex items-center gap-xs">
                <button @click="preferences.setLanguage('zh')" :class="i18n.global.locale.value === 'zh' ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant'" class="text-xs px-sm py-xs rounded-md transition-colors max-sm:min-h-[40px]">{{ t('settings.zhName') }}</button>
                <button @click="preferences.setLanguage('en')" :class="i18n.global.locale.value === 'en' ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant'" class="text-xs px-sm py-xs rounded-md transition-colors max-sm:min-h-[40px]">EN</button>
              </div>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.clusterName') }}</span>
              <span class="text-body-sm font-medium">{{ store.cluster.name }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.kubernetesVersion') }}</span>
              <span class="font-mono text-code-sm">{{ store.cluster.version }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.apiServer') }}</span>
              <span class="font-mono text-code-sm text-primary">{{ store.cluster.apiServer }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.status') }}</span>
              <span class="flex items-center gap-sm text-primary font-medium">
                <span class="w-2 h-2 bg-primary rounded-full animate-pulse-status"></span> {{ store.cluster.status }}
              </span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.nodes') }}</span>
              <span class="font-medium">{{ store.cluster.nodeCount }}</span>
            </div>
            <div class="flex justify-between py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.pods') }}</span>
              <span class="font-medium">{{ store.cluster.podCount }}</span>
            </div>
          </div>
        </div>

        <!-- Components -->
        <div v-if="activeTab === 'components'" class="space-y-md">
          <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">extension</span>
              <span class="text-body-sm font-semibold">{{ t('settings.componentStatus') }}</span>
            </div>
            <button @click="loadComponents" :disabled="csState === 'loading'"
              class="flex items-center gap-xs px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container disabled:opacity-50 max-sm:min-h-[40px]">
              <span class="material-symbols-outlined text-sm" :class="csState === 'loading' ? 'animate-spin' : ''">refresh</span>
              {{ t('settings.refresh') }}
            </button>
          </div>

          <!-- API Server 就绪探针 -->
          <div class="mx-md mb-sm flex items-center justify-between bg-surface-container-low rounded-lg px-md py-sm border border-outline-variant/50">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-on-surface-variant text-sm">api</span>
              <span class="text-body-sm font-medium">{{ t('settings.apiServerProbe') }}</span>
            </div>
            <span v-if="apiReady === null" class="text-xs text-on-surface-variant">{{ t('settings.detecting') }}</span>
            <span v-else-if="apiReady" class="flex items-center gap-sm text-primary font-medium text-xs">
              <span class="w-2 h-2 bg-primary rounded-full"></span> {{ t('settings.ready') }}
            </span>
            <span v-else class="flex items-center gap-sm text-error font-medium text-xs">
              <span class="w-2 h-2 bg-error rounded-full"></span> {{ t('settings.notReady') }}
            </span>
          </div>

          <!-- 加载 / 错误(表格外置,DataTable 自带卡壳) -->
          <div v-if="csState === 'loading'" class="p-md text-center text-on-surface-variant">
            <span class="material-symbols-outlined animate-spin">progress_activity</span>
            <p class="text-body-sm mt-xs">{{ t('settings.loadingComponent') }}</p>
          </div>
          <div v-else-if="csState === 'error'" class="p-md text-center">
            <span class="material-symbols-outlined text-error">error</span>
            <p class="text-body-sm text-error mt-xs">{{ csError }}</p>
            <button @click="loadComponents" class="mt-md px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container max-sm:min-h-[40px]">{{ t('settings.retry') }}</button>
          </div>
          </div>
          <!-- 裸表迁 DataTable(Wave5 B11):message 列长 URL(etcd healthz)手机卡片模式自带 min-w-0 收敛 -->
          <DataTable v-if="csState === 'loaded'" :headers="compHeaders" :rows="components" row-key="name">
            <template #name="{ row }"><span class="text-body-sm font-medium">{{ row.name }}</span></template>
            <template #status="{ row }">
              <span class="flex items-center gap-sm">
                <span class="w-2 h-2 rounded-full" :class="row.status === 'Healthy' ? 'bg-primary' : 'bg-error'"></span>
                <span class="text-xs font-medium" :class="row.status === 'Healthy' ? 'text-primary' : 'text-error'">{{ row.status }}</span>
              </span>
            </template>
            <template #message="{ row }">
              <span class="font-mono text-code-sm text-on-surface-variant block truncate max-w-[400px]" :title="row.message">{{ row.message || '—' }}</span>
            </template>
          </DataTable>
        </div>

        <!-- API Server -->
        <div v-if="activeTab === 'api'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">api</span>
            <span class="text-body-sm font-semibold">{{ t('settings.apiConfig') }}</span>
          </div>
          <div class="p-md space-y-md">
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.endpoint') }}</span>
              <span class="font-mono text-code-sm text-primary">{{ store.cluster.apiServer }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.authentication') }}</span>
              <span class="text-body-sm">{{ t('settings.authMethod') }}</span>
            </div>
            <div class="flex justify-between py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.apiVersion') }}</span>
              <span class="font-mono text-code-sm">{{ store.cluster.version || 'v1' }}</span>
            </div>
          </div>
        </div>

        <!-- Custom Columns -->
        <div v-if="activeTab === 'customcols'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">view_column</span>
              <span class="text-body-sm font-semibold">{{ t('settings.customDisplay') }}</span>
            </div>
            <button @click="resetAll" class="px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium text-on-surface-variant hover:bg-surface-container max-sm:min-h-[40px]">{{ t('settings.resetAll') }}</button>
          </div>
          <div class="p-md space-y-md">
            <p class="text-xs text-on-surface-variant">{{ t('settings.customDisplayDesc') }}</p>
            <div v-for="tbl in catalog" :key="tbl.key" class="border border-outline-variant/60 rounded-lg p-md">
              <div class="flex items-center gap-sm mb-sm">
                <span class="material-symbols-outlined text-primary text-sm">{{ tbl.icon }}</span>
                <span class="text-body-sm font-semibold">{{ t(tbl.labelKey) || tbl.label }}</span>
              </div>
              <ColumnManager :table-key="tbl.key" />
            </div>
          </div>
        </div>

        <!-- About -->
        <SettingsAboutPanel v-if="activeTab === 'about'" />

        <!-- State overview (admin only) -->
        <AdminStatePanel v-if="activeTab === 'state'" />

        <!-- MCP Service tab (admin only) -->
        <div v-if="activeTab === 'mcp'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">hub</span>
            <span class="text-body-sm font-semibold">{{ t('settings.mcpTitle') }}</span>
          </div>
          <div class="p-md space-y-md">
            <!-- Toggle + Status card(开关本体 w-12 h-6 不改尺寸;行给 max-sm:min-h-[40px],开关钮以 after 扩命中区) -->
            <div class="flex items-center justify-between p-md rounded-lg border transition-colors max-sm:min-h-[40px]"
              :class="mcpEnabled ? 'border-status-running/30 bg-status-running/5' : 'border-outline-variant bg-surface-container-low'">
              <div class="flex items-center gap-md">
                <span class="w-3 h-3 rounded-full transition-colors" :class="mcpEnabled ? 'bg-status-running' : 'bg-on-surface-variant/30'"></span>
                <div>
                  <p class="text-body-sm font-semibold transition-colors" :class="mcpEnabled ? 'text-status-running' : 'text-on-surface-variant'">
                    {{ mcpEnabled ? t('settings.mcpEnabled') : t('settings.mcpDisabled') }}
                  </p>
                  <p class="text-body-xs text-on-surface-variant">{{ mcpEnabled ? t('settings.mcpRunningHint') : t('settings.mcpDisabledHint') }}</p>
                </div>
              </div>
              <button @click="toggleMcp" :disabled="mcpLoading"
                class="relative w-12 h-6 rounded-full transition-colors flex-shrink-0 max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"
                :class="mcpEnabled ? 'bg-status-running' : 'bg-outline-variant'">
                <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform shadow-sm"
                  :class="mcpEnabled ? 'translate-x-6' : 'translate-x-0'"></span>
              </button>
            </div>
            <!-- Usage hint (when enabled): copy-paste install / remove / rotate commands -->
            <div v-if="mcpEnabled" class="space-y-md p-md rounded-lg bg-surface-container-low border border-outline-variant/50">
              <p class="text-body-sm font-semibold text-on-surface">{{ t('settings.mcpUsageTitle') }}</p>

              <!-- ① 安装命令 -->
              <div class="space-y-xs">
                <div class="flex items-center justify-between">
                  <span class="text-body-xs font-semibold text-on-surface">{{ t('settings.mcpAddCmdLabel') }}</span>
                  <button @click="copyText(mcpAddCmd)" type="button"
                    class="relative flex items-center gap-xs px-xs py-0.5 rounded text-body-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
                    <span class="material-symbols-outlined text-sm">content_copy</span>{{ t('common.copy') }}
                  </button>
                </div>
                <pre class="text-code-sm font-mono text-on-surface bg-surface-container-high/60 px-md py-sm rounded-lg overflow-x-auto whitespace-pre-wrap break-all">{{ mcpAddCmd }}</pre>
                <p class="text-body-xs text-on-surface-variant">{{ t('settings.mcpAddCmdHint', { origin: mcpCurrentOrigin }) }}</p>
                <p class="text-body-xs text-on-surface-variant">{{ t('settings.mcpHostHint') }}</p>
              </div>

              <!-- ② 移除 / 换 Key 命令 -->
              <div class="space-y-xs">
                <div class="flex items-center justify-between">
                  <span class="text-body-xs font-semibold text-on-surface">{{ t('settings.mcpRemoveCmdLabel') }}</span>
                  <button @click="copyText(mcpRemoveCmd)" type="button"
                    class="relative flex items-center gap-xs px-xs py-0.5 rounded text-body-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
                    <span class="material-symbols-outlined text-sm">content_copy</span>{{ t('common.copy') }}
                  </button>
                </div>
                <pre class="text-code-sm font-mono text-on-surface bg-surface-container-high/60 px-md py-sm rounded-lg overflow-x-auto whitespace-pre-wrap break-all">{{ mcpRemoveCmd }}</pre>
                <p class="text-body-xs text-on-surface-variant">{{ t('settings.mcpRemoveCmdHint') }}</p>
              </div>

              <!-- ③ 安装 claude CLI(可选) -->
              <div class="space-y-xs">
                <div class="flex items-center justify-between">
                  <span class="text-body-xs font-semibold text-on-surface">{{ t('settings.mcpInstallCliLabel') }}</span>
                  <button @click="copyText(mcpInstallCliCmd)" type="button"
                    class="relative flex items-center gap-xs px-xs py-0.5 rounded text-body-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
                    <span class="material-symbols-outlined text-sm">content_copy</span>{{ t('common.copy') }}
                  </button>
                </div>
                <pre class="text-code-sm font-mono text-on-surface bg-surface-container-high/60 px-md py-sm rounded-lg overflow-x-auto whitespace-pre-wrap break-all">{{ mcpInstallCliCmd }}</pre>
              </div>

              <p class="text-body-xs text-on-surface-variant">{{ t('settings.mcpUsageNote') }}</p>
            </div>
          </div>
        </div>

        <!-- File Transfer limit tab (admin only) -->
        <div v-if="activeTab === 'transfers'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">swap_vert</span>
            <span class="text-body-sm font-semibold">{{ t('settings.transfersTitle') }}</span>
          </div>
          <div class="p-md space-y-md">
            <div class="flex items-center gap-sm">
              <label class="text-body-sm text-on-surface-variant shrink-0">{{ t('settings.transfersLimitLabel') }}</label>
              <input v-model="tfLimit" type="number" min="1" max="10240" class="w-32 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              <button @click="saveTransfersConfig" :disabled="tfSaving" class="px-sm py-1 rounded-md bg-primary text-on-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50 max-sm:min-h-[40px]">
                {{ t('common.save') }}
              </button>
            </div>
            <p class="text-body-xs text-on-surface-variant">{{ t('settings.transfersLimitHint') }}</p>
          </div>
        </div>

        <!-- 终端与会话 tab (admin only;2026-09-05 三组统一:SSH 会话回收 / Pod 终端 / SSH 异步任务) -->
        <div v-if="activeTab === 'ssh'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">terminal</span>
            <span class="text-body-sm font-semibold">{{ t('settings.terminalPolicyTitle') }}</span>
          </div>
          <div class="p-md space-y-md">
            <!-- SSH 会话回收(2026-08-29 spec 迁入) -->
            <div class="space-y-sm p-md rounded-lg bg-surface-container-low border border-outline-variant/50">
              <p class="text-body-sm font-semibold text-on-surface">{{ t('settings.sshPolicyTitle') }}</p>
              <div v-for="f in [['detachedIdleMin', 'sshPolicyDetachedLabel'], ['attachedIdleMin', 'sshPolicyAttachedLabel'], ['maxLifetimeMin', 'sshPolicyMaxLifetimeLabel'], ['backendIdleMin', 'sshPolicyBackendLabel']]" :key="f[0]" class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('settings.' + f[1]) }}</label>
                <input v-model="sshPolicy[f[0]]" type="number" min="0" max="10080" class="w-32 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
                <span class="text-body-xs text-on-surface-variant">{{ t('settings.sshPolicyUnit') }}</span>
              </div>
              <p class="text-body-xs text-on-surface-variant">{{ t('settings.sshPolicyHint') }}</p>
              <p class="text-body-xs text-error/80">{{ t('settings.sshPolicyNeverHint') }}</p>
            </div>
            <!-- Pod 终端空闲回收 -->
            <div class="space-y-sm p-md rounded-lg bg-surface-container-low border border-outline-variant/50">
              <p class="text-body-sm font-semibold text-on-surface">{{ t('settings.podTerminalPolicyTitle') }}</p>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('settings.podIdleReapLabel') }}</label>
                <input v-model="podPolicy.idleReapMin" type="number" min="0" max="10080" class="w-32 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
                <span class="text-body-xs text-on-surface-variant">{{ t('settings.sshPolicyUnit') }}</span>
              </div>
              <p class="text-body-xs text-on-surface-variant">{{ t('settings.podIdleReapHint') }}</p>
            </div>
            <!-- SSH 异步任务 -->
            <div class="space-y-sm p-md rounded-lg bg-surface-container-low border border-outline-variant/50">
              <p class="text-body-sm font-semibold text-on-surface">{{ t('settings.sshJobPolicyTitle') }}</p>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('settings.jobTtlLabel') }}</label>
                <input v-model="jobPolicy.ttlMin" type="number" min="1" max="10080" class="w-32 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
                <span class="text-body-xs text-on-surface-variant">{{ t('settings.sshPolicyUnit') }}</span>
              </div>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('settings.jobMaxPerServerLabel') }}</label>
                <input v-model="jobPolicy.maxPerServer" type="number" min="1" max="16" class="w-32 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              </div>
              <p class="text-body-xs text-on-surface-variant">{{ t('settings.jobPolicyHint') }}</p>
            </div>
            <button @click="saveSshPolicy" :disabled="sshPolicySaving" class="px-sm py-1 rounded-md bg-primary text-on-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50 max-sm:min-h-[40px]">{{ t('common.save') }}</button>
            <p class="text-body-xs text-on-surface-variant">{{ t('settings.terminalPolicyEffectiveHint') }}</p>
          </div>
        </div>

        <!-- 安全策略 tab (admin only;2026-09-04 Wave1):密码策略 + 令牌 TTL 上限 -->
        <div v-if="activeTab === 'security'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">security</span>
            <span class="text-body-sm font-semibold">{{ t('admin.securityPolicy.title') }}</span>
          </div>
          <div class="p-md space-y-md">
            <!-- 密码策略 -->
            <div class="space-y-sm p-md rounded-lg bg-surface-container-low border border-outline-variant/50">
              <p class="text-body-sm font-semibold text-on-surface">{{ t('admin.securityPolicy.password') }}</p>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('admin.securityPolicy.minLength') }}</label>
                <input v-model="pwPolicy.minLength" type="number" min="8" max="128" class="w-32 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              </div>
              <label class="flex items-center gap-sm text-body-sm text-on-surface-variant cursor-pointer">
                <input v-model="pwPolicy.requireMixed" type="checkbox" class="accent-primary w-4 h-4" />
                {{ t('admin.securityPolicy.requireMixed') }}
              </label>
              <label class="flex items-center gap-sm text-body-sm text-on-surface-variant cursor-pointer">
                <input v-model="pwPolicy.requireDigit" type="checkbox" class="accent-primary w-4 h-4" />
                {{ t('admin.securityPolicy.requireDigit') }}
              </label>
              <label class="flex items-center gap-sm text-body-sm text-on-surface-variant cursor-pointer">
                <input v-model="pwPolicy.requireSymbol" type="checkbox" class="accent-primary w-4 h-4" />
                {{ t('admin.securityPolicy.requireSymbol') }}
              </label>
              <button data-testid="policy-save" @click="savePasswordPolicy" :disabled="pwPolicySaving" class="px-sm py-1 rounded-md bg-primary text-on-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50 max-sm:min-h-[40px]">{{ t('common.save') }}</button>
            </div>
            <!-- 令牌有效期上限 -->
            <div class="flex items-center gap-sm p-md rounded-lg bg-surface-container-low border border-outline-variant/50">
              <label class="text-body-sm text-on-surface-variant shrink-0">{{ t('admin.securityPolicy.tokenTtl') }}</label>
              <input data-testid="token-ttl-input" v-model="tokenTtl" type="number" min="1" max="365" class="w-32 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              <button data-testid="token-ttl-save" @click="saveTokenTtl" :disabled="tokenTtlSaving" class="px-sm py-1 rounded-md bg-primary text-on-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50 max-sm:min-h-[40px]">
                {{ t('common.save') }}
              </button>
            </div>
            <!-- 强制两步验证(W3 §1.5,外评 2026-09-07 修复 1):开后未启用用户登录只进 MFA 引导 -->
            <div data-testid="mfa-policy-card" class="p-md rounded-lg bg-surface-container-low border border-outline-variant/50">
              <div class="flex items-center justify-between gap-md max-sm:min-h-[40px]">
                <div class="min-w-0">
                  <p class="text-body-sm font-semibold text-on-surface">{{ t('admin.securityPolicy.mfaRequired') }}</p>
                  <p class="text-body-xs text-on-surface-variant mt-xs">{{ t('admin.securityPolicy.mfaRequiredHint') }}</p>
                  <p class="text-body-xs text-on-surface-variant">{{ t('admin.securityPolicy.mfaRequiredLogoutHint') }}</p>
                </div>
                <button data-testid="mfa-policy-toggle" @click="toggleMfaPolicy" :disabled="mfaPolicyLoading"
                  class="relative w-12 h-6 rounded-full transition-colors flex-shrink-0 max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"
                  :class="mfaRequired ? 'bg-status-running' : 'bg-outline-variant'">
                  <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform shadow-sm"
                    :class="mfaRequired ? 'translate-x-6' : 'translate-x-0'"></span>
                </button>
              </div>
            </div>
            <!-- SSO 登录(OIDC)第四卡(W4):开关随保存生效;回调 URI 只读+复制;测试连接打已保存配置 -->
            <div data-testid="oidc-card" class="space-y-sm p-md rounded-lg bg-surface-container-low border border-outline-variant/50">
              <p class="text-body-sm font-semibold text-on-surface">{{ t('admin.oidc.title') }}</p>
              <p class="text-body-xs text-on-surface-variant">{{ t('admin.oidc.hint') }}</p>
              <label class="flex items-center gap-sm text-body-sm text-on-surface-variant cursor-pointer">
                <input v-model="oidc.enabled" type="checkbox" class="accent-primary w-4 h-4" />
                {{ t('admin.oidc.enabled') }}
              </label>
              <p class="text-body-xs text-on-surface-variant">{{ t('admin.oidc.enabledHint') }}</p>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('admin.oidc.issuer') }}</label>
                <input v-model="oidc.issuer" data-testid="oidc-issuer" type="text" placeholder="https://idp.example.com"
                  class="flex-1 min-w-0 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              </div>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('admin.oidc.clientId') }}</label>
                <input v-model="oidc.clientId" data-testid="oidc-client-id" type="text"
                  class="flex-1 min-w-0 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              </div>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('admin.oidc.clientSecret') }}</label>
                <input v-model="oidc.clientSecret" data-testid="oidc-client-secret" type="password" autocomplete="new-password"
                  :placeholder="oidcHasSecret ? t('admin.oidc.clientSecretSet') : ''"
                  class="flex-1 min-w-0 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              </div>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('admin.oidc.scopes') }}</label>
                <input v-model="oidc.scopes" data-testid="oidc-scopes" type="text" placeholder="openid profile email"
                  class="flex-1 min-w-0 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              </div>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('admin.oidc.groupsClaim') }}</label>
                <input v-model="oidc.groupsClaim" data-testid="oidc-groups-claim" type="text"
                  class="flex-1 min-w-0 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              </div>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('admin.oidc.usernameClaim') }}</label>
                <input v-model="oidc.usernameClaim" data-testid="oidc-username-claim" type="text"
                  class="flex-1 min-w-0 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-body-sm font-mono focus:outline-none focus:border-primary" />
              </div>
              <div class="flex items-center gap-sm max-sm:flex-col max-sm:items-start">
                <label class="text-body-sm text-on-surface-variant shrink-0 w-56 max-sm:w-full">{{ t('admin.oidc.redirectUri') }}</label>
                <div class="flex flex-1 min-w-0 items-center gap-xs">
                  <input :value="oidcRedirectUri" data-testid="oidc-redirect-uri" type="text" readonly
                    class="flex-1 min-w-0 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-low/60 text-code-sm font-mono text-on-surface-variant" />
                  <button @click="copyText(oidcRedirectUri)" type="button"
                    class="relative flex items-center gap-xs px-xs py-0.5 rounded text-body-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
                    <span class="material-symbols-outlined text-sm">content_copy</span>{{ t('common.copy') }}
                  </button>
                </div>
              </div>
              <div class="flex items-center gap-sm">
                <button data-testid="oidc-save" @click="saveOidcConfig" :disabled="oidcSaving" class="px-sm py-1 rounded-md bg-primary text-on-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50 max-sm:min-h-[40px]">{{ t('common.save') }}</button>
                <button data-testid="oidc-test" @click="testOidcConnection" :disabled="oidcTesting" class="px-sm py-1 rounded-md border border-outline-variant text-body-xs font-semibold hover:bg-surface-container disabled:opacity-50 max-sm:min-h-[40px]">
                  <span v-if="oidcTesting" class="material-symbols-outlined text-sm align-middle animate-spin">progress_activity</span>
                  <span v-else class="material-symbols-outlined text-sm align-middle">network_check</span>
                  {{ t('admin.oidc.test') }}
                </button>
              </div>
              <!-- 测试结果:ok → 端点/JWKS 密钥数/kty;!ok → 失败行(错误码为内部归因,统一文案) -->
              <div v-if="oidcTest" data-testid="oidc-test-result" class="text-body-xs rounded-md px-sm py-sm border"
                :class="oidcTest.ok ? 'border-status-running/30 bg-status-running/5 text-on-surface' : 'border-error/30 bg-error-container/10 text-error'">
                <template v-if="oidcTest.ok">
                  <p class="font-semibold">{{ t('admin.oidc.testOk') }}</p>
                  <p class="break-all mt-xs">{{ t('admin.oidc.authEndpoint') }}: {{ oidcTest.authorizationEndpoint }}</p>
                  <p class="break-all">{{ t('admin.oidc.tokenEndpoint') }}: {{ oidcTest.tokenEndpoint }}</p>
                  <p>{{ t('admin.oidc.jwksKeys') }}: {{ oidcTest.jwksKeys }} · {{ (oidcTest.algorithms || []).join(', ') }}</p>
                </template>
                <p v-else class="font-semibold">{{ t('admin.oidc.testFailed') }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
