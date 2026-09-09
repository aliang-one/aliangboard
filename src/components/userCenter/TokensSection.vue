<script setup>
// 访问令牌卡(2026-09-05 Wave1 Task 11):自助 key 列表 + 签发(cluster+ns+tier+TTL 表单)+
// 明文仅显一次弹窗(复制钮)+ 吊销 ConfirmDialog。权限随账号实时收缩(服务端担保)。
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()

const keys = ref([])
const clusters = ref([])
const showMint = ref(false)
const mintForm = ref({ clusterId: '', namespace: '', tier: 'read', label: '', ttlDays: 30 })
const mintError = ref('')
const plaintext = ref('')        // 非空 = 显示一次性弹窗
const copied = ref(false)
const revokeTarget = ref(null)
const showRevokeConfirm = ref(false)

async function load() {
  try { keys.value = (await authApi.myKeysList()).apikeys || [] } catch { keys.value = [] }
  try { clusters.value = (await authApi.myClusters()).clusters || [] } catch { clusters.value = [] }
}
function statusOf(k) {
  if (k.revokedAt) return 'revoked'
  if (k.expiresAt && Date.now() > k.expiresAt) return 'expired'
  return 'active'
}
async function mint() {
  mintError.value = ''
  if (!mintForm.value.clusterId || !mintForm.value.namespace) { mintError.value = t('mykeys.formIncomplete'); return }
  try {
    const res = await authApi.myKeysMint({ ...mintForm.value })
    showMint.value = false
    plaintext.value = res.apikey.plaintext
    copied.value = false
    load()
  } catch (e) { mintError.value = e.message || t('common.opFailed') }
}
async function copyPlaintext() {
  try { await navigator.clipboard.writeText(plaintext.value); copied.value = true } catch { /* 剪贴板不可用不阻塞弹窗 */ }
}
function closePlaintext() { plaintext.value = '' }
function askRevoke(k) { revokeTarget.value = k; showRevokeConfirm.value = true }
async function doRevoke() {
  const target = revokeTarget.value; showRevokeConfirm.value = false
  if (!target) return
  try { await authApi.myKeysRevoke(target.id); load() } catch (e) { notify('error', e.message || t('common.opFailed')) }
}
function fmtDay(ts) { return ts ? new Date(ts).toLocaleDateString() : '—' }
onMounted(load)
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
    <div class="flex items-start justify-between gap-md mb-md">
      <div class="min-w-0">
        <h3 class="text-headline-sm font-bold">{{ $t('userCenter.tokens.tokensTitle') }}</h3>
        <p class="text-body-xs text-on-surface-variant mt-xs">{{ $t('userCenter.tokens.tokensHint') }}</p>
      </div>
      <button data-testid="token-mint-btn"
        class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm shrink-0 max-sm:min-h-[40px]"
        @click="showMint = true">
        <span class="material-symbols-outlined text-base">add</span>{{ $t('userCenter.tokens.mintBtn') }}
      </button>
    </div>

    <div v-if="keys.length === 0" class="py-lg text-center text-on-surface-variant text-body-sm">—</div>
    <div v-else class="flex flex-col gap-xs">
      <div v-for="k in keys" :key="k.id" data-testid="token-row"
        class="flex items-center gap-md px-md py-sm rounded-lg border border-outline-variant/50">
        <span class="material-symbols-outlined text-on-surface-variant">key</span>
        <div class="min-w-0 flex-1">
          <p class="text-body-sm font-medium truncate">
            <span class="font-mono">{{ k.prefix }}</span>
            <span v-if="k.label" class="ml-sm text-on-surface-variant">· {{ k.label }}</span>
            <span :data-testid="`token-status-${statusOf(k)}`"
              class="ml-sm px-1.5 py-0.5 rounded text-[10px] font-bold"
              :class="statusOf(k) === 'active' ? 'bg-primary/10 text-primary' : statusOf(k) === 'expired' ? 'bg-on-surface-variant/10 text-on-surface-variant' : 'bg-error/10 text-error'">
              {{ $t(`userCenter.tokens.status${statusOf(k).charAt(0).toUpperCase() + statusOf(k).slice(1)}`) }}
            </span>
          </p>
          <p class="text-body-xs text-on-surface-variant truncate">
            {{ k.clusterId }}/{{ k.boundSA_namespace || '—' }} · {{ k.tier }} · {{ $t('userCenter.tokens.colExpires') }}: {{ fmtDay(k.expiresAt) }} · {{ $t('userCenter.tokens.colLastUsed') }}: {{ k.lastUsedAt ? fmtDay(k.lastUsedAt) : '—' }}
          </p>
        </div>
        <button v-if="!k.revokedAt" :data-testid="`token-revoke-${k.id}`"
          class="relative p-1 rounded text-on-surface-variant hover:text-error hover:bg-error/10 shrink-0 max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="$t('userCenter.tokens.revokeConfirmTitle')"
          @click="askRevoke(k)"><span class="material-symbols-outlined text-base">block</span></button>
      </div>
    </div>
  </div>

  <!-- 签发表单 -->
  <Modal v-model="showMint" :title="$t('userCenter.tokens.mintBtn')" width="max-w-md">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.tokens.mintCluster') }}</label>
        <select v-model="mintForm.clusterId" data-testid="token-mint-cluster"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
          <option value="" disabled>—</option>
          <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name || c.id }}</option>
        </select>
      </div>
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.tokens.mintNamespace') }}</label>
        <input v-model="mintForm.namespace" data-testid="token-mint-namespace"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" />
      </div>
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.tokens.mintTier') }}</label>
        <div class="flex gap-xs">
          <button data-testid="token-mint-tier-read"
            :class="['px-md py-sm rounded-lg border text-body-sm', mintForm.tier === 'read' ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-outline-variant text-on-surface-variant']"
            @click="mintForm.tier = 'read'">{{ $t('userCenter.tokens.tierRead') }}</button>
          <button data-testid="token-mint-tier-operator"
            :class="['px-md py-sm rounded-lg border text-body-sm', mintForm.tier === 'operator' ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-outline-variant text-on-surface-variant']"
            @click="mintForm.tier = 'operator'">{{ $t('userCenter.tokens.tierOperator') }}</button>
        </div>
      </div>
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.tokens.mintTtl') }}</label>
        <select v-model.number="mintForm.ttlDays" data-testid="token-mint-ttl"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
          <option :value="7">7</option>
          <option :value="30">30</option>
          <option :value="90">90</option>
        </select>
      </div>
      <p v-if="mintError" class="text-body-xs text-error">{{ mintError }}</p>
    </div>
    <template #actions>
      <button class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high"
        @click="showMint = false">{{ $t('component.modal.cancel') }}</button>
      <button data-testid="token-mint-submit"
        class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold"
        @click="mint">{{ $t('userCenter.tokens.mintSubmit') }}</button>
    </template>
  </Modal>

  <!-- 明文仅显一次 -->
  <Modal :model-value="!!plaintext" :title="$t('userCenter.tokens.plaintextTitle')" width="max-w-md"
    @update:model-value="v => { if (!v) closePlaintext() }">
    <p class="text-body-sm text-error mb-md flex items-center gap-xs">
      <span class="material-symbols-outlined text-base">warning</span>{{ $t('userCenter.tokens.plaintextHint') }}
    </p>
    <div data-testid="token-plaintext"
      class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm font-mono text-body-sm break-all">{{ plaintext }}</div>
    <template #actions>
      <button data-testid="token-copy"
        class="flex items-center gap-xs px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high"
        @click="copyPlaintext">
        <span class="material-symbols-outlined text-base">{{ copied ? 'check' : 'content_copy' }}</span>
        {{ copied ? $t('userCenter.tokens.copied') : $t('userCenter.tokens.copy') }}
      </button>
      <button data-testid="token-plaintext-close"
        class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold"
        @click="closePlaintext">{{ $t('common.close') }}</button>
    </template>
  </Modal>

  <ConfirmDialog v-model="showRevokeConfirm" danger
    :title="$t('userCenter.tokens.revokeConfirmTitle')"
    :message="$t('userCenter.tokens.revokeConfirmMessage')"
    @confirm="doRevoke" />
</template>
