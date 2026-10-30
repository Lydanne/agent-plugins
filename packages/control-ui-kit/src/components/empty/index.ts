import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Empty } from "./Empty.vue"
export { default as EmptyContent } from "./EmptyContent.vue"
export { default as EmptyDescription } from "./EmptyDescription.vue"
export { default as EmptyHeader } from "./EmptyHeader.vue"
export { default as EmptyMedia } from "./EmptyMedia.vue"
export { default as EmptyTitle } from "./EmptyTitle.vue"

export const emptyMediaVariants = cva(
  "ocp:mb-2 ocp:flex ocp:shrink-0 ocp:items-center ocp:justify-center ocp:[&_svg]:pointer-events-none ocp:[&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "ocp:bg-transparent",
        icon: "ocp:bg-muted ocp:text-foreground ocp:flex ocp:size-10 ocp:shrink-0 ocp:items-center ocp:justify-center ocp:rounded-lg ocp:[&_svg:not([class*='size-'])]:size-6",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export type EmptyMediaVariants = VariantProps<typeof emptyMediaVariants>
