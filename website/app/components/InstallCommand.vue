<script setup lang="ts">
// The install one-liner with a copy button. Defaults to site.yml's command.
const props = defineProps<{ command?: string, note?: string, compact?: boolean }>()
const { data: site } = await useSite()
const cmd = computed(() => props.command ?? site.value?.install ?? '')
const shownNote = computed(() => props.note ?? site.value?.installNote)
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(cmd.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  }
  catch { /* clipboard blocked: the text is still selectable */ }
}
</script>

<template>
  <div class="w-full">
    <div class="term-frame flex items-start gap-3 px-3 text-left text-sm sm:px-4" :class="compact ? 'py-2' : 'py-3'">
      <span class="select-none text-st-accent2" aria-hidden="true">$</span>
      <code class="min-w-0 flex-1 break-all text-st-strong">{{ cmd }}</code>
      <button
        type="button"
        class="shrink-0 select-none border px-1.5 text-xs leading-5 transition-colors"
        :class="copied ? 'border-st-ok text-st-ok' : 'border-st-border text-st-dim hover:border-st-accent hover:bg-st-highlight hover:text-st-accent'"
        :aria-label="copied ? 'Copied' : 'Copy command'"
        @click="copy"
      >
        <span aria-hidden="true">{{ copied ? '[ ✓ copied ]' : '[ copy ]' }}</span>
      </button>
    </div>
    <p v-if="shownNote" class="mt-2 font-mono text-xs text-st-faint">
      <span aria-hidden="true"># </span>{{ shownNote }}
    </p>
  </div>
</template>
