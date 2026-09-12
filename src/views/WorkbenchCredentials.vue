<script setup>
// 凭据页(2026-09-12 spec §11):纯内容组件(舞台归 Shell,chromeless 同 Records)。
// 列表=卡片网格+搜索+预设快捷;详情=逐字段行(password 显式 reveal);表单=手动/智能粘贴双模式。
// 编辑三态:password 行 value 恒空 + placeholder「留空保持不变」,空值提交时省略 value 键(SshServerForm 同款;
// 凭据上不存在的新空 password 行整行不发)。
import { ref, computed } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { notify } from '@/composables/useToast'
import { credentialsApi } from '@/api/client'
import Modal from '@/components/common/Modal.vue'
import DropdownMenu from '@/components/common/DropdownMenu.vue'

const { t } = useI18n()
const auth = useAuthStore()
const qc = useQueryClient()
const isAdmin = computed(() => auth.isAdmin)

const keyword = ref('')
const { data: credentials = ref([]), isLoading } = useQuery({
  queryKey: ['credentials'],
  queryFn: () => credentialsApi.list().then(r => r.credentials || []),
  enabled: isAdmin,   // 非 admin 端点 403,不发请求(WorkbenchServers 同款)
})
const filtered = computed(() => {
  const list = credentials.value || []   // vue-query data 初始 undefined 的护栏
  const k = keyword.value.trim().toLowerCase()
  if (!k) return list
  return list.filter(c =>
    c.name.toLowerCase().includes(k) || (c.tags || []).some(tg => tg.toLowerCase().includes(k))
    || (c.fields || []).some(f => f.key.toLowerCase().includes(k)))
})

// ═══ 表单(新建/编辑共用,双模式) ═══
const PRESETS = {
  ssh: [['host', 'text'], ['port', 'text'], ['user', 'text'], ['password', 'password']],
  apiToken: [['api_token', 'password'], ['base_url', 'text']],
  account: [['username', 'text'], ['password', 'password']],
}
const showForm = ref(false)
const editing = ref(null)          // null=新建;行对象=编辑
const formMode = ref('manual')     // manual | smart
const form = ref(emptyForm())
const parseText = ref('')
const parseBusy = ref(false)
const saving = ref(false)

function emptyForm() { return { name: '', description: '', tagsText: '', exposeToAi: false, fields: [{ key: '', type: 'password', value: '' }] } }

function openCreate(preset) {
  editing.value = null; formMode.value = 'manual'; parseText.value = ''
  form.value = emptyForm()
  if (preset) form.value.fields = PRESETS[preset].map(([key, type]) => ({ key, type, value: '' }))
  showForm.value = true
}
async function openEdit(row) {
  editing.value = row; formMode.value = 'manual'; parseText.value = ''
  try {
    const r = await credentialsApi.get(row.id)
    const c = r.credential
    // 详情接口:text 明文回填;password 掩码值不回填(恒空=保持)
    form.value = {
      name: c.name, description: c.description || '', tagsText: (c.tags || []).join(', '),
      exposeToAi: !!c.exposeToAi,
      fields: (c.fields || []).map(f => ({ key: f.key, type: f.type, value: f.type === 'text' ? (f.value ?? '') : '' })),
    }
    showForm.value = true
  } catch (e) { notify('error', e?.message || t('workbench.credentials.loadFailed')) }
}

async function smartParse() {
  if (parseBusy.value || !parseText.value.trim()) return
  parseBusy.value = true
  try {
    const r = await credentialsApi.parse(parseText.value)
    const d = r.draft
    form.value = {
      name: d.name || '', description: d.description || '', tagsText: (d.tags || []).join(', '),
      exposeToAi: form.value.exposeToAi,
      fields: (d.fields && d.fields.length ? d.fields : [{ key: '', type: 'password', value: '' }])
        .map(f => ({ key: f.key, type: f.type, value: f.value })),   // password 草稿值也回填(type=password 输入框本身就掩码显示)
    }
    notify('success', t('workbench.credentials.parseOk', { n: r.dropped || 0 }))
    formMode.value = 'manual'   // 回填后转手动供检查修改
  } catch (e) { notify('error', e?.message || t('workbench.credentials.parseFailed')) }
  finally { parseBusy.value = false }
}

async function save() {
  if (!showForm.value || saving.value) return
  if (!form.value.name.trim()) return
  saving.value = true
  // 编辑态 keep-semantics 只对凭据上已有的 key 生效:新加的空 password 行(凭据上无此 key)整行不发——
  // 后端无从「保持」一个不存在的字段
  const existing = new Set((editing.value?.fields || []).map(f => f.key.toLowerCase()))
  const base = {
    name: form.value.name.trim(),
    description: form.value.description.trim(),
    tags: form.value.tagsText.split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, 8),
    exposeToAi: !!form.value.exposeToAi,
    fields: form.value.fields
      .filter(f => f.key.trim())
      .filter(f => !(f.type === 'password' && editing.value && f.value === '' && !existing.has(f.key.trim().toLowerCase())))
      .map(f => {
        const key = f.key.trim()
        // 编辑态 password 留空 = 保持:载荷省略 value 键(三态语义)
        if (f.type === 'password' && editing.value && f.value === '') return { key, type: f.type }
        return { key, type: f.type, value: f.value }
      }),
  }
  try {
    if (editing.value) { await credentialsApi.update(editing.value.id, base); notify('success', t('workbench.credentials.saved')) }
    else { await credentialsApi.create(base); notify('success', t('workbench.credentials.saved')) }
    showForm.value = false
    qc.invalidateQueries({ queryKey: ['credentials'] })
  } catch (e) { notify('error', e?.message || t('workbench.credentials.saveFailed')) }   // 失败保窗可重试
  finally { saving.value = false }
}

// ═══ 详情(逐字段 reveal) ═══
const detail = ref(null)
const revealed = ref({})
async function openDetail(row) {
  revealed.value = {}
  try { const r = await credentialsApi.get(row.id); detail.value = r.credential }
  catch (e) { notify('error', e?.message || t('workbench.credentials.loadFailed')) }
}
async function revealField(fieldKey) {
  try {
    const r = await credentialsApi.reveal(detail.value.id, fieldKey)
    revealed.value[fieldKey] = r.value
  } catch (e) { notify('error', e?.message || t('workbench.credentials.revealFailed')) }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); notify('success', t('workbench.credentials.copied')) }
  catch { notify('error', t('workbench.credentials.copyFailed')) }   // 剪贴板不可用(非 https)不再静默——用户可见失败优于无声无息
}
// v2(2026-09-12 credential-adapters spec §12):收回「批准并记住」落的免审 grant——
// 收回后该凭据的此类适配器只读操作恢复逐次审批。收回成功即重拉详情刷新已授权区。
async function revokeGrant(adapter) {
  try {
    await credentialsApi.revokeGrant(detail.value.id, adapter)
    const r = await credentialsApi.get(detail.value.id)
    detail.value = r.credential
    notify('success', t('workbench.credentials.grantRevoked'))
  } catch (e) { notify('error', e?.message || t('workbench.credentials.loadFailed')) }
}

// ═══ 删除(确认名) ═══
const deleteTarget = ref(null)
const deleteConfirmText = ref('')
const deleteBusy = ref(false)
const deleteConfirmed = computed(() =>
  deleteTarget.value && deleteConfirmText.value.trim() === deleteTarget.value.name.trim())
async function doDelete() {
  if (!deleteConfirmed.value || deleteBusy.value) return
  deleteBusy.value = true
  try {
    await credentialsApi.remove(deleteTarget.value.id, deleteConfirmText.value.trim())
    notify('success', t('workbench.credentials.deleted'))
    deleteTarget.value = null; deleteConfirmText.value = ''
    qc.invalidateQueries({ queryKey: ['credentials'] })
  } catch (e) { notify('error', e?.message || t('workbench.credentials.deleteFailed')) }
  finally { deleteBusy.value = false }
}

function rowActions(c) {
  return [
    { label: t('workbench.credentials.detail'), icon: 'visibility', action: () => openDetail(c) },
    { label: t('workbench.credentials.edit'), icon: 'edit', action: () => openEdit(c) },
    { label: t('workbench.credentials.delete'), icon: 'delete', danger: true, action: () => { deleteTarget.value = c; deleteConfirmText.value = '' } },
  ]
}
const fmtTime = ts => (ts ? new Date(ts).toLocaleString() : '')
</script>

<template>
  <div class="flex flex-col gap-md">
    <!-- 顶栏:搜索 + 预设快捷 + 新建 -->
    <div class="flex flex-wrap items-center gap-sm">
      <input v-model="keyword" data-testid="cred-search" class="w-64 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"
        :placeholder="t('workbench.credentials.searchPlaceholder')" />
      <span class="text-body-xs text-on-surface-variant ml-auto">{{ filtered.length }}</span>
      <button @click="openCreate('ssh')" class="px-sm py-xs border border-outline-variant rounded-lg text-body-xs">{{ t('workbench.credentials.presetSsh') }}</button>
      <button @click="openCreate('apiToken')" class="px-sm py-xs border border-outline-variant rounded-lg text-body-xs">{{ t('workbench.credentials.presetApiToken') }}</button>
      <button @click="openCreate('account')" class="px-sm py-xs border border-outline-variant rounded-lg text-body-xs">{{ t('workbench.credentials.presetAccount') }}</button>
      <button @click="openCreate()" data-testid="cred-create-btn" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('workbench.credentials.create') }}</button>
    </div>

    <!-- 卡片网格(Projects 风格) -->
    <div v-if="isLoading" class="text-body-sm text-on-surface-variant">...</div>
    <div v-else-if="!filtered.length" class="text-body-sm text-on-surface-variant py-lg text-center">{{ t('workbench.credentials.empty') }}</div>
    <div v-else class="grid gap-md [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
      <div v-for="c in filtered" :key="c.id" class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md flex flex-col gap-xs">
        <div class="flex items-start justify-between gap-sm min-w-0">
          <div class="min-w-0">
            <div class="font-semibold text-on-surface truncate">{{ c.name }}</div>
            <div v-if="c.description" class="text-body-xs text-on-surface-variant truncate">{{ c.description }}</div>
          </div>
          <DropdownMenu trigger-icon="more_vert" :items="rowActions(c)" />
        </div>
        <div class="flex flex-wrap items-center gap-xs">
          <span class="px-sm py-0.5 rounded-full text-body-xs" :class="c.exposeToAi ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container text-on-surface-variant'">
            {{ c.exposeToAi ? t('workbench.credentials.aiVisible') : t('workbench.credentials.aiHidden') }}
          </span>
          <span class="text-body-xs text-on-surface-variant">{{ t('workbench.credentials.fieldCount', { n: (c.fields || []).length }) }}</span>
          <span v-for="tg in (c.tags || [])" :key="tg" class="px-sm py-0.5 rounded-full bg-surface-container text-body-xs text-on-surface-variant">{{ tg }}</span>
        </div>
        <div class="text-body-xs text-on-surface-variant mt-auto">{{ fmtTime(c.updatedAt) }}</div>
        <!-- 测试钩子:编辑/删除直达(DropdownMenu teleport 后不便点) -->
        <div class="hidden"><button :data-testid="`cred-edit-${c.id}`" @click="openEdit(c)">e</button></div>
      </div>
    </div>

    <!-- 新建/编辑 Modal(双模式) -->
    <Modal v-model="showForm" :title="editing ? t('workbench.credentials.formTitleEdit') : t('workbench.credentials.formTitleCreate')" width="max-w-2xl">
      <div class="flex flex-col gap-md">
        <div class="flex gap-sm">
          <button @click="formMode = 'manual'" data-testid="cred-mode-manual"
            class="px-md py-xs rounded-lg text-body-sm" :class="formMode === 'manual' ? 'bg-primary-container text-on-primary-container font-semibold' : 'border border-outline-variant'">{{ t('workbench.credentials.modeManual') }}</button>
          <button @click="formMode = 'smart'" data-testid="cred-mode-smart"
            class="px-md py-xs rounded-lg text-body-sm" :class="formMode === 'smart' ? 'bg-primary-container text-on-primary-container font-semibold' : 'border border-outline-variant'">{{ t('workbench.credentials.modeSmart') }}</button>
        </div>

        <div v-if="formMode === 'smart'" class="flex flex-col gap-sm">
          <p class="text-body-xs rounded-lg border border-outline-variant bg-surface-container-low px-md py-sm text-on-surface-variant">{{ t('workbench.credentials.smartHint') }}</p>
          <textarea v-model="parseText" data-testid="cred-parse-text" rows="6"
            class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono resize-y focus:outline-none focus:border-primary"
            :placeholder="t('workbench.credentials.smartPlaceholder')" />
          <div class="flex justify-end">
            <button @click="smartParse" :disabled="parseBusy || !parseText.trim()" data-testid="cred-parse-btn"
              class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ parseBusy ? t('workbench.credentials.parsing') : t('workbench.credentials.parseBtn') }}</button>
          </div>
        </div>

        <div v-else class="flex flex-col gap-md">
          <div class="grid gap-md [grid-template-columns:1fr_1fr]">
            <div>
              <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.credentials.nameLabel') }}</label>
              <input v-model="form.name" data-testid="cred-name-input" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
            </div>
            <div>
              <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.credentials.descLabel') }}</label>
              <input v-model="form.description" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
            </div>
          </div>
          <div class="grid gap-md [grid-template-columns:1fr_1fr]">
            <div>
              <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('workbench.credentials.tagsLabel') }}</label>
              <input v-model="form.tagsText" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" :placeholder="t('workbench.credentials.tagsPlaceholder')" />
            </div>
            <label class="flex items-center gap-sm self-end pb-sm">
              <input type="checkbox" v-model="form.exposeToAi" class="accent-primary" />
              <span class="text-body-sm">{{ t('workbench.credentials.exposeLabel') }}</span>
              <span class="material-symbols-outlined text-sm text-on-surface-variant" :title="t('workbench.credentials.exposeHint')">info</span>
            </label>
          </div>

          <!-- 动态字段行:key | type | value | 删行 -->
          <div class="flex flex-col gap-xs">
            <div v-for="(f, i) in form.fields" :key="i" class="grid gap-xs [grid-template-columns:1fr_7rem_1fr_auto] items-center">
              <input v-model="f.key" :data-testid="`cred-field-key-${i}`" :placeholder="t('workbench.credentials.fieldKey')"
                class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
              <select v-model="f.type" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm">
                <option value="password">{{ t('workbench.credentials.typePassword') }}</option>
                <option value="text">{{ t('workbench.credentials.typeText') }}</option>
              </select>
              <input v-if="f.type === 'text'" v-model="f.value" :data-testid="`cred-field-value-${i}`" :placeholder="t('workbench.credentials.fieldValue')"
                class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
              <input v-else v-model="f.value" :data-testid="`cred-field-value-${i}`" type="password"
                :placeholder="editing ? t('workbench.credentials.keepPlaceholder') : t('workbench.credentials.fieldValue')"
                class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
              <button @click="form.fields.splice(i, 1)" class="material-symbols-outlined text-on-surface-variant hover:text-error" :title="t('workbench.credentials.delete')">close</button>
            </div>
            <button @click="form.fields.push({ key: '', type: 'password', value: '' })" class="self-start px-md py-xs border border-outline-variant rounded-lg text-body-sm">{{ t('workbench.credentials.addField') }}</button>
          </div>
        </div>
      </div>
      <template #actions>
        <button @click="showForm = false" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button v-if="formMode === 'manual'" @click="save" :disabled="!form.name.trim() || saving" data-testid="cred-save-btn"
          class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40">{{ t('workbench.credentials.save') }}</button>
      </template>
    </Modal>

    <!-- 详情 Modal:text 直显+复制;password 掩码+显示(reveal)+复制 -->
    <Modal :model-value="!!detail" @update:model-value="v => { if (!v) detail = null }" :title="t('workbench.credentials.detailTitle')" width="max-w-lg">
      <div v-if="detail" class="flex flex-col gap-md">
        <div class="flex items-center gap-sm">
          <span class="font-semibold text-on-surface">{{ detail.name }}</span>
          <span class="px-sm py-0.5 rounded-full text-body-xs" :class="detail.exposeToAi ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container text-on-surface-variant'">
            {{ detail.exposeToAi ? t('workbench.credentials.aiVisible') : t('workbench.credentials.aiHidden') }}
          </span>
        </div>
        <div v-for="f in detail.fields" :key="f.key" class="flex items-center gap-sm border-b border-outline-variant/40 pb-sm">
          <code class="text-body-sm font-mono text-on-surface min-w-0 truncate">{{ f.key }}</code>
          <span class="px-xs rounded text-body-xs shrink-0" :class="f.type === 'password' ? 'bg-error-container text-on-error-container' : 'bg-surface-container text-on-surface-variant'">
            {{ f.type === 'password' ? t('workbench.credentials.typePassword') : t('workbench.credentials.typeText') }}
          </span>
          <span class="ml-auto flex items-center gap-xs shrink-0">
            <code v-if="f.type === 'text'" class="text-body-sm font-mono text-on-surface-variant max-w-[16rem] truncate">{{ f.value }}</code>
            <code v-else-if="revealed[f.key] != null" class="text-body-sm font-mono text-on-surface-variant max-w-[16rem] truncate">{{ revealed[f.key] }}</code>
            <code v-else class="text-body-sm font-mono text-on-surface-variant">••••••</code>
            <button v-if="f.type === 'password'" @click="revealed[f.key] != null ? delete revealed[f.key] : revealField(f.key)"
              class="px-xs py-0.5 border border-outline-variant rounded text-body-xs">{{ revealed[f.key] != null ? t('workbench.credentials.hide') : t('workbench.credentials.show') }}</button>
            <button @click="copyText(f.type === 'text' ? f.value : (revealed[f.key] ?? ''))" :disabled="f.type === 'password' && revealed[f.key] == null"
              class="px-xs py-0.5 border border-outline-variant rounded text-body-xs disabled:opacity-40">{{ t('workbench.credentials.copy') }}</button>
          </span>
        </div>
        <!-- v2 已授权区(spec §12):凭据×适配器免审 grants,一键收回 -->
        <div v-if="detail.grants && detail.grants.length" class="flex flex-col gap-xs">
          <p class="text-body-xs text-on-surface-variant">{{ t('workbench.credentials.grantsTitle') }}</p>
          <div v-for="g in detail.grants" :key="g.adapter" class="flex items-center gap-sm border-b border-outline-variant/40 pb-sm">
            <code class="text-body-sm font-mono text-on-surface">{{ g.adapter }}</code>
            <span class="text-body-xs text-on-surface-variant">{{ fmtTime(g.grantedAt) }}</span>
            <button @click="revokeGrant(g.adapter)" data-testid="cred-revoke-grant"
              class="ml-auto px-xs py-0.5 border border-outline-variant rounded text-body-xs hover:text-error">{{ t('workbench.credentials.revoke') }}</button>
          </div>
        </div>
      </div>
      <template #actions>
        <button @click="detail = null" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.close') }}</button>
      </template>
    </Modal>

    <!-- 删除 Modal:确认名 -->
    <Modal :model-value="!!deleteTarget" @update:model-value="v => { if (!v) deleteTarget = null }" :title="t('workbench.credentials.deleteTitle')" width="max-w-md">
      <div v-if="deleteTarget" class="flex flex-col gap-md">
        <p class="text-body-sm text-on-surface-variant">{{ t('workbench.credentials.deleteHint') }}</p>
        <p><code class="px-sm py-0.5 bg-surface-container rounded text-on-surface font-mono text-body-sm">{{ deleteTarget.name }}</code></p>
        <input v-model="deleteConfirmText" data-testid="cred-delete-confirm" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
      </div>
      <template #actions>
        <button @click="deleteTarget = null" class="px-md py-sm border border-outline-variant rounded-lg">{{ t('common.cancel') }}</button>
        <button @click="doDelete" :disabled="!deleteConfirmed || deleteBusy" data-testid="cred-delete-btn"
          class="px-md py-sm bg-error text-on-error rounded-lg font-semibold disabled:opacity-40">{{ t('workbench.credentials.deleteBtn') }}</button>
      </template>
    </Modal>
  </div>
</template>
