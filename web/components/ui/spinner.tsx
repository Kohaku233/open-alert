import { Loader2Icon } from "lucide-react"
import { useRef } from 'react'
import { mergeRefs, useLoadingMotion } from '../../motion.js'

import { cn } from "../../lib/utils.js"

function Spinner({ className, ref, ...props }: React.ComponentProps<"svg">) {
  const local = useRef<SVGSVGElement>(null);
  useLoadingMotion(local, 'spinner');
  return (
    <Loader2Icon
      ref={mergeRefs(local, ref)}
      
      aria-hidden="true"
      data-slot="spinner"
      className={cn("size-4", className)}
      {...props}
    />
  )
}

export { Spinner }
