<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes, ButtonHTMLAttributes } from "vue"
import type { ButtonVariants } from "."
import { cn } from "../../utils"
import { Primitive } from "reka-ui"
import { buttonVariants } from "."

interface Props extends PrimitiveProps {
  type?: ButtonHTMLAttributes["type"]
  variant?: ButtonVariants["variant"]
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
  type: "button",
})
</script>

<template>
  <Primitive
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :type="as === 'button' ? type : undefined"
    :as="as"
    :as-child="asChild"
    :class="cn(buttonVariants({ variant, size }), props.class)"
  >
    <slot />
  </Primitive>
</template>
