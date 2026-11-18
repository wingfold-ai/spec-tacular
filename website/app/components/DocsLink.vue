<script setup lang="ts">
// A link into the docs from a landing section: ::docs-link{to="/docs/..." label="…"}
defineProps<{ to: string, label: string, hint?: string }>()
</script>

<template>
  <p class="flex flex-wrap items-center gap-3 text-sm">
    <NuxtLink :to="to" class="tui-btn">[ {{ label }} → ]</NuxtLink>
    <span v-if="hint" class="text-xs text-st-faint"># {{ hint }}</span>
  </p>
</template>
