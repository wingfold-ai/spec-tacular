<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  text?: string
}>(), {})
const { data: site } = await useSite()
const repo = computed(() => site.value?.repo)
const version = computed(() => site.value?.version)
</script>

<template>
  <!-- The last screen: a TUI dialog box. -->
  <section class="border-t border-st-border bg-st-bg-deep/85" style="--tui-outer: var(--st-bg-deep)">
    <div class="container-page py-16 sm:py-24">
      <TuiPanel title="ready?" :right="version" tone="accent" class="mx-auto max-w-2xl !px-5 !pb-6 !pt-8 sm:!px-8">
        <h2 class="gradient-text text-balance pb-1 text-2xl font-bold tracking-tight sm:text-3xl">
          {{ title }}
        </h2>
        <p v-if="text" class="mt-3 text-pretty text-sm leading-relaxed text-st-dim sm:text-base">
          {{ text }}
        </p>
        <div class="mt-6">
          <InstallCommand />
        </div>
        <div class="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-st-border pt-4">
          <span class="text-xs text-st-faint">free · MIT · runs locally</span>
          <a
            v-if="repo"
            :href="repo"
            target="_blank"
            rel="noopener"
            class="tui-btn tui-btn-primary"
          >[ View on GitHub ]</a>
        </div>
      </TuiPanel>
    </div>
  </section>
</template>
