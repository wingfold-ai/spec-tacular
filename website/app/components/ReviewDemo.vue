<script setup lang="ts">
interface Scenario { name: string, when: string, then: string }
interface Requirement { capability: string, title: string, text: string, scenarios: Scenario[], flag?: string, revisable?: boolean }

const props = withDefaults(defineProps<{
  change?: string
  total?: number
  startAccepted?: number
  startRejected?: number
  startDeferred?: number
  requirements?: Requirement[]
  revision?: { note: string, text: string }
}>(), {
  change: 'add-export',
  total: 12,
  startAccepted: 0,
  startRejected: 0,
  startDeferred: 0,
  requirements: () => [],
  revision: () => ({ note: 'name a limit', text: '' }),
})

type Kind = 'a' | 'x' | 'd'
const WHY = 'out of scope for this change'
const VERIFY = 'a load test on staging'

const index = ref(0)
const decisions = ref<Kind[]>([])
const revised = ref<Record<number, string>>({}) // index -> original text
const phase = ref<'idle' | 'prompt' | 'note' | 'diff' | 'flash'>('idle')
const promptKind = ref<'x' | 'd' | null>(null)
const flashKind = ref<Kind | null>(null)
const status = ref('')
const rootEl = ref<HTMLElement | null>(null)
const inView = ref(false)
const focused = ref(false)
let timers: ReturnType<typeof setTimeout>[] = []
let observer: IntersectionObserver | null = null

const reduced = ref(false)
const done = computed(() => decisions.value.length >= props.requirements.length)
const current = computed(() => props.requirements[index.value])
const count = (k: Kind) => decisions.value.filter(d => d === k).length
const accepted = computed(() => props.startAccepted + count('a'))
const rejected = computed(() => props.startRejected + count('x'))
const deferred = computed(() => props.startDeferred + count('d'))
const decidedTotal = computed(() => accepted.value + rejected.value + deferred.value)
const position = computed(() => props.startAccepted + props.startRejected + props.startDeferred + index.value + 1)
const busy = computed(() => phase.value !== 'idle')
const isRevised = computed(() => index.value in revised.value)
const text = computed(() => (isRevised.value ? props.revision.text : current.value?.text) ?? '')
const bar = computed(() => {
  const n = 24
  const f = Math.min(n, Math.round((decidedTotal.value / Math.max(props.total, 1)) * n))
  return '█'.repeat(f) + '░'.repeat(n - f)
})
const textParts = computed(() => text.value.split(/(SHALL)/))

function later(fn: () => void, ms: number) {
  timers.push(setTimeout(fn, reduced.value ? Math.min(ms, 250) : ms))
}

function commit(kind: Kind) {
  decisions.value.push(kind)
  const word = { a: 'accepted', x: 'rejected', d: 'deferred' }[kind]
  status.value = `Requirement ${position.value} ${word}.`
  index.value++
  phase.value = 'idle'
  promptKind.value = null
  flashKind.value = null
  if (done.value) status.value += ' All demo requirements are decided.'
}

function act(key: string) {
  // The agent's answer is only a proposal: a writes it, q throws it away.
  if (phase.value === 'diff') {
    if (key === 'a') {
      revised.value = { ...revised.value, [index.value]: current.value!.text }
      phase.value = 'idle'
      status.value = 'Revision written. The new text is pending again: accept, reject or defer it.'
    }
    else if (key === 'q') {
      phase.value = 'idle'
      status.value = 'Revision discarded. The requirement is unchanged.'
    }
    return
  }
  if (busy.value || done.value) return
  if (key === 'a') {
    phase.value = 'flash'; flashKind.value = 'a'
    later(() => commit('a'), 380)
  }
  else if (key === 'x' || key === 'd') {
    phase.value = 'prompt'; promptKind.value = key; flashKind.value = key
    later(() => commit(key), 900)
  }
  else if (key === 'r') {
    if (isRevised.value || !props.revision.text) return
    if (!current.value?.revisable) {
      status.value = 'In this demo, r revises the vague requirement. Decide this one first.'
      return
    }
    phase.value = 'note'; flashKind.value = null
    status.value = `Revising with note: ${props.revision.note}.`
    later(() => {
      phase.value = 'diff'
      status.value = 'The agent proposes a new text. Press a to write it, q to discard it.'
    }, 800)
  }
}

function replay() {
  timers.forEach(clearTimeout); timers = []
  index.value = 0; decisions.value = []; revised.value = {}
  phase.value = 'idle'; promptKind.value = null; flashKind.value = null
  status.value = 'Demo restarted.'
}

function onKey(e: KeyboardEvent) {
  if (!inView.value && !focused.value) return
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  const k = e.key.toLowerCase()
  if (k === 'w' && done.value) return
  if (!['a', 'x', 'd', 'r', ...(phase.value === 'diff' ? ['q'] : [])].includes(k)) return
  e.preventDefault()
  act(k)
}

onMounted(() => {
  reduced.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  window.addEventListener('keydown', onKey)
  if (rootEl.value && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver(([en]) => { inView.value = !!en?.isIntersecting }, { threshold: 0.4 })
    observer.observe(rootEl.value)
  }
  else inView.value = true
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  observer?.disconnect()
  timers.forEach(clearTimeout)
})

const pipeline = computed(() => [
  { name: 'proposal', sym: '✓', cls: 'text-st-ok' },
  { name: 'SPECS', sym: '●', cls: 'text-st-accent' },
  { name: 'risks', sym: '○', cls: 'text-st-faint' },
  { name: 'design', sym: done.value ? '○' : '⊘', cls: done.value ? 'text-st-faint' : 'text-st-err/70' },
  { name: 'tasks', sym: '○', cls: 'text-st-faint' },
  { name: 'apply', sym: '○', cls: 'text-st-faint' },
])
const keys: { k: Kind | 'r' | 'q', label: string, tone?: 'ok' | 'err' | 'warn' | 'accent' }[] = [
  { k: 'a', label: 'accept', tone: 'ok' },
  { k: 'x', label: 'reject', tone: 'err' },
  { k: 'd', label: 'defer', tone: 'warn' },
  { k: 'r', label: 'revise', tone: 'accent' },
  { k: 'q', label: 'back' },
]
const activeKey = computed(() => (phase.value === 'note' ? 'r' : flashKind.value))
</script>

<template>
  <div ref="rootEl" class="w-full">
    <TuiPanel
      title="spec-tacular"
      :right="`${total} reqs · 1 job`"
      :tone="focused ? 'accent' : 'default'"
      deep
      :pad="false"
      class="text-[12px] leading-relaxed text-st-text outline-none sm:text-[13px]"
      tabindex="0"
      role="group"
      aria-label="Interactive spec-tacular review demo"
      @focus="focused = true"
      @blur="focused = false"
    >
      <!-- pipeline bar -->
      <div class="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-st-border px-3 pb-2 pt-4 sm:px-4" aria-hidden="true">
        <span class="text-st-accent">▸</span>
        <span v-for="p in pipeline" :key="p.name" :class="p.cls">
          <span :class="p.name === 'SPECS' ? 'font-bold' : ''">{{ p.name }}</span> {{ p.sym }}
        </span>
      </div>

      <div class="min-h-[22rem] px-3 py-3 sm:min-h-[18.5rem] sm:px-4">
        <template v-if="!done && current">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 text-st-dim">
            <span class="break-words">my-project › {{ change }} › specs › <span class="text-st-text">{{ current.capability }}</span></span>
            <span class="text-st-faint">requirement {{ position }} of {{ total }}</span>
          </div>

          <div
            :key="index"
            class="mt-3 border px-3 py-3 transition-colors duration-300"
            :class="{
              'border-st-ok bg-st-ok/10': flashKind === 'a',
              'border-st-err bg-st-err/10': flashKind === 'x',
              'border-st-warn bg-st-warn/10': flashKind === 'd',
              'border-st-border bg-st-panel': !flashKind,
            }"
          >
            <p class="font-bold text-st-strong">Requirement: {{ current.title }}</p>
            <p class="mt-2 break-words text-st-text">
              <template v-for="(part, i) in textParts" :key="i">
                <span v-if="part === 'SHALL'" class="font-bold text-st-accent2">SHALL</span>
                <template v-else>{{ part }}</template>
              </template>
            </p>

            <div v-for="s in current.scenarios" :key="s.name" class="mt-3 border-l border-st-border pl-3">
              <p class="text-st-dim">Scenario: {{ s.name }}</p>
              <p><span class="mr-2 font-bold text-st-cyan">WHEN</span>{{ s.when }}</p>
              <p><span class="mr-2 font-bold text-st-accent">THEN</span>{{ s.then }}</p>
            </div>

            <p v-if="current.flag && !isRevised" class="mt-3 break-words text-st-warn">⚠ {{ current.flag }}</p>

            <!-- inline prompts -->
            <p v-if="phase === 'prompt' && promptKind === 'x'" class="mt-3 break-words text-st-dim">
              <span class="text-st-err">why?</span> › <span class="text-st-strong">{{ WHY }}</span><span class="st-caret">▌</span>
            </p>
            <p v-if="phase === 'prompt' && promptKind === 'd'" class="mt-3 break-words text-st-dim">
              <span class="text-st-warn">what would verify it?</span> › <span class="text-st-strong">{{ VERIFY }}</span><span class="st-caret">▌</span>
            </p>
            <p v-if="phase === 'note'" class="mt-3 break-words text-st-dim">
              <span class="text-st-accent">note</span> › <span class="text-st-strong">{{ revision.note }}</span><span class="st-caret">▌</span>
            </p>
            <div v-if="phase === 'diff'" class="mt-3 break-words border-t border-st-border pt-2 text-st-dim">
              <p class="text-st-accent">proposed · note › {{ revision.note }}</p>
              <p class="text-st-err line-through decoration-st-err/40">− {{ current.text }}</p>
              <p class="text-st-ok">+ {{ revision.text }}</p>
              <p class="mt-2"><KeyCap k="a" tone="ok" /> accept — write it · <KeyCap k="q" /> discard</p>
            </div>
            <p v-else-if="isRevised" class="mt-3 break-words border-t border-st-border pt-2 text-st-accent">
              revised · note › {{ revision.note }} · pending again
            </p>
          </div>
        </template>

        <!-- summary -->
        <div v-else class="flex min-h-[17rem] flex-col items-start justify-center gap-3">
          <p class="font-bold text-st-strong">Review complete</p>
          <p>
            <span class="text-st-ok">{{ accepted }} accepted</span> ·
            <span class="text-st-err">{{ rejected }} rejected</span> ·
            <span class="text-st-warn">{{ deferred }} deferred</span>
          </p>
          <p class="text-st-dim">Only accepted requirements move on to design.</p>
          <p class="text-st-accent">design can be drafted · <KeyCap k="w" /></p>
          <button
            type="button"
            class="tui-btn mt-1"
            aria-label="Replay the review demo"
            @click="replay"
          >
            [ ↻ replay ]
          </button>
        </div>
      </div>

      <!-- progress + keys -->
      <div class="border-t border-st-border px-3 py-2 sm:px-4">
        <p class="break-all text-st-accent" aria-hidden="true">{{ bar }}</p>
        <p class="text-st-dim">
          <span class="text-st-ok">{{ accepted }}</span> accepted ·
          <span class="text-st-err">{{ rejected }}</span> rejected ·
          <span class="text-st-warn">{{ deferred }}</span> deferred
        </p>
        <div class="mt-2 flex flex-wrap gap-x-3 gap-y-2">
          <button
            v-for="key in keys"
            :key="key.k"
            type="button"
            class="inline-flex items-center gap-1.5 py-1 text-st-dim transition-opacity focus-visible:outline-2 focus-visible:outline-st-accent disabled:opacity-40"
            :disabled="key.k === 'q' ? phase !== 'diff' : done || (phase === 'diff' ? key.k !== 'a' : busy && activeKey !== key.k)"
            :aria-label="`${key.label} (${key.k})`"
            @click="act(key.k)"
          >
            <KeyCap :k="key.k" :active="activeKey === key.k" :tone="key.tone" />
            <span>{{ key.k === 'q' && phase === 'diff' ? 'discard' : key.label }}</span>
          </button>
        </div>
      </div>
    </TuiPanel>

    <p class="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-center font-mono text-xs text-st-dim">
      Try it: press <KeyCap k="a" /> <KeyCap k="x" /> <KeyCap k="d" />, and <KeyCap k="r" /> on the vague requirement
    </p>
    <p class="sr-only" aria-live="polite" role="status">{{ status }}</p>
  </div>
</template>

<style scoped>
.st-caret { animation: st-blink 1s steps(2, start) infinite; color: var(--st-accent); }
@keyframes st-blink { to { visibility: hidden; } }
@media (prefers-reduced-motion: reduce) { .st-caret { animation: none; } }
</style>
