<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content'
// The TUI status bar for the docs: where you are, how far through the docs,
// and the page keys. n / p move between pages, g goes to the docs start,
// h goes home, t toggles the theme.
const props = defineProps<{ items: ContentNavigationItem[] }>()
const route = useRoute()
const router = useRouter()
const colorMode = useColorMode()
const pages = computed(() => flattenDocs(props.items))
const idx = computed(() => pages.value.findIndex(p => p.path === route.path.replace(/\/$/, '')))
const title = computed(() => pages.value[idx.value]?.title ?? 'docs')

function typing(t: EventTarget | null) {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}
function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return
  const go = (i: number) => { const p = pages.value[i]; if (p) router.push(p.path) }
  if (e.key === 'n') go(idx.value + 1)
  else if (e.key === 'p') go(idx.value - 1)
  else if (e.key === 'g') router.push('/docs')
  else if (e.key === 'h') router.push('/')
  else if (e.key === 't') colorMode.preference = colorMode.value === 'light' ? 'dark' : 'light'
  else return
  e.preventDefault()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="fixed inset-x-0 bottom-0 z-40 border-t border-st-border bg-st-bg-deep text-xs">
    <div class="container-page !max-w-[96rem] flex h-9 items-center gap-4">
      <span class="flex min-w-0 items-center gap-2">
        <span class="text-st-accent" aria-hidden="true">▤</span>
        <span class="text-st-dim">docs</span>
        <span class="text-st-faint">›</span>
        <span class="truncate text-st-strong">{{ title }}</span>
      </span>
      <span v-if="idx >= 0" class="hidden text-st-dim sm:inline">page <span class="text-st-text">{{ idx + 1 }}/{{ pages.length }}</span></span>
      <span class="ml-auto flex items-center gap-3 text-st-dim">
        <span><KeyCap k="p" /><KeyCap k="n" /> page</span>
        <span class="hidden md:inline"><KeyCap k="h" /> home</span>
        <span class="hidden md:inline"><KeyCap k="t" /> theme</span>
      </span>
    </div>
  </div>
</template>
