<script setup lang="ts">
/**
 * A real screen of the spec-tacular TUI, captured headless and rendered as SVG
 * (website/scripts/tui-shots/). In Markdown:
 *
 *   ::tui-shot{src="/docs/shots/review.svg" alt="…" caption="…"}
 *   ::
 *
 * The image stays dark in both site themes: it is a terminal. Click opens the
 * SVG full size in a new tab.
 */
defineProps<{ src: string, alt: string, caption?: string, title?: string }>()
</script>

<template>
  <figure class="not-prose my-8">
    <TuiPanel :title="title ?? 'spec-tacular'" right="real screen" deep :pad="false">
      <a :href="src" target="_blank" rel="noopener" class="block overflow-x-auto p-2 pt-3 [scrollbar-width:thin]" :aria-label="`${alt} (open full size)`">
        <img :src="src" :alt="alt" loading="lazy" decoding="async" class="block h-auto w-full min-w-[34rem]">
      </a>
    </TuiPanel>
    <figcaption v-if="caption" class="mt-2 text-xs text-st-faint">
      <span class="text-st-dim">▸</span> {{ caption }}
    </figcaption>
  </figure>
</template>
