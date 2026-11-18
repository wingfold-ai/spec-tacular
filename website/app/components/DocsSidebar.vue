<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content'
// The page tree, drawn like a file tree in the TUI:
//   docs/
//   ├── getting started/
//   │   ├── installation        ← current page in accent with ▸
const props = defineProps<{ items: ContentNavigationItem[] }>()
const route = useRoute()
const current = computed(() => route.path.replace(/\/$/, ''))

// The collection root is one item (/docs) whose children are the sections.
const root = computed(() => (props.items.length === 1 && props.items[0]!.children ? props.items[0]! : null))
const sections = computed(() => (root.value ? root.value.children! : props.items))
</script>

<template>
  <nav aria-label="Documentation" class="text-[0.82rem] leading-6">
    <NuxtLink
      to="/docs"
      class="tui-row block pl-5 font-bold"
      :class="current === '/docs' ? 'text-st-accent' : 'text-st-strong hover:text-st-accent'"
    >docs/</NuxtLink>
    <ul>
      <li v-for="(sec, si) in sections" :key="sec.path" class="mt-1">
        <template v-if="sec.children?.length">
          <div class="flex pl-5 text-st-dim">
            <span class="w-6 shrink-0 text-st-faint" aria-hidden="true">{{ si === sections.length - 1 ? '└──' : '├──' }}</span>
            <span class="pl-1">{{ sec.title.toLowerCase() }}/</span>
          </div>
          <ul>
            <li v-for="(pg, pi) in sec.children.filter(c => c.path !== '/docs')" :key="pg.path">
              <NuxtLink
                :to="pg.path"
                class="tui-row flex pl-5"
                :class="current === pg.path ? 'bg-st-highlight text-st-accent before:!opacity-100' : 'text-st-text hover:text-st-strong'"
                :aria-current="current === pg.path ? 'page' : undefined"
              >
                <span class="w-6 shrink-0 text-st-faint" aria-hidden="true">{{ si === sections.length - 1 ? ' ' : '│' }}</span>
                <span class="w-6 shrink-0 text-st-faint" aria-hidden="true">{{ pi === sec.children.filter(c => c.path !== '/docs').length - 1 ? '└─' : '├─' }}</span>
                <span class="min-w-0 pl-1">{{ pg.navTitle ?? pg.title }}</span>
              </NuxtLink>
            </li>
          </ul>
        </template>
        <NuxtLink
          v-else-if="sec.path !== '/docs'"
          :to="sec.path"
          class="tui-row flex pl-5"
          :class="current === sec.path ? 'bg-st-highlight text-st-accent before:!opacity-100' : 'text-st-text hover:text-st-strong'"
        >
          <span class="w-6 shrink-0 text-st-faint" aria-hidden="true">{{ si === sections.length - 1 ? '└──' : '├──' }}</span>
          <span class="pl-1">{{ sec.navTitle ?? sec.title }}</span>
        </NuxtLink>
      </li>
    </ul>
  </nav>
</template>
