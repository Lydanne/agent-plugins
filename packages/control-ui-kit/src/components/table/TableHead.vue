<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <th
    data-slot="table-head"
    :class="cn('ocp:text-foreground ocp:h-10 ocp:px-2 ocp:text-left ocp:align-middle ocp:font-medium ocp:whitespace-nowrap ocp:[&:has([role=checkbox])]:pr-0 ocp:*:[[role=checkbox]]:translate-y-0.5', props.class)"
  >
    <slot />
  </th>
</template>
