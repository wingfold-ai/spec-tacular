<script setup lang="ts">
// Previous / next page, as two TUI buttons with their keys (p / n).
interface Item { path: string, title: string, description?: string }
defineProps<{ prev?: Item | null, next?: Item | null }>()
</script>

<template>
  <nav class="mt-16 grid gap-3 border-t border-st-border pt-8 sm:grid-cols-2" aria-label="Pages">
    <NuxtLink v-if="prev" :to="prev.path" class="tui-btn !block !px-4 !py-3">
      <span class="block text-xs text-st-faint"><KeyCap k="p" /> previous</span>
      <span class="mt-1 block text-st-strong">← {{ prev.title }}</span>
    </NuxtLink>
    <span v-else />
    <NuxtLink v-if="next" :to="next.path" class="tui-btn !block !px-4 !py-3 text-right">
      <span class="block text-xs text-st-faint">next <KeyCap k="n" /></span>
      <span class="mt-1 block text-st-strong">{{ next.title }} →</span>
    </NuxtLink>
  </nav>
</template>
