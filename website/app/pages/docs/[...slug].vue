<script setup lang="ts">
// One documentation page from content/docs/**. The layout draws the sidebar,
// the outline and the status bar; this page draws the article and the pager.
definePageMeta({ layout: 'docs' })

const route = useRoute()
const path = computed(() => route.path.replace(/\/$/, '') || '/docs')

const { data: page } = await useAsyncData(`docs-${path.value}`, () =>
  queryCollection('docs').path(path.value).first(),
)
if (!page.value)
  throw createError({ statusCode: 404, statusMessage: `No docs page at ${path.value}`, fatal: true })

const { data: surround } = await useAsyncData(`docs-surround-${path.value}`, () =>
  queryCollectionItemSurroundings('docs', path.value, { fields: ['title', 'description'] }),
)

useSeoMeta({
  title: `${page.value.title} · docs`,
  description: page.value.description,
  ogTitle: `${page.value.title} · spec-tacular docs`,
  ogDescription: page.value.description,
})

// The layout's outline reads the headings of the current page.
useState('docs-toc').value = page.value.body?.toc?.links ?? []
</script>

<template>
  <article v-if="page" class="min-w-0">
    <header class="mb-10 border-b border-st-border pb-8">
      <DocsBreadcrumb :path="path" />
      <h1 class="mt-4 text-balance text-[1.9rem] font-extrabold leading-tight tracking-tight text-st-strong sm:text-4xl">
        <span class="text-st-faint">#</span> {{ page.title }}
      </h1>
      <p v-if="page.description" class="mt-4 max-w-[70ch] text-pretty text-st-dim">
        {{ page.description }}
      </p>
    </header>

    <ContentRenderer :value="page" class="docs-prose" />

    <DocsPager :prev="surround?.[0]" :next="surround?.[1]" />
  </article>
</template>
