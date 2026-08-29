<script setup>
// 样式化开关(全站可复用):受控组件,v-model:checked;disabled 时降低透明度。
const props = defineProps({
  checked: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: '' },
})
const emit = defineEmits(['update:checked'])
const toggle = () => { if (!props.disabled) emit('update:checked', !props.checked) }
</script>

<template>
  <button type="button" role="switch" :aria-checked="checked" data-test="toggle"
    :disabled="disabled" @click="toggle" :title="title"
    class="relative inline-flex h-[18px] w-[34px] items-center rounded-full transition-colors shrink-0 disabled:opacity-40"
    :class="checked ? 'bg-primary' : 'bg-surface-container-highest border border-outline-variant'">
    <span class="inline-block h-[14px] w-[14px] transform rounded-full bg-white shadow transition-transform"
      :class="checked ? 'translate-x-[18px]' : 'translate-x-[2px]'"></span>
  </button>
</template>
