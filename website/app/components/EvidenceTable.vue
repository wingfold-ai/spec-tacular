<script setup lang="ts">
withDefaults(defineProps<{
  stats: { value: string | number, label: string }[]
  highlight?: string
  caveat?: string
}>(), { stats: () => [] })
const dots = '·'.repeat(120)
</script>

<template>
  <!-- Read like a test-run summary: one PASS line per result, dotted leaders to the value. -->
  <div class="space-y-6">
    <TuiPanel title="run summary" right="expense-splitter" tone="ok" deep>
      <dl class="m-0 text-sm">
        <div
          v-for="s in stats"
          :key="s.label"
          class="tui-row flex items-baseline gap-x-3 py-1.5 pl-6 pr-2"
        >
          <span class="shrink-0 text-xs font-bold text-st-ok" aria-hidden="true">PASS</span>
          <dt class="min-w-0 text-st-dim">{{ s.label }}</dt>
          <span class="min-w-[2ch] flex-1 select-none overflow-hidden whitespace-nowrap text-st-border" aria-hidden="true">{{ dots }}</span>
          <dd class="m-0 shrink-0 whitespace-nowrap text-right text-base font-bold tabular-nums text-st-strong sm:text-lg">{{ s.value }}</dd>
        </div>
      </dl>
      <p class="mt-3 border-t border-dashed border-st-border pl-6 pt-3 text-xs text-st-faint" aria-hidden="true">
        <span class="text-st-ok">{{ stats.length }} passed</span> · single run · scored by an AI evaluator
      </p>
    </TuiPanel>

    <figure v-if="highlight" class="m-0 border-l-2 border-st-ok py-1 pl-4 sm:pl-5">
      <figcaption class="mb-2 font-mono text-xs text-st-faint">
        <span class="text-st-ok">✓</span> from the run log · review
      </figcaption>
      <blockquote class="m-0 text-base leading-relaxed text-st-strong">
        <span class="text-st-faint" aria-hidden="true">&gt; </span>{{ highlight }}
      </blockquote>
    </figure>

    <p v-if="caveat" class="max-w-3xl font-mono text-xs leading-relaxed text-st-dim sm:text-sm">
      <span class="text-st-faint" aria-hidden="true"># note: </span>{{ caveat }}
    </p>
  </div>
</template>
