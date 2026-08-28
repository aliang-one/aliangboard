<script setup>
// SSH 服务器表单(新增/编辑两用)。凭据字段编辑态恒空、placeholder「留空保持不变」;
// exposeToAi 开关联动审批策略下拉。submit 只 emit,网络与关闭由父组件负责。
import { reactive, computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const props = defineProps({ server: { type: Object, default: null }, busy: { type: Boolean, default: false } })
const emit = defineEmits(['submit', 'cancel'])

const form = reactive({
  name: props.server?.name || '', host: props.server?.host || '', port: props.server?.port ?? 22,
  username: props.server?.username || '', authMethod: props.server?.authMethod || 'password',
  password: '', privateKey: '', passphrase: '', sudoPassword: '',
  description: props.server?.description || '', clusterRef: props.server?.clusterRef || '',
  tagsText: (props.server?.tags || []).join(','),
  exposeToAi: !!props.server?.exposeToAi, aiApprovalPolicy: props.server?.aiApprovalPolicy || 'always',
})
const errors = reactive({})
const isEdit = computed(() => !!props.server)

function validate() {
  errors.name = form.name.trim() ? '' : t('ssh.errRequired', { field: t('ssh.name') })
  errors.host = form.host.trim() ? '' : t('ssh.errRequired', { field: t('ssh.host') })
  errors.username = form.username.trim() ? '' : t('ssh.errRequired', { field: t('ssh.username') })
  if (form.authMethod === 'password' && !isEdit.value && !form.password) errors.password = t('ssh.errRequired', { field: t('ssh.password') })
  if (form.authMethod === 'privateKey' && !isEdit.value && !form.privateKey) errors.privateKey = t('ssh.errRequired', { field: t('ssh.privateKey') })
  return !Object.values(errors).some(Boolean)
}

function onSubmit() {
  if (!validate()) return
  const payload = {
    name: form.name.trim(), host: form.host.trim(), port: Number(form.port) || 22,
    username: form.username.trim(), authMethod: form.authMethod,
    description: form.description, clusterRef: form.clusterRef,
    tags: form.tagsText.split(',').map(s => s.trim()).filter(Boolean),
    exposeToAi: form.exposeToAi, aiApprovalPolicy: form.aiApprovalPolicy,
  }
  for (const f of ['password', 'privateKey', 'passphrase', 'sudoPassword']) {
    if (form[f]) payload[f] = form[f]            // 非空才带上(空=保持)
    else if (!isEdit.value && f === (form.authMethod === 'password' ? 'password' : 'privateKey')) payload[f] = form[f]
  }
  emit('submit', payload)
}
</script>

<template>
  <form data-test="sshServerForm" class="flex flex-col gap-md" @submit.prevent="onSubmit">
    <div class="grid grid-cols-2 gap-md">
      <label class="flex flex-col gap-xs"><span>{{ t('ssh.name') }} <b class="text-error">*</b></span>
        <input data-test="name" v-model="form.name" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono" />
        <p v-if="errors.name" class="text-body-xs text-error">{{ errors.name }}</p></label>
      <label class="flex flex-col gap-xs"><span>{{ t('ssh.host') }} <b class="text-error">*</b></span>
        <input data-test="host" v-model="form.host" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono" />
        <p v-if="errors.host" class="text-body-xs text-error">{{ errors.host }}</p></label>
      <label class="flex flex-col gap-xs"><span>{{ t('ssh.port') }}</span>
        <input data-test="port" v-model.number="form.port" type="number" min="1" max="65535" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono" /></label>
      <label class="flex flex-col gap-xs"><span>{{ t('ssh.username') }} <b class="text-error">*</b></span>
        <input data-test="username" v-model="form.username" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono" />
        <p v-if="errors.username" class="text-body-xs text-error">{{ errors.username }}</p></label>
      <label class="flex flex-col gap-xs"><span>{{ t('ssh.authMethod') }}</span>
        <select data-test="authMethod" v-model="form.authMethod" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm">
          <option value="password">{{ t('ssh.authPassword') }}</option>
          <option value="privateKey">{{ t('ssh.authPrivateKey') }}</option>
        </select></label>
      <label v-if="form.authMethod === 'password'" class="flex flex-col gap-xs"><span>{{ t('ssh.password') }} <b v-if="!isEdit" class="text-error">*</b></span>
        <input data-test="password" v-model="form.password" type="password" autocomplete="new-password" :placeholder="isEdit ? t('ssh.keepBlank') : ''" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono" />
        <p v-if="errors.password" class="text-body-xs text-error">{{ errors.password }}</p></label>
    </div>
    <label v-if="form.authMethod === 'privateKey'" class="flex flex-col gap-xs"><span>{{ t('ssh.privateKey') }} <b v-if="!isEdit" class="text-error">*</b></span>
      <textarea data-test="privateKey" v-model="form.privateKey" rows="5" :placeholder="isEdit ? t('ssh.keepBlank') : '-----BEGIN OPENSSH PRIVATE KEY-----'" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-xs font-mono" />
      <p v-if="errors.privateKey" class="text-body-xs text-error">{{ errors.privateKey }}</p></label>
    <div class="grid grid-cols-2 gap-md">
      <label v-if="form.authMethod === 'privateKey'" class="flex flex-col gap-xs"><span>{{ t('ssh.passphrase') }}</span>
        <input data-test="passphrase" v-model="form.passphrase" type="password" autocomplete="new-password" :placeholder="isEdit ? t('ssh.keepBlank') : ''" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono" /></label>
      <label class="flex flex-col gap-xs"><span>{{ t('ssh.sudoPassword') }}</span>
        <input data-test="sudoPassword" v-model="form.sudoPassword" type="password" autocomplete="new-password" :placeholder="isEdit ? t('ssh.keepBlank') : t('ssh.sudoPasswordHint')" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono" /></label>
      <label class="flex flex-col gap-xs"><span>{{ t('ssh.clusterRef') }}</span>
        <input data-test="clusterRef" v-model="form.clusterRef" :placeholder="t('ssh.clusterRefHint')" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm" /></label>
      <label class="flex flex-col gap-xs"><span>{{ t('ssh.tags') }}</span>
        <input data-test="tags" v-model="form.tagsText" placeholder="web,prod" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm font-mono" /></label>
    </div>
    <label class="flex flex-col gap-xs"><span>{{ t('ssh.description') }}</span>
      <input data-test="description" v-model="form.description" class="bg-surface-container-low border rounded-lg px-md py-sm text-body-sm" /></label>
    <div class="flex items-center gap-md p-sm rounded-lg bg-surface-container">
      <label class="flex items-center gap-sm cursor-pointer">
        <input data-test="exposeToAi" v-model="form.exposeToAi" type="checkbox" class="w-4 h-4" />
        <span class="text-body-sm">{{ t('ssh.exposeToAi') }}</span>
      </label>
      <template v-if="form.exposeToAi">
        <label class="flex items-center gap-sm text-body-sm">{{ t('ssh.aiApprovalPolicy') }}
          <select data-test="aiApprovalPolicy" v-model="form.aiApprovalPolicy" class="bg-surface-container-lowest border rounded-lg px-sm py-xs text-body-sm">
            <option value="always">{{ t('ssh.policyAlways') }}</option>
            <option value="readonly">{{ t('ssh.policyReadonly') }}</option>
            <option value="none">{{ t('ssh.policyNone') }}</option>
          </select></label>
      </template>
    </div>
    <p v-if="form.exposeToAi" class="text-body-xs text-on-surface-variant">{{ t('ssh.exposeHint') }}</p>
    <div class="flex justify-end gap-sm">
      <button type="button" @click="emit('cancel')" class="px-lg py-sm rounded-lg border text-body-sm">{{ t('common.cancel') }}</button>
      <button type="submit" :disabled="props.busy" class="px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm disabled:opacity-50">
        {{ props.busy ? t('ssh.saving') : t('common.save') }}</button>
    </div>
  </form>
</template>
