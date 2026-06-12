<script setup>
import { ref } from 'vue'

const searchQuery = ref('')
</script>

<template>
  <header class="flex justify-between items-center px-lg w-full sticky top-0 z-50 bg-surface h-16 border-b border-outline-variant shrink-0">
    <div class="flex items-center gap-lg flex-1">
      <div class="relative max-w-md w-full">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none">search</span>
        <input
          v-model="searchQuery"
          class="w-full bg-surface-container-low border border-outline-variant rounded-full py-1.5 pl-10 pr-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
          placeholder="Search resources..."
          type="text"
        />
      </div>
    </div>
    <div class="flex items-center gap-md">
      <button class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors relative">
        <span class="material-symbols-outlined">notifications</span>
        <span class="absolute top-1.5 right-1.5 w-2 h-2 bg-error rounded-full"></span>
      </button>
      <button class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
        <span class="material-symbols-outlined">help</span>
      </button>
      <button class="p-sm text-on-surface-variant hover:bg-surface-container-low rounded-full transition-colors">
        <span class="material-symbols-outlined">settings</span>
      </button>
      <div class="h-8 w-px bg-outline-variant mx-2"></div>
      <div class="flex items-center gap-sm cursor-pointer hover:bg-surface-container-low p-1 rounded-lg transition-colors">
        <div class="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-body-sm font-bold">A</div>
        <span class="text-body-sm font-semibold">Admin</span>
        <span class="material-symbols-outlined text-on-surface-variant text-body-sm">expand_more</span>
      </div>
    </div>
  </header>
</template>
