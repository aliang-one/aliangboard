<template>
  <button :title="t('common.sync')" @click="onSync">{{ t('common.sync') }}</button>
</template>
<script setup>
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
function onSync() {
  ElMessage.success(t('common.success'))
}
</script>
