<script setup lang="ts">
// The privacy statement, from content/privacy.md, set like a docs page.
const { data: page } = await useAsyncData('page-privacy', () => queryCollection('pages').path('/privacy').first())
if (!page.value)
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })

useSeoMeta({
  title: page.value.title,
  description: page.value.description,
})
</script>

<template>
  <main class="container-page py-16 sm:py-20">
    <article v-if="page" class="mx-auto max-w-3xl">
      <header class="mb-10 border-b border-st-border pb-8">
        <h1 class="text-balance text-[1.9rem] font-extrabold leading-tight tracking-tight text-st-strong sm:text-4xl">
          <span class="text-st-faint">#</span> {{ page.title }}
        </h1>
        <p v-if="page.description" class="mt-4 max-w-[70ch] text-pretty text-st-dim">
          {{ page.description }}
        </p>
      </header>
      <ContentRenderer :value="page" class="docs-prose" />
    </article>
  </main>
</template>
