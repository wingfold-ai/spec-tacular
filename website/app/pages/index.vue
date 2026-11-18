<script setup lang="ts">
const { data: page } = await useAsyncData('page-index', () => queryCollection('pages').path('/').first())
if (!page.value)
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })

useSeoMeta({
  title: page.value.seoTitle ?? page.value.title,
  description: page.value.description,
  ogTitle: page.value.seoTitle ?? page.value.title,
  ogDescription: page.value.description,
  ogImage: '/og-image.png',
})
</script>

<template>
  <ContentRenderer v-if="page" :value="page" />
</template>
