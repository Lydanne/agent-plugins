<script setup lang="ts">
import type { SelectScrollDownButtonProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { ChevronDown } from "../../icons"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import { SelectScrollDownButton, useForwardProps } from "reka-ui"

const props = defineProps<SelectScrollDownButtonProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <SelectScrollDownButton
    data-slot="select-scroll-down-button"
    v-bind="forwardedProps"
    :class="cn('ocp:flex ocp:cursor-default ocp:items-center ocp:justify-center ocp:py-1', props.class)"
  >
    <slot>
      <ChevronDown class="ocp:size-4" />
    </slot>
  </SelectScrollDownButton>
</template>
