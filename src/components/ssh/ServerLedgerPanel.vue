<script setup>
// 服务器台账面板(2026-08-29 双域化):结构层(后端 renderServerLedger 实时生成,只读 pre 展示,
// 不开 HTML 渲染——无 XSS 面)+ 自由层(全局备注+每服务器备注,PUT /api/ssh/ledger)。
// 服务器 tab 弹窗与知识 tab 服务器区共用本面板,数据单源在后端。
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { sshApi } from '@/api/client'
import { notify } from '@/composables/useToast'

const { t } = useI18n()
const ledger = ref(null)      // { globalNotes, servers:[{id,name,notes}], markdown }
const busy = ref(true)
const draft = ref({})         // { __global__: str, [serverId]: str }
const saving = ref('')

async function load() {
  busy.value = true
  try {
    const r = await sshApi.getLedger()
    ledger.value = r
    draft.value = { __global__: r.globalNotes || '', ...Object.fromEntries((r.servers || []).map(x => [x.id, x.notes || ''])) }
  } catch (e) { notify('error', e?.message || t('common.error')) }
  finally { busy.value = false }
}
onMounted(load)

async function save(scope) {
  saving.value = scope
  try {
    await sshApi.saveLedger(scope, draft.value[scope] ?? '')
    notify('success', t('common.saved'))
  } catch (e) { notify('error', e?.message || t('common.saveFailed')) }
  finally { saving.value = '' }
}
defineExpose({ load })
</script>

<template>
  <div class="flex flex-col gap-md" data-test="serverLedgerPanel">
    <p class="text-body-xs text-on-surface-variant">{{ t('ssh.ledgerHint') }}</p>
    <div v-if="busy" class="text-body-sm text-on-surface-variant">{{ t('common.loading') }}</div>
    <template v-else>
      <div class="flex flex-col gap-xs">
        <p class="text-label-caps text-on-surface-variant">{{ t('ssh.ledgerStructure') }}</p>
        <pre data-test="ledgerMarkdown" class="bg-surface-container-lowest border border-outline-variant rounded-lg p-md font-mono text-body-sm whitespace-pre-wrap break-words max-h-[30vh] overflow-y-auto">{{ ledger?.markdown }}</pre>
      </div>
      <div class="flex flex-col gap-xs">
        <div class="flex items-center justify-between">
          <h5 class="text-title-sm font-semibold">{{ t('ssh.ledgerGlobal') }}</h5>
          <button data-test="ledgerSaveGlobal" @click="save('__global__')" :disabled="saving === '__global__'"
            class="px-sm py-xs bg-primary text-on-primary rounded-lg text-body-xs font-semibold disabled:opacity-50">{{ t('common.save') }}</button>
        </div>
        <textarea data-test="ledgerGlobal" v-model="draft.__global__" rows="4"
          class="bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-xs text-body-sm font-mono"></textarea>
      </div>
      <div v-for="srv in (ledger?.servers || [])" :key="srv.id" class="flex flex-col gap-xs border-t border-outline-variant/40 pt-sm">
        <div class="flex items-center justify-between">
          <h5 class="text-title-sm font-semibold font-mono">{{ srv.name }}</h5>
          <button :data-test="'ledgerSave-' + srv.id" @click="save(srv.id)" :disabled="saving === srv.id"
            class="px-sm py-xs bg-primary text-on-primary rounded-lg text-body-xs font-semibold disabled:opacity-50">{{ t('common.save') }}</button>
        </div>
        <textarea :data-test="'ledgerNotes-' + srv.id" v-model="draft[srv.id]" rows="3"
          :placeholder="t('ssh.ledgerNotesPlaceholder')"
          class="bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-xs text-body-sm font-mono"></textarea>
      </div>
      <p v-if="!(ledger?.servers || []).length" class="text-body-sm text-on-surface-variant">{{ t('ssh.ledgerEmpty') }}</p>
    </template>
  </div>
</template>
