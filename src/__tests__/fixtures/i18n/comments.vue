<template>
  <div>{{ t('x.y') }}</div>
</template>
<script setup>
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const a = 1 // 这是行尾注释不应报告
const b = 2 /* 这是行内块注释不应报告 */
const c = 3
/* 这是独占一行的块注释不应报告 */
const d = 4
ElMessage.error('真正的用户文案应报告')
</script>
