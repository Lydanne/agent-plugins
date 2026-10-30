<script setup lang="ts">
import {useOverlayTarget} from "../../host"
const overlayTarget=useOverlayTarget()
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { X } from "../../icons"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import {
  DialogClose,
  DialogContent,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import SheetOverlay from "./SheetOverlay.vue"

interface SheetContentProps extends DialogContentProps {
  class?: HTMLAttributes["class"]
  side?: "top" | "right" | "bottom" | "left"
}

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<SheetContentProps>(), {
  side: "right",
})
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "side")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DialogPortal :to="overlayTarget">
    <SheetOverlay />
    <DialogContent
      data-slot="sheet-content"
      :class="cn(
        'ocp:bg-background ocp:data-[state=open]:animate-in ocp:data-[state=closed]:animate-out ocp:fixed ocp:z-50 ocp:flex ocp:flex-col ocp:gap-4 ocp:shadow-lg ocp:transition ocp:ease-in-out ocp:data-[state=closed]:duration-300 ocp:data-[state=open]:duration-500',
        side === 'right'
          && 'ocp:data-[state=closed]:slide-out-to-right ocp:data-[state=open]:slide-in-from-right ocp:inset-y-0 ocp:right-0 ocp:h-full ocp:w-3/4 ocp:border-l ocp:sm:max-w-sm',
        side === 'left'
          && 'ocp:data-[state=closed]:slide-out-to-left ocp:data-[state=open]:slide-in-from-left ocp:inset-y-0 ocp:left-0 ocp:h-full ocp:w-3/4 ocp:border-r ocp:sm:max-w-sm',
        side === 'top'
          && 'ocp:data-[state=closed]:slide-out-to-top ocp:data-[state=open]:slide-in-from-top ocp:inset-x-0 ocp:top-0 ocp:h-auto ocp:border-b',
        side === 'bottom'
          && 'ocp:data-[state=closed]:slide-out-to-bottom ocp:data-[state=open]:slide-in-from-bottom ocp:inset-x-0 ocp:bottom-0 ocp:h-auto ocp:border-t',
        props.class)"
      v-bind="{ ...$attrs, ...forwarded }"
    >
      <slot />

      <DialogClose
        class="ocp:ring-offset-background ocp:focus:ring-ring ocp:data-[state=open]:bg-secondary ocp:absolute ocp:top-4 ocp:right-4 ocp:rounded-xs ocp:opacity-70 ocp:transition-opacity ocp:hover:opacity-100 ocp:focus:ring-2 ocp:focus:ring-offset-2 ocp:focus:outline-hidden ocp:disabled:pointer-events-none"
      >
        <X class="ocp:size-4" />
        <span class="ocp:sr-only">Close</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
