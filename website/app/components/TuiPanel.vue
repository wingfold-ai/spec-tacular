<script setup lang="ts">
/**
 * A TUI box with its title set into the top border, like OpenTUI's titled boxes:
 *
 *   ┌─ title ──────────────── right ─┐
 *   │ slot                           │
 *   └────────────────────────────────┘
 *
 * `tone` colours the border (focus = accent, as the TUI marks the focused pane).
 * `deep` uses the terminal background instead of the panel background.
 */
const _p = withDefaults(defineProps<{
  title?: string
  right?: string
  tone?: 'default' | 'accent' | 'ok' | 'warn' | 'err'
  deep?: boolean
  pad?: boolean
  as?: string
}>(), { tone: 'default', deep: false, pad: true, as: 'div' })

// The title sits on the border line: its upper half shows the surface outside the
// box (--tui-outer, set by a band section), its lower half the box's own background.
const notch = computed(() => ({
  background: `linear-gradient(to bottom, var(--tui-outer, var(--st-bg)) 50%, ${_p.deep ? 'var(--st-bg-deep)' : 'var(--st-panel)'} 50%)`,
}))
</script>

<template>
  <component
    :is="as"
    class="tui-panel relative border"
    :class="[
      deep ? 'bg-st-bg-deep' : 'bg-st-panel',
      {
        'border-st-border': tone === 'default',
        'border-st-accent': tone === 'accent',
        'border-st-ok': tone === 'ok',
        'border-st-warn': tone === 'warn',
        'border-st-err': tone === 'err',
      },
      pad ? 'px-4 pb-4 pt-5' : '',
    ]"
  >
    <span
      v-if="title"
      class="absolute -top-[0.7em] left-3 px-1.5 font-mono text-xs leading-[1.4em]"
      :class="tone === 'default' ? 'text-st-dim' : `text-st-${tone}`"
      :style="notch"
    ><span class="text-st-faint">─ </span>{{ title }}<span class="text-st-faint"> ─</span></span>
    <span
      v-if="right"
      class="absolute -top-[0.7em] right-3 px-1.5 font-mono text-xs leading-[1.4em] text-st-faint"
      :style="notch"
    >{{ right }}</span>
    <slot />
  </component>
</template>
