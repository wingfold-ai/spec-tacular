<script setup lang="ts">
// spec-tacular › docs › getting-started › installation, like the TUI breadcrumb.
const props = defineProps<{ path: string }>()
const parts = computed(() => props.path.split('/').filter(Boolean))
</script>

<template>
  <p class="text-xs text-st-faint">
    <NuxtLink to="/" class="hover:text-st-strong">spec-tacular</NuxtLink>
    <template v-for="(p, i) in parts" :key="i">
      <span class="mx-1.5">›</span>
      <NuxtLink v-if="i === 0 && parts.length > 1" to="/docs" class="hover:text-st-strong">{{ p }}</NuxtLink>
      <span v-else :class="i === parts.length - 1 ? 'text-st-dim' : ''">{{ p }}</span>
    </template>
  </p>
</template>
