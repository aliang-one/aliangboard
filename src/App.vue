<script setup>
import { RouterView, useRoute } from 'vue-router'
import { watch } from 'vue'
import { i18n } from '@/i18n'
import { applyRouteTitle } from '@/router'
import ApplyToast from '@/components/common/ApplyToast.vue'

const route = useRoute()
// 切语言 → document.title 即时跟随（首次导航标题由 router.afterEach 守卫负责）
watch(() => i18n.global.locale.value, () => applyRouteTitle(route.meta))
</script>

<template>
  <RouterView />
  <ApplyToast />
</template>
