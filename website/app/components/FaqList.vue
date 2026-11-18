<script setup lang="ts">
withDefaults(defineProps<{
  items: { q: string, a: string }[]
}>(), { items: () => [] })
const pad = (n: number) => String(n).padStart(2, '0')
</script>

<template>
  <div class="max-w-3xl border-y border-st-border">
    <details
      v-for="(item, i) in items"
      :key="item.q"
      class="faq group border-b border-dashed border-st-border last:border-b-0"
    >
      <summary
        class="grid cursor-pointer list-none grid-cols-[2ch_3ch_minmax(0,1fr)] items-baseline gap-x-2 py-3 pl-2 pr-3 outline-none transition-colors hover:bg-st-highlight focus-visible:bg-st-highlight group-open:bg-st-panel [&::-webkit-details-marker]:hidden"
      >
        <span class="text-st-faint transition-colors group-hover:text-st-accent group-open:text-st-accent" aria-hidden="true">
          <span class="group-open:hidden">▸</span><span class="hidden group-open:inline">▾</span>
        </span>
        <span class="text-xs text-st-faint" aria-hidden="true">{{ pad(i + 1) }}</span>
        <h3 class="m-0 text-sm font-bold text-st-strong sm:text-base">
          {{ item.q }}
        </h3>
      </summary>
      <p class="m-0 ml-[calc(5ch+1.5rem)] mr-3 border-l border-st-border py-3 pl-3 text-sm leading-relaxed text-st-dim">
        {{ item.a }}
      </p>
    </details>
  </div>
</template>
