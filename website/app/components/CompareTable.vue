<script setup lang="ts">
type State = 'yes' | 'no' | 'partial' | 'na'
type Cell = string | { state: State, text?: string }
const props = withDefaults(defineProps<{
  columns: string[]
  highlight?: number
  rows: { label: string, cells: Cell[] }[]
  note?: string
}>(), { highlight: -1, columns: () => [], rows: () => [] })

const meta: Record<State, { g: string, cls: string, sr: string }> = {
  yes: { g: '✓', cls: 'text-st-ok', sr: 'Yes' },
  no: { g: '✗', cls: 'text-st-err', sr: 'No' },
  partial: { g: '◐', cls: 'text-st-warn', sr: 'Partly' },
  na: { g: '—', cls: 'text-st-faint', sr: 'Not applicable' },
}
function norm(c: Cell): { state: State, text?: string } {
  return typeof c === 'string' ? { state: c as State } : c
}
const m = (c: Cell) => meta[norm(c).state] ?? meta.na
const hl = (i: number) => i === props.highlight
</script>

<template>
  <div>
    <TuiPanel title="compare" :right="`${rows.length} rows · ${columns.length} tools`" deep :pad="false">
      <!-- `relative` keeps the sr-only spans positioned inside the scroller -->
      <div class="relative overflow-x-auto pt-4 [scrollbar-width:thin]">
        <table class="w-full min-w-[46rem] border-collapse text-left text-sm">
          <caption class="sr-only">
            Feature comparison
          </caption>
          <thead>
            <tr class="border-b border-st-border">
              <th scope="col" class="sticky left-0 z-10 w-[28%] bg-st-bg-deep py-2 pl-4 pr-3 align-bottom text-xs font-normal text-st-faint">
                capability
              </th>
              <th
                v-for="(c, i) in columns"
                :key="c"
                scope="col"
                class="px-3 py-2 align-bottom text-xs"
                :class="hl(i) ? 'bg-st-highlight font-bold text-st-accent' : 'font-normal text-st-faint'"
              >
                <span v-if="hl(i)" aria-hidden="true">▾ </span>{{ c.toLowerCase() }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.label"
              class="group border-b border-dashed border-st-border last:border-b-0"
            >
              <th
                scope="row"
                class="sticky left-0 z-10 bg-st-bg-deep py-3 pl-4 pr-3 align-top font-normal text-st-text transition-colors group-hover:text-st-strong"
              >
                {{ row.label }}
              </th>
              <td
                v-for="(raw, i) in row.cells"
                :key="i"
                class="px-3 py-3 align-top transition-colors"
                :class="hl(i) ? 'bg-st-highlight' : 'group-hover:bg-st-panel'"
              >
                <span class="font-bold" :class="m(raw).cls" aria-hidden="true">{{ m(raw).g }}</span>
                <span class="sr-only">{{ m(raw).sr }}</span>
                <span v-if="norm(raw).text" class="ml-1.5 text-xs leading-snug" :class="hl(i) ? 'text-st-text' : 'text-st-dim'">{{ norm(raw).text }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </TuiPanel>
    <p class="mt-3 font-mono text-xs text-st-faint" aria-hidden="true">
      <span class="text-st-ok">✓</span> yes  ·  <span class="text-st-warn">◐</span> partly  ·  <span class="text-st-err">✗</span> no  ·  — n/a
    </p>
    <p v-if="note" class="mt-2 font-mono text-xs leading-relaxed text-st-dim sm:text-sm">
      <span class="text-st-faint" aria-hidden="true"># note: </span>{{ note }}
    </p>
  </div>
</template>
