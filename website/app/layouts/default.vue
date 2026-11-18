<script setup lang="ts">
await useSite()
useSectionSpy()
</script>

<template>
  <div id="top" class="relative isolate min-h-dvh text-st-text">
    <BackgroundField />
    <SiteHeader />
    <main class="relative z-10">
      <slot />
    </main>
    <SiteFooter class="relative z-10" />
    <StatusBar />
  </div>
</template>
