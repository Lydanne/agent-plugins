<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="alert-dialog-footer"
    :class="
      cn(
        'ocp:flex ocp:flex-col-reverse ocp:gap-2 ocp:sm:flex-row ocp:sm:justify-end',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
