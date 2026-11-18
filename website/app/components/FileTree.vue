<script setup lang="ts">
// `notes` is a list of { path, note }: MDC/YAML object keys containing dots
// (review.md) do not survive Nuxt Content, so paths are values, not keys.
const props = withDefaults(defineProps<{ tree?: string, notes?: { path: string, note: string }[] }>(), {
  tree: '',
  notes: () => [],
})
const noteMap = computed<Record<string, string>>(() => Object.fromEntries(props.notes.map(n => [n.path, n.note])))

interface Row { name: string, folder: boolean, prefix: string, note?: string }

const rows = computed<Row[]>(() => {
  const items = props.tree.split('\n').filter(l => l.trim()).map((l) => {
    const depth = Math.floor((l.length - l.trimStart().length) / 2)
    const name = l.trim()
    return { depth, name, folder: name.endsWith('/') }
  })
  // is this item the last child of its parent?
  const isLast = (i: number) => {
    for (let j = i + 1; j < items.length; j++) {
      if (items[j]!.depth < items[i]!.depth) return true
      if (items[j]!.depth === items[i]!.depth) return false
    }
    return true
  }
  return items.map((it, i) => {
    if (it.depth === 0) return { name: it.name, folder: it.folder, prefix: '', note: noteMap.value[it.name] }
    let prefix = isLast(i) ? '└── ' : '├── '
    // ancestors' guides
    let d = it.depth - 1
    for (let j = i - 1; j >= 0 && d >= 1; j--) {
      if (items[j]!.depth === d) {
        prefix = (isLast(j) ? '    ' : '│   ') + prefix
        d--
      }
    }
    return { name: it.name, folder: it.folder, prefix, note: noteMap.value[it.name] }
  })
})
const annotated = computed(() => rows.value.filter(r => r.note))
</script>

<template>
  <div class="grid gap-x-6 gap-y-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
    <TuiPanel title="my-project" :right="`${rows.length} entries`" deep :pad="false">
      <ul class="m-0 list-none overflow-x-auto px-3 pb-3 pt-5 text-[12px] leading-relaxed sm:px-4 sm:text-[13px]" aria-label="Repository file tree">
        <li v-for="(r, i) in rows" :key="i" class="flex flex-wrap items-baseline gap-x-3 whitespace-nowrap">
          <span>
            <span class="whitespace-pre text-st-faint" aria-hidden="true">{{ r.prefix }}</span><span :class="r.folder ? 'text-st-accent' : 'text-st-text'">{{ r.name }}</span>
          </span>
          <span v-if="r.note" class="whitespace-normal text-xs text-st-ok max-sm:basis-full max-sm:pl-4"><span class="text-st-faint">←</span> {{ r.note }}</span>
        </li>
      </ul>
    </TuiPanel>

    <TuiPanel v-if="annotated.length" title="notes" :right="`${annotated.length}`" :pad="false">
      <dl class="m-0 divide-y divide-dashed divide-st-border pb-2 pt-4">
        <div v-for="r in annotated" :key="r.name" class="tui-row py-2.5 pl-6 pr-3">
          <dt class="break-words font-mono text-sm" :class="r.folder ? 'text-st-accent' : 'text-st-strong'">{{ r.name }}</dt>
          <dd class="m-0 mt-0.5 text-sm text-st-dim"><span class="text-st-faint" aria-hidden="true">└ </span>{{ r.note }}</dd>
        </div>
      </dl>
    </TuiPanel>
  </div>
</template>
