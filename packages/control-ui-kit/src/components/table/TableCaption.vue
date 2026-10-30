<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <caption
    data-slot="table-caption"
    :class="cn('ocp:text-muted-foreground ocp:mt-4 ocp:text-sm', props.class)"
  >
    <slot />
  </caption>
</template>
