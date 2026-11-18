<script setup lang="ts">
withDefaults(defineProps<{
  steps: { title: string, command?: string, site?: boolean, text?: string }[]
}>(), { steps: () => [] })
</script>

<template>
  <!-- Written like a shell script: a comment above each command. -->
  <TuiPanel title="install.sh" :right="`${steps.length} steps`" deep class="max-w-3xl">
    <ol class="m-0 list-none space-y-7 p-0 pt-1">
      <li v-for="(s, i) in steps" :key="s.title">
        <h3 class="font-mono text-sm font-bold text-st-strong">
          <span class="font-normal text-st-faint" aria-hidden="true"># {{ i + 1 }} · </span>{{ s.title }}
        </h3>
        <p v-if="s.text" class="mt-1 pl-[2ch] font-mono text-xs leading-relaxed text-st-dim sm:text-sm">
          <span class="text-st-faint" aria-hidden="true"># </span>{{ s.text }}
        </p>
        <div v-if="s.site || s.command" class="mt-2.5">
          <InstallCommand v-if="s.site" />
          <InstallCommand v-else :command="s.command" note="" compact />
        </div>
      </li>
    </ol>
  </TuiPanel>
</template>
