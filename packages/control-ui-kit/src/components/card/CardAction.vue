<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="card-action"
    :class="cn('ocp:col-start-2 ocp:row-span-2 ocp:row-start-1 ocp:self-start ocp:justify-self-end', props.class)"
  >
    <slot />
  </div>
</template>
