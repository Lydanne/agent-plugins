<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="card"
    :class="
      cn(
        'ocp:bg-card ocp:text-card-foreground ocp:flex ocp:flex-col ocp:gap-6 ocp:rounded-xl ocp:border ocp:py-6 ocp:shadow-sm',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
