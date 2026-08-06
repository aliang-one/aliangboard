<template>
  <button title="刷新">{{ t('common.sync') }}<span>刷新</span></button>
  <!-- 这是注释，不应被报告 -->
</template>
<script setup>
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
console.log('调试日志不应被报告')
ElMessage.error('创建失败')
</script>
