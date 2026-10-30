<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <tr
    data-slot="table-row"
    :class="cn('ocp:hover:bg-muted/50 ocp:data-[state=selected]:bg-muted ocp:border-b ocp:transition-colors', props.class)"
  >
    <slot />
  </tr>
</template>
