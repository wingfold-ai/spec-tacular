<script setup lang="ts">
// A keyboard key, e.g. <KeyCap k="a" />. `active` lights it up (demo feedback).
// Square, 1px rule with a 2px base: a keycap drawn on the character grid.
defineProps<{ k: string, active?: boolean, tone?: 'ok' | 'err' | 'warn' | 'accent' }>()
</script>

<template>
  <kbd
    class="inline-flex min-w-[1.7em] items-center justify-center border border-b-2 px-[0.4em] py-[0.15em] font-mono text-[0.8em] font-bold leading-none transition-colors"
    :class="active
      ? {
        'border-st-ok text-st-ok bg-st-highlight': tone === 'ok',
        'border-st-err text-st-err bg-st-highlight': tone === 'err',
        'border-st-warn text-st-warn bg-st-highlight': tone === 'warn',
        'border-st-accent text-st-accent bg-st-highlight': !tone || tone === 'accent',
      }
      : 'border-st-border bg-st-bg-deep text-st-strong'"
  >{{ k }}</kbd>
</template>
