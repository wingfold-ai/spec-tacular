<script setup lang="ts">
// The TUI's bottom status bar, fixed to the viewport:
//   ⣾ reading · review          sections 3/9 · 2✓        j/k move  ? help
// It also owns the page's keyboard navigation and the `?` help overlay.
const { sections, current, go } = useSections()
const colorMode = useColorMode()

const FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']
const frame = ref(0)
const help = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

const label = computed(() => (current.value < 0 ? 'start' : sections.value[current.value]?.label ?? ''))
const passed = computed(() => Math.max(0, current.value))

const KEYS: [string, string][] = [
  ['j', 'next section'],
  ['k', 'previous section'],
  ['g', 'top'],
  ['G', 'last section'],
  ['1–9', 'jump to section'],
  ['t', 'toggle light / dark'],
  ['a x d r', 'review the demo requirement (hero)'],
  ['?', 'this help'],
  ['q', 'close help'],
]

function typing(t: EventTarget | null) {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return
  const k = e.key
  if (help.value && (k === 'q' || k === 'Escape' || k === '?' || k === '/')) { help.value = false; e.preventDefault(); return }
  if (k === '?' || k === '/') { help.value = true; e.preventDefault(); return }
  if (help.value) return
  if (k === 'j') go(current.value + 1)
  else if (k === 'k') go(current.value - 1)
  else if (k === 'g') go(-1)
  else if (k === 'G') go(sections.value.length - 1)
  else if (/^[1-9]$/.test(k)) go(Number(k) - 1)
  else if (k === 't') colorMode.preference = colorMode.value === 'light' ? 'dark' : 'light'
  else return
  e.preventDefault()
}

onMounted(() => {
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    timer = setInterval(() => (frame.value = (frame.value + 1) % FRAMES.length), 110)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="fixed inset-x-0 bottom-0 z-40 border-t border-st-border bg-st-bg-deep text-xs">
    <div class="container-page flex h-9 items-center gap-4">
      <span class="flex min-w-0 items-center gap-2">
        <span class="w-3 text-st-accent" aria-hidden="true">{{ FRAMES[frame] }}</span>
        <span class="text-st-dim">reading</span>
        <span class="text-st-faint">·</span>
        <span class="truncate text-st-strong">{{ label }}</span>
      </span>
      <span class="hidden text-st-dim sm:inline">
        sections <span class="text-st-text">{{ Math.max(0, current + 1) }}/{{ sections.length }}</span>
        <span class="text-st-faint"> · </span><span class="text-st-ok">{{ passed }}✓</span>
      </span>
      <span class="ml-auto hidden items-center gap-3 text-st-dim md:flex">
        <span><KeyCap k="j" /><KeyCap k="k" /> move</span>
        <span><KeyCap k="t" /> theme</span>
      </span>
      <button type="button" class="ml-auto text-st-dim hover:text-st-strong md:ml-0" aria-haspopup="dialog" @click="help = true">
        <KeyCap k="?" /> help
      </button>
    </div>

    <div
      v-if="help"
      class="fixed inset-0 z-50 flex items-center justify-center bg-st-bg/90 p-4"
      role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
      @click.self="help = false"
    >
      <TuiPanel title="keys" right="q close" tone="accent" class="w-full max-w-md text-sm">
        <ul class="space-y-1.5 py-1">
          <li v-for="[k, what] in KEYS" :key="k" class="flex gap-3">
            <span class="w-20 shrink-0 text-st-accent">{{ k }}</span>
            <span class="text-st-dim">{{ what }}</span>
          </li>
        </ul>
        <p class="mt-4 border-t border-st-border pt-3 text-xs text-st-faint">
          Same idea as the real TUI: everything has a key, <span class="text-st-accent">?</span> lists them.
        </p>
      </TuiPanel>
    </div>
  </div>
</template>
