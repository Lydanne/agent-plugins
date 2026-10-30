import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Alert } from "./Alert.vue"
export { default as AlertDescription } from "./AlertDescription.vue"
export { default as AlertTitle } from "./AlertTitle.vue"

export const alertVariants = cva(
  "ocp:relative ocp:w-full ocp:rounded-lg ocp:border ocp:px-4 ocp:py-3 ocp:text-sm ocp:grid ocp:has-[>svg]:grid-cols-[calc(var(--ocp-spacing)*4)_1fr] ocp:grid-cols-[0_1fr] ocp:has-[>svg]:gap-x-3 ocp:gap-y-0.5 ocp:items-start ocp:[&>svg]:size-4 ocp:[&>svg]:translate-y-0.5 ocp:[&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "ocp:bg-card ocp:text-card-foreground",
        destructive:
          "ocp:text-destructive ocp:bg-card ocp:[&>svg]:text-current ocp:*:data-[slot=alert-description]:text-destructive/90",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export type AlertVariants = VariantProps<typeof alertVariants>
