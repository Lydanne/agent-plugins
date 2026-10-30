<script setup lang="ts">
import {useOverlayTarget} from "../../host"
const overlayTarget=useOverlayTarget()
import type { AlertDialogContentEmits, AlertDialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import {
  AlertDialogContent,
  AlertDialogOverlay,
  AlertDialogPortal,
  useForwardPropsEmits,
} from "reka-ui"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<AlertDialogContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<AlertDialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <AlertDialogPortal :to="overlayTarget">
    <AlertDialogOverlay
      data-slot="alert-dialog-overlay"
      class="ocp:data-[state=open]:animate-in ocp:data-[state=closed]:animate-out ocp:data-[state=closed]:fade-out-0 ocp:data-[state=open]:fade-in-0 ocp:fixed ocp:inset-0 ocp:z-50 ocp:bg-black/80"
    />
    <AlertDialogContent
      data-slot="alert-dialog-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="
        cn(
          'ocp:bg-background ocp:data-[state=open]:animate-in ocp:data-[state=closed]:animate-out ocp:data-[state=closed]:fade-out-0 ocp:data-[state=open]:fade-in-0 ocp:data-[state=closed]:zoom-out-95 ocp:data-[state=open]:zoom-in-95 ocp:fixed ocp:top-[50%] ocp:left-[50%] ocp:z-50 ocp:grid ocp:w-full ocp:max-w-[calc(100%-2rem)] ocp:translate-x-[-50%] ocp:translate-y-[-50%] ocp:gap-4 ocp:rounded-lg ocp:border ocp:p-6 ocp:shadow-lg ocp:duration-200 ocp:sm:max-w-lg',
          props.class,
        )
      "
    >
      <slot />
    </AlertDialogContent>
  </AlertDialogPortal>
</template>
