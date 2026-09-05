<!-- src/components/workbench/WbStage.vue -->
<template>
  <!-- workbench 独立舞台(spec 2026-09-05 §3):圆角容器+回声线(inset 3px、圆角 13px=16-3
       同心)——舷板「双钩边」语言的直角版,模块 DNA 可识别。h-full 依赖 fullHeight 契约
       (父级有确定高度);titleBar 可选段 + default 段(flex-1 min-h-0,内容自管滚动)。 -->
  <div class="wb-stage relative h-full flex flex-col rounded-2xl border border-outline-variant overflow-hidden bg-surface-container-lowest/85 dark:bg-surface-container/85 shadow-card dark:shadow-none">
    <div data-test="wb-stage-echo" aria-hidden="true"
      class="pointer-events-none absolute inset-[3px] rounded-[13px] border border-outline-variant/40"></div>
    <div v-if="$slots.titleBar" class="relative shrink-0">
      <slot name="titleBar" />
    </div>
    <div class="relative flex-1 min-h-0 flex flex-col">
      <slot />
    </div>
  </div>
</template>
