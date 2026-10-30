<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <span
    data-slot="dropdown-menu-shortcut"
    :class="cn('ocp:text-muted-foreground ocp:ml-auto ocp:text-xs ocp:tracking-widest', props.class)"
  >
    <slot />
  </span>
</template>
