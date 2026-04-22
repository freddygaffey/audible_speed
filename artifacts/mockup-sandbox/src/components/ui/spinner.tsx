import type { ComponentProps } from "react"
import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

/** Omit `ref` so props stay compatible with `lucide-react` when duplicate `@types/react` trees exist. */
function Spinner({ className, ...props }: Omit<ComponentProps<"svg">, "ref">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
