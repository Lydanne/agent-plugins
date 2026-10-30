<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <p
    data-slot="card-description"
    :class="cn('ocp:text-muted-foreground ocp:text-sm', props.class)"
  >
    <slot />
  </p>
</template>
