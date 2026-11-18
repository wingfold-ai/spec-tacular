<script setup lang="ts">
interface Item { icon?: string, keys?: string[], title: string, text: string }
const props = withDefaults(defineProps<{
  items: Item[]
  columns?: 2 | 3
  compact?: boolean
}>(), { columns: 3, compact: false, items: () => [] })

// Lucide names from content → the glyph the TUI would draw. Unknown icons fall back to the icon itself.
const GLYPHS: Record<string, { g: string, cls: string }> = {
  'i-lucide-triangle-alert': { g: '⚠', cls: 'text-st-warn' },
  'i-lucide-git-compare': { g: '!', cls: 'text-st-warn' },
  'i-lucide-octagon-x': { g: '⊘', cls: 'text-st-err' },
  'i-lucide-compass': { g: '◆', cls: 'text-st-accent' },
  'i-lucide-map': { g: '▤', cls: 'text-st-accent' },
  'i-lucide-shield-check': { g: '✓', cls: 'text-st-ok' },
  'i-lucide-square-dashed': { g: '⬚', cls: 'text-st-accent' },
  'i-lucide-terminal': { g: '>_', cls: 'text-st-accent2' },
  'i-lucide-list-checks': { g: '☑', cls: 'text-st-ok' },
}
const glyph = (icon?: string) => (icon ? GLYPHS[icon] : undefined)

const mode = computed(() => (props.items.some(i => i.keys?.length) ? 'keys' : props.compact ? 'compact' : 'panels'))
const pad = (n: number) => String(n).padStart(2, '0')
const dots = '·'.repeat(80)
</script>

<template>
  <!-- keys: a keymap table, like the TUI's ? help -->
  <TuiPanel v-if="mode === 'keys'" title="keymap" right="? for every key" deep>
    <dl class="m-0 divide-y divide-dashed divide-st-border">
      <div
        v-for="item in items"
        :key="item.title"
        class="tui-row grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 py-4 pl-6 pr-2 sm:grid-cols-[4.5rem_18ch_minmax(0,1fr)] sm:gap-x-4"
      >
        <dt class="contents">
          <span class="flex gap-1.5 text-2xl" aria-hidden="true">
            <KeyCap v-for="k in item.keys" :key="k" :k="k" />
          </span>
          <span class="flex items-baseline gap-2 font-bold text-st-strong">
            <span class="sr-only">Key {{ item.keys?.join(' ') }}: </span>{{ item.title.toLowerCase() }}
            <span class="hidden min-w-0 flex-1 select-none overflow-hidden whitespace-nowrap font-normal text-st-border sm:block" aria-hidden="true">{{ dots }}</span>
          </span>
        </dt>
        <dd class="col-start-2 m-0 text-sm leading-relaxed text-st-dim sm:col-start-auto">
          {{ item.text }}
        </dd>
      </div>
    </dl>
  </TuiPanel>

  <!-- compact: a dense list of rows, one marker each -->
  <ul
    v-else-if="mode === 'compact'"
    class="m-0 grid list-none gap-0 border-y border-st-border p-0"
    :class="columns === 3 ? 'lg:grid-cols-3 lg:divide-x lg:divide-st-border' : 'sm:grid-cols-2 sm:divide-x sm:divide-st-border'"
  >
    <li
      v-for="item in items"
      :key="item.title"
      class="tui-row grid grid-cols-[2.5ch_minmax(0,1fr)] gap-x-2 border-b border-dashed border-st-border py-4 pl-6 pr-3 last:border-b-0 lg:border-b-0"
    >
      <span v-if="glyph(item.icon)" class="font-bold" :class="glyph(item.icon)!.cls" aria-hidden="true">{{ glyph(item.icon)!.g }}</span>
      <UIcon v-else-if="item.icon" :name="item.icon" class="mt-1 size-4 text-st-accent" aria-hidden="true" />
      <span v-else class="text-st-accent" aria-hidden="true">●</span>
      <h3 class="text-sm font-bold text-st-strong">{{ item.title }}</h3>
      <p class="col-start-2 mt-1 text-sm leading-relaxed text-st-dim">{{ item.text }}</p>
    </li>
  </ul>

  <!-- panels: titled TUI boxes -->
  <ul
    v-else
    class="m-0 grid list-none gap-x-4 gap-y-8 p-0 pt-2"
    :class="columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'"
  >
    <li v-for="(item, i) in items" :key="item.title" class="flex">
      <TuiPanel :title="`${pad(i + 1)}/${pad(items.length)}`" class="flex w-full flex-col">
        <h3 class="flex items-baseline gap-3 text-base font-bold leading-snug text-st-strong">
          <span v-if="glyph(item.icon)" class="w-[2ch] shrink-0" :class="glyph(item.icon)!.cls" aria-hidden="true">{{ glyph(item.icon)!.g }}</span>
          <UIcon v-else-if="item.icon" :name="item.icon" class="size-4 shrink-0 self-center text-st-accent" aria-hidden="true" />
          <span>{{ item.title }}</span>
        </h3>
        <p class="mt-3 text-sm leading-relaxed text-st-dim">
          {{ item.text }}
        </p>
      </TuiPanel>
    </li>
  </ul>
</template>
