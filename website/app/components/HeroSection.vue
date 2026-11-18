<script setup lang="ts">
// The TUI home screen, as a hero: the block logo, one line of what it is, the
// claim, the install command, and the review screen itself underneath (slot).
interface Link { label: string, to: string }
defineProps<{
  eyebrow?: string
  title: string
  titleAccent?: string
  lead?: string
  worksWith?: string
  primary?: Link
  secondary?: Link
}>()
</script>

<template>
  <section class="overflow-hidden border-b border-st-border">
    <div class="container-page pb-14 pt-12 sm:pb-20 sm:pt-16">
      <AsciiLogo class="mb-8 sm:mb-10" />

      <div class="mx-auto max-w-3xl text-center">
        <p v-if="eyebrow" class="mb-6 text-xs text-st-faint">
          <span class="text-st-accent">$</span> spec-tacular <span class="text-st-dim">--help</span>
          <span class="text-st-faint"> │ </span>{{ eyebrow.toLowerCase() }}
        </p>
        <h1 class="text-balance text-[1.7rem] font-extrabold leading-tight tracking-tight text-st-strong sm:text-4xl lg:text-[2.75rem]">
          <span class="block">{{ title }}</span>
          <span v-if="titleAccent" class="block text-st-accent">{{ titleAccent }}<span class="tui-cursor ml-2 align-baseline" aria-hidden="true" /></span>
        </h1>
        <p v-if="lead" class="mx-auto mt-6 max-w-[64ch] text-pretty text-[0.95rem] text-st-dim">
          {{ lead }}
        </p>

        <div class="mx-auto mt-8 max-w-2xl">
          <InstallCommand />
        </div>

        <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
          <a v-if="primary" :href="primary.to" class="tui-btn tui-btn-primary">[ {{ primary.label }} ↓ ]</a>
          <a v-if="secondary" :href="secondary.to" class="tui-btn">[ {{ secondary.label }} ]</a>
        </div>
        <p v-if="worksWith" class="mt-5 text-xs text-st-faint">
          {{ worksWith }}
        </p>
      </div>

      <div v-if="$slots.default" class="mx-auto mt-14 max-w-4xl">
        <slot />
      </div>
    </div>
  </section>
</template>
