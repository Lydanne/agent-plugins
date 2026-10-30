<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <p
    data-slot="empty-description"
    :class="cn(
      'ocp:text-muted-foreground ocp:[&>a:hover]:text-primary ocp:text-sm/relaxed ocp:[&>a]:underline ocp:[&>a]:underline-offset-4',
      props.class,
    )"
  >
    <slot />
  </p>
</template>
