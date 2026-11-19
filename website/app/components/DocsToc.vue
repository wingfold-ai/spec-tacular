<script setup lang="ts">
// "On this page": the current page's h2/h3 headings, the visible one marked ●.
interface Link { id: string, text: string, depth: number, children?: Link[] }
const links = useState<Link[]>('docs-toc', () => [])
const flat = computed(() => links.value.flatMap(l => [l, ...(l.children ?? [])]))
const active = ref('')
let observer: IntersectionObserver | null = null

function observe() {
  observer?.disconnect()
  if (!import.meta.client) return
  observer = new IntersectionObserver((entries) => {
    const seen = entries.filter(e => e.isIntersecting).map(e => e.target.id)
    if (seen.length) active.value = seen[0]!
  }, { rootMargin: '-15% 0px -70% 0px' })
  flat.value.forEach(l => { const el = document.getElementById(l.id); if (el) observer!.observe(el) })
}
onMounted(() => nextTick(observe))
watch(flat, () => nextTick(observe))
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <nav v-if="flat.length" aria-label="On this page" class="text-[0.78rem] leading-6">
    <p class="mb-2 text-st-faint">─ on this page ─</p>
    <ul>
      <li v-for="l in flat" :key="l.id">
        <a
          :href="`#${l.id}`"
          class="block truncate transition-colors"
          :class="[l.depth > 2 ? 'pl-4' : '', active === l.id ? 'text-st-accent' : 'text-st-dim hover:text-st-strong']"
        ><span class="mr-1.5" :class="active === l.id ? 'text-st-accent' : 'text-st-faint'">{{ active === l.id ? '●' : '○' }}</span>{{ l.text }}</a>
      </li>
    </ul>
  </nav>
</template>
