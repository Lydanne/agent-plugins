<script setup lang="ts">
import {useOverlayTarget} from "../../host"
const overlayTarget=useOverlayTarget()
import type { TooltipContentEmits, TooltipContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import { TooltipArrow, TooltipContent, TooltipPortal, useForwardPropsEmits } from "reka-ui"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<TooltipContentProps & { class?: HTMLAttributes["class"] }>(), {
  sideOffset: 4,
})

const emits = defineEmits<TooltipContentEmits>()

const delegatedProps = reactiveOmit(props, "class")
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <TooltipPortal :to="overlayTarget">
    <TooltipContent
      data-slot="tooltip-content"
      v-bind="{ ...forwarded, ...$attrs }"
      :class="cn('ocp:bg-foreground ocp:text-background ocp:animate-in ocp:fade-in-0 ocp:zoom-in-95 ocp:data-[state=closed]:animate-out ocp:data-[state=closed]:fade-out-0 ocp:data-[state=closed]:zoom-out-95 ocp:data-[side=bottom]:slide-in-from-top-2 ocp:data-[side=left]:slide-in-from-right-2 ocp:data-[side=right]:slide-in-from-left-2 ocp:data-[side=top]:slide-in-from-bottom-2 ocp:z-50 ocp:w-fit ocp:rounded-md ocp:px-3 ocp:py-1.5 ocp:text-xs ocp:text-balance', props.class)"
    >
      <slot />

      <TooltipArrow class="ocp:bg-foreground ocp:fill-foreground ocp:z-50 ocp:size-2.5 ocp:translate-y-[calc(-50%_-_2px)] ocp:rotate-45 ocp:rounded-xs" />
    </TooltipContent>
  </TooltipPortal>
</template>
