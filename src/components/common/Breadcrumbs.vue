<script setup>
defineProps({
  items: { type: Array, required: true },
})
</script>

<template>
  <nav class="flex items-center gap-2 text-on-surface-variant text-body-sm mb-1">
    <template v-for="(item, idx) in items" :key="idx">
      <router-link
        v-if="item.route"
        :to="item.route"
        class="hover:text-primary transition-colors"
      >{{ item.label }}</router-link>
      <span v-else :class="idx === items.length - 1 ? 'text-primary font-medium' : ''">{{ item.label }}</span>
      <span v-if="idx < items.length - 1" class="material-symbols-outlined text-sm">chevron_right</span>
    </template>
  </nav>
</template>
