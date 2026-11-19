<script setup lang="ts">
// Documentation layout: the same top bar as the landing page, a page tree on
// the left (a TUI file tree), the article, an outline on the right, and a
// docs status bar with page keys. No character field behind the text here:
// docs are for reading.
await useSite()
const { data: nav } = await useAsyncData('docs-nav', () => queryCollectionNavigation('docs'))
const open = ref(false)
const route = useRoute()
watch(() => route.path, () => (open.value = false))
</script>

<template>
  <div id="top" class="min-h-dvh bg-st-bg text-st-text">
    <SiteHeader />
    <div class="mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[16.5rem_minmax(0,1fr)_13rem]">
      <aside class="lg:sticky lg:top-[2.75rem] lg:h-[calc(100dvh-2.75rem-2.25rem)] lg:overflow-y-auto lg:py-10 [scrollbar-width:thin]">
        <button
          type="button"
          class="tui-btn mt-6 w-full justify-between lg:hidden"
          :aria-expanded="open"
          aria-controls="docs-nav"
          @click="open = !open"
        >
          <span>{{ open ? '▾' : '▸' }} pages</span>
          <span class="text-st-faint">docs</span>
        </button>
        <DocsSidebar id="docs-nav" :items="nav ?? []" class="mt-3 lg:mt-0" :class="open ? 'block' : 'hidden lg:block'" />
      </aside>

      <main class="min-w-0 py-10 lg:py-12">
        <slot />
      </main>

      <aside class="hidden xl:block">
        <DocsToc class="sticky top-[2.75rem] max-h-[calc(100dvh-2.75rem-2.25rem)] overflow-y-auto py-12" />
      </aside>
    </div>
    <SiteFooter />
    <DocsStatusBar :items="nav ?? []" />
  </div>
</template>
