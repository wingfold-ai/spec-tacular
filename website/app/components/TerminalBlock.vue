<script setup lang="ts">
const props = withDefaults(defineProps<{ title?: string, lines?: string }>(), { title: 'terminal', lines: '' })

type Seg = { t: string, cls?: string }
interface Line { kind: 'cmd' | 'warn' | 'plain' | 'blank', segs: Seg[], len: number }

const TOKEN = /(\[(?:risk|req):[^\]]*\]|\b(?:open|high|unmitigated|low)\b)/g
const IS_TOKEN = /^(?:\[(?:risk|req):[^\]]*\]|open|high|unmitigated|low)$/
function tokenClass(s: string) {
  if (s.startsWith('[')) return 'text-st-cyan'
  return s === 'open' || s === 'high' ? 'text-st-err' : 'text-st-warn'
}
function segs(s: string, base?: string): Seg[] {
  return s.split(TOKEN).filter(Boolean).map(t => (IS_TOKEN.test(t)
    ? { t, cls: tokenClass(t) }
    : { t, cls: base }))
}

const parsed = computed<Line[]>(() => {
  const raw = props.lines.replace(/\n+$/, '').split('\n')
  return raw.map((l) => {
    if (!l.trim()) return { kind: 'blank', segs: [], len: 0 }
    if (l.startsWith('$ ')) return { kind: 'cmd', segs: [{ t: l.slice(2), cls: 'text-st-strong' }], len: l.length }
    if (l.startsWith('! ')) return { kind: 'warn', segs: segs(l, 'text-st-warn'), len: l.length }
    return { kind: 'plain', segs: segs(l), len: l.length }
  })
})
const totalChars = computed(() => parsed.value.reduce((n, l) => n + l.len + 1, 0))

// Typewriter: full content is in SSR HTML; on mount (if motion allowed) we hide
// characters past `shown` via a clip count, then reveal once scrolled into view.
const shown = ref(Infinity)
const el = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null
let raf = 0

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return
  const r = el.value?.getBoundingClientRect()
  if (r && r.top < window.innerHeight * 0.85 && r.bottom > 0) return // already visible: no reveal
  shown.value = 0
  io = new IntersectionObserver(([en]) => {
    if (!en?.isIntersecting) return
    io?.disconnect()
    const start = performance.now()
    const dur = Math.min(1800, totalChars.value * 12)
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / dur)
      shown.value = Math.ceil(p * totalChars.value)
      if (p < 1) raf = requestAnimationFrame(step)
      else shown.value = Infinity
    }
    raf = requestAnimationFrame(step)
  }, { threshold: 0.3 })
  if (el.value) io.observe(el.value)
})
onBeforeUnmount(() => { io?.disconnect(); cancelAnimationFrame(raf) })

// Visibility per line: chars before this line are used so lines appear progressively.
const offsets = computed(() => {
  let o = 0
  return parsed.value.map((l) => { const s = o; o += l.len + 1; return s })
})
const visible = (i: number) => shown.value === Infinity || offsets.value[i]! < shown.value
</script>

<template>
  <div ref="el" class="my-8">
    <TuiPanel :title="title" right="output" deep :pad="false">
      <pre class="m-0 overflow-x-auto px-3 pb-3 pt-5 text-[11px] leading-relaxed text-st-text sm:px-4 sm:text-[13px]"><code><template v-for="(l, i) in parsed" :key="i"><span :class="visible(i) ? '' : 'invisible'"><template v-if="l.kind === 'cmd'"><span class="text-st-accent2">$</span> </template><span v-for="(s, j) in l.segs" :key="j" :class="s.cls">{{ s.t }}</span></span>{{ '\n' }}</template></code></pre>
    </TuiPanel>
  </div>
</template>
