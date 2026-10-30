<script setup lang="ts">
import type { DialogOverlayProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "../../utils"
import { DialogOverlay } from "reka-ui"

const props = defineProps<DialogOverlayProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <DialogOverlay
    data-slot="sheet-overlay"
    :class="cn('ocp:data-[state=open]:animate-in ocp:data-[state=closed]:animate-out ocp:data-[state=closed]:fade-out-0 ocp:data-[state=open]:fade-in-0 ocp:fixed ocp:inset-0 ocp:z-50 ocp:bg-black/80', props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </DialogOverlay>
</template>
