<script setup lang="ts">
interface Stage { key: string, label: string, artifact: string, gate: string, text: string }
const props = withDefaults(defineProps<{
  before?: { label: string, text: string }[]
  stages: Stage[]
  note?: string
}>(), { before: () => [] })

// The pipeline bar steps a ● through the stages, like a change moving on in the TUI.
// SSR and reduced motion show a still frame: proposal ✓, specs ● in review.
const active = ref(1)
const root = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
let io: IntersectionObserver | null = null

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}
function start() {
  if (timer) return
  timer = setInterval(() => {
    // one extra beat at the end where every stage shows ✓
    active.value = (active.value + 1) % (props.stages.length + 1)
  }, 1500)
}
onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return
  io = new IntersectionObserver(([en]) => (en?.isIntersecting ? start() : stop()), { threshold: 0.25 })
  if (root.value) io.observe(root.value)
})
onBeforeUnmount(() => { stop(); io?.disconnect() })

function mark(i: number) {
  if (i < active.value) return { sym: '✓', cls: 'text-st-ok', sr: 'done' }
  if (i === active.value) return { sym: '●', cls: 'text-st-accent', sr: 'in review' }
  return { sym: '○', cls: 'text-st-faint', sr: 'not started' }
}
const pad = (n: number) => String(n).padStart(2, '0')
const dots = '·'.repeat(160)
</script>

<template>
  <div ref="root" class="space-y-8">
    <!-- the TUI's pipeline bar -->
    <div class="term-frame flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-xs sm:px-4 sm:text-sm" aria-hidden="true">
      <span class="text-st-accent">▸</span>
      <span v-for="b in before" :key="b.label" class="text-st-faint">{{ b.label.toLowerCase() }} <span class="text-st-ok">✓</span></span>
      <span v-if="before.length" class="text-st-border">│</span>
      <span
        v-for="(s, i) in stages"
        :key="s.key"
        class="transition-colors"
        :class="i === active ? 'font-bold text-st-strong' : i < active ? 'text-st-dim' : 'text-st-faint'"
      >{{ i === active ? s.key.toUpperCase() : s.key }} <span :class="mark(i).cls">{{ mark(i).sym }}</span></span>
    </div>

    <!-- once per project -->
    <div v-if="before.length">
      <TuiPanel title="once per project" right="project-level" deep class="border-dashed">
        <ol class="m-0 list-none space-y-1 p-0">
          <li
            v-for="b in before"
            :key="b.label"
            class="tui-row grid grid-cols-[2ch_minmax(0,1fr)] gap-x-2 py-2 pl-6 pr-2 sm:grid-cols-[2ch_14ch_minmax(0,1fr)] sm:gap-x-3"
          >
            <span class="text-st-ok" aria-hidden="true">✓</span>
            <h3 class="text-sm font-bold text-st-strong">{{ b.label }}</h3>
            <p class="col-start-2 text-sm leading-relaxed text-st-dim sm:col-start-auto">{{ b.text }}</p>
          </li>
        </ol>
      </TuiPanel>
      <p class="mt-3 pl-4 font-mono text-xs text-st-faint" aria-hidden="true">
        └─▸ then, for every change
      </p>
    </div>

    <!-- the change pipeline: one row per stage -->
    <TuiPanel title="every change" :right="`${stages.length} stages`" deep>
      <ol class="m-0 list-none divide-y divide-dashed divide-st-border p-0">
        <li
          v-for="(s, i) in stages"
          :key="s.key"
          class="tui-row grid grid-cols-[2ch_3ch_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1 py-3 pl-6 pr-2 md:grid-cols-[2ch_3ch_11ch_16ch_minmax(2ch,1fr)_auto] md:gap-x-3"
        >
          <span class="transition-colors" :class="mark(i).cls"><span aria-hidden="true">{{ mark(i).sym }}</span></span>
          <span class="text-sm text-st-faint">{{ pad(i + 1) }}</span>
          <h3 class="text-sm font-bold text-st-strong">{{ s.label }}</h3>
          <code class="col-start-3 break-words text-xs text-st-cyan md:col-start-auto md:text-sm">{{ s.artifact }}</code>
          <span class="hidden select-none overflow-hidden whitespace-nowrap text-st-border md:block" aria-hidden="true">{{ dots }}</span>
          <p class="col-start-3 text-xs md:col-start-auto md:text-right">
            <span class="sr-only">Gate: </span>
            <span class="text-st-faint" aria-hidden="true">[ </span><span class="text-st-accent"><span aria-hidden="true">⊙ </span>{{ s.gate.toLowerCase() }}</span><span class="text-st-faint" aria-hidden="true"> ]</span>
          </p>
          <p class="col-start-3 text-sm leading-relaxed text-st-dim md:col-[3/-1]">{{ s.text }}</p>
        </li>
      </ol>
    </TuiPanel>

    <p v-if="note" class="max-w-3xl font-mono text-sm leading-relaxed text-st-dim">
      <span class="text-st-faint" aria-hidden="true"># note: </span>{{ note }}
    </p>
  </div>
</template>
