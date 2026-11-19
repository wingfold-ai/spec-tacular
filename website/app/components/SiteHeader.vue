<script setup lang="ts">
// One bar, like the TUI's frame header: name and version on the left, the
// pipeline of the page's sections in the middle, theme and GitHub on the right.
// Sections before the current one are ✓, the current one ●, the rest ○,
// so scrolling back up clears the checkmarks again.
// Below md the pipeline moves to its own row.
const { data: site } = await useSite()
const { sections, current } = useSections()
const colorMode = useColorMode()
const isDark = computed(() => colorMode.value !== 'light')
const route = useRoute()
const isHome = computed(() => route.path === '/')
const inDocs = computed(() => route.path.startsWith('/docs'))

function marker(i: number) {
  if (i === current.value) return '●'
  if (i < current.value) return '✓'
  return '○'
}
</script>

<template>
  <header class="sticky top-0 z-40 border-b border-st-border bg-st-bg/85 backdrop-blur-sm">
    <div class="container-page flex h-11 items-center gap-6 text-sm" :class="inDocs ? '!max-w-[96rem]' : ''">
      <NuxtLink :to="isHome ? '#top' : '/'" class="flex shrink-0 items-center gap-2" :aria-label="isHome ? 'spec-tacular, back to top' : 'spec-tacular home'">
        <img src="/favicon.svg" alt="" class="size-5">
        <span class="font-bold text-st-strong">spec-tacular</span>
        <span v-if="site" class="border border-st-border px-1.5 text-[0.7rem] leading-5 text-st-dim">{{ site.version }}</span>
      </NuxtLink>

      <nav v-if="!isHome" class="hidden min-w-0 flex-1 items-center gap-4 text-[0.8rem] md:flex" aria-label="Site">
        <NuxtLink to="/" class="text-st-faint hover:text-st-strong">home</NuxtLink>
        <NuxtLink to="/docs" :class="inDocs ? 'font-bold text-st-accent' : 'text-st-faint hover:text-st-strong'">docs<span v-if="inDocs" class="ml-1">●</span></NuxtLink>
      </nav>
      <nav v-else class="hidden min-w-0 flex-1 md:block" aria-label="Sections">
        <ol class="flex items-center gap-x-3.5 overflow-x-auto whitespace-nowrap text-[0.8rem] [scrollbar-width:none] lg:gap-x-4">
          <li v-for="(s, i) in sections" :key="s.id">
            <a
              :href="`#${s.id}`"
              class="transition-colors"
              :class="i === current
                ? 'font-bold text-st-accent'
                : i < current ? 'text-st-text hover:text-st-strong' : 'text-st-faint hover:text-st-dim'"
              :aria-current="i === current ? 'true' : undefined"
            >{{ s.label }}<span class="ml-1" :class="i === current ? 'text-st-accent' : i < current ? 'text-st-ok' : 'text-st-faint'">{{ marker(i) }}</span></a>
          </li>
        </ol>
      </nav>

      <div class="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
        <NuxtLink to="/docs" class="tui-btn h-8 !px-2.5 !py-0 text-xs" :class="inDocs ? '!border-st-accent !text-st-accent' : ''">docs</NuxtLink>
        <ClientOnly>
          <button
            type="button"
            class="tui-btn size-8 justify-center !border-transparent !bg-transparent !p-0 text-st-dim hover:!border-st-border hover:text-st-strong"
            :aria-label="isDark ? 'Switch to light theme' : 'Switch to dark theme'"
            :title="isDark ? 'Light theme (t)' : 'Dark theme (t)'"
            @click="colorMode.preference = isDark ? 'light' : 'dark'"
          >
            <UIcon :name="isDark ? 'i-lucide-sun' : 'i-lucide-moon'" class="size-[18px]" />
          </button>
          <template #fallback>
            <span class="inline-block size-8" aria-hidden="true" />
          </template>
        </ClientOnly>
        <a v-if="site" :href="site.repo" target="_blank" rel="noopener" class="tui-btn h-8 !px-2.5 !py-0 text-xs" aria-label="spec-tacular on GitHub">
          <!-- GitHub mark (Simple Icons, CC0) -->
          <svg viewBox="0 0 24 24" class="size-[18px]" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
          <span class="hidden sm:inline">github</span>
        </a>
      </div>
    </div>

    <nav v-if="isHome" class="border-t border-st-border/60 md:hidden" aria-label="Sections">
      <ol class="container-page flex h-8 items-center gap-x-3.5 overflow-x-auto whitespace-nowrap text-[0.78rem] [scrollbar-width:none]">
        <li v-for="(s, i) in sections" :key="s.id">
          <a
            :href="`#${s.id}`"
            :class="i === current ? 'font-bold text-st-accent' : i < current ? 'text-st-text' : 'text-st-faint'"
          >{{ s.label }}<span class="ml-1" :class="i === current ? 'text-st-accent' : i < current ? 'text-st-ok' : 'text-st-faint'">{{ marker(i) }}</span></a>
        </li>
      </ol>
    </nav>
  </header>
</template>
