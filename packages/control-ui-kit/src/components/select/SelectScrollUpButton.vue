<script setup lang="ts">
import type { SelectScrollUpButtonProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { ChevronUp } from "../../icons"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import { SelectScrollUpButton, useForwardProps } from "reka-ui"

const props = defineProps<SelectScrollUpButtonProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <SelectScrollUpButton
    data-slot="select-scroll-up-button"
    v-bind="forwardedProps"
    :class="cn('ocp:flex ocp:cursor-default ocp:items-center ocp:justify-center ocp:py-1', props.class)"
  >
    <slot>
      <ChevronUp class="ocp:size-4" />
    </slot>
  </SelectScrollUpButton>
</template>
