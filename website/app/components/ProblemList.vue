<script setup lang="ts">
withDefaults(defineProps<{
  items: { title: string, text: string }[]
}>(), { items: () => [] })
</script>

<template>
  <!-- Drawn like the agent's stop report: each problem is an open issue. -->
  <ol class="grid list-none gap-x-4 gap-y-8 p-0 pt-2 md:grid-cols-3" aria-label="Problems">
    <li v-for="(item, i) in items" :key="item.title" class="flex">
      <TuiPanel :title="`issue #${i + 1}`" right="open" tone="err" deep class="flex w-full flex-col">
        <h3 class="flex gap-2 text-base font-bold leading-snug text-st-strong">
          <span class="text-st-err" aria-hidden="true">✗</span>
          <span>{{ item.title }}</span>
        </h3>
        <p class="mt-3 pl-[calc(1ch+0.5rem)] text-sm leading-relaxed text-st-dim">
          {{ item.text }}
        </p>
      </TuiPanel>
    </li>
  </ol>
</template>
