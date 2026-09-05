<script setup>
// 集群台账独立路由页:舞台壳(WbStage)+ 纯内容组件 WorkbenchLedger。
// Ledger 还有第二个消费方(Shell 知识 tab 内嵌),故舞台只在此页,内容组件保持文档形态。
import WbStage from '@/components/workbench/WbStage.vue'
import { useI18n } from 'vue-i18n'
import WorkbenchLedger from '@/views/WorkbenchLedger.vue'

const { t } = useI18n()
</script>

<template>
  <section class="h-full min-h-0 p-md">
    <WbStage>
      <template #titleBar>
        <div class="px-md py-sm border-b border-outline-variant/40">
          <h2 class="text-headline-sm font-bold text-on-surface flex items-center gap-sm"><span class="material-symbols-outlined">menu_book</span> {{ t('workbench.ledger.title') }}</h2>
        </div>
      </template>
      <div class="flex-1 min-h-0 overflow-y-auto">
        <WorkbenchLedger />
      </div>
    </WbStage>
  </section>
</template>
