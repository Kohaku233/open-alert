import { Loader2Icon } from "lucide-react"

import { cn } from "../../lib/utils.js"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      
      aria-hidden="true"
      data-slot="spinner"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
