<script setup lang="ts">
import type { PaginationLastProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { ButtonVariants } from "../button"
import { ChevronRightIcon } from "../../icons"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import { PaginationLast, useForwardProps } from "reka-ui"
import { buttonVariants } from "../button"

const props = withDefaults(defineProps<PaginationLastProps & {
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
}>(), {
  size: "default",
})

const delegatedProps = reactiveOmit(props, "class", "size")
const forwarded = useForwardProps(delegatedProps)
</script>

<template>
  <PaginationLast
    data-slot="pagination-last"
    :class="cn(buttonVariants({ variant: 'ghost', size }), 'ocp:gap-1 ocp:px-2.5 ocp:sm:pr-2.5', props.class)"
    v-bind="forwarded"
  >
    <slot>
      <span class="ocp:hidden ocp:sm:block">Last</span>
      <ChevronRightIcon />
    </slot>
  </PaginationLast>
</template>
