<script setup lang="ts">
const { data: site } = await useSite()
</script>

<template>
  <footer class="border-t border-st-border bg-st-bg py-8 text-xs text-st-faint">
    <div class="container-page flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <p>
        <span class="text-st-dim">spec-tacular {{ site?.version }}</span> · MIT ·
        built on <a href="https://github.com/Fission-AI/OpenSpec" class="text-st-dim underline decoration-st-border underline-offset-4 hover:text-st-strong">OpenSpec</a>
        · <span class="text-st-ok">exit 0</span>
      </p>
      <nav class="flex flex-wrap gap-x-5 gap-y-2" aria-label="Footer">
        <a v-for="item in site?.footer" :key="item.to" :href="item.to" class="text-st-dim hover:text-st-strong">{{ item.label.toLowerCase() }}</a>
      </nav>
    </div>
  </footer>
</template>
