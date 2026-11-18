<script setup lang="ts">
// A section drawn like a TUI screen: a breadcrumb rule with its number,
//   ── 03 · review ───────────────────────────── spec-tacular › review ──
// then the heading, the lead, and the section's content (slot).
const props = withDefaults(defineProps<{
  id?: string
  eyebrow?: string
  title?: string
  lead?: string
  band?: boolean
}>(), { band: false })

const { indexOf, sections } = useSections()
const n = computed(() => (props.id ? indexOf(props.id) : -1))
const num = computed(() => (n.value >= 0 ? String(n.value + 1).padStart(2, '0') : '··'))
const crumb = computed(() => (n.value >= 0 ? sections.value[n.value]!.label : props.id ?? ''))
</script>

<template>
  <section
    :id="id"
    class="scroll-mt-20"
    :class="band ? 'border-y border-st-border bg-st-bg-deep/85 [--tui-outer:var(--st-bg-deep)]' : ''"
  >
    <div class="container-page py-16 sm:py-20">
      <div class="mb-8 flex items-center gap-3 text-xs" aria-hidden="true">
        <span class="text-st-faint">──</span>
        <span class="text-st-accent">{{ num }}</span>
        <span class="text-st-faint">·</span>
        <span class="text-st-dim">{{ eyebrow?.toLowerCase() }}</span>
        <span class="h-px min-w-6 flex-1 bg-st-border" />
        <span class="hidden text-st-faint sm:inline">spec-tacular › <span class="text-st-dim">{{ crumb }}</span></span>
        <span class="hidden text-st-faint sm:inline">──</span>
      </div>
      <header v-if="title || lead" class="mb-10 max-w-3xl">
        <h2 v-if="title" class="text-balance text-2xl font-extrabold leading-snug tracking-tight text-st-strong sm:text-[2rem]">
          <span class="text-st-faint">#</span> {{ title }}
        </h2>
        <p v-if="lead" class="mt-4 max-w-[70ch] text-pretty text-st-dim">
          {{ lead }}
        </p>
      </header>
      <div class="space-y-10">
        <slot />
      </div>
    </div>
  </section>
</template>
