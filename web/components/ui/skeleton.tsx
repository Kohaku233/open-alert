import { cn } from "../../lib/utils.js"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-md bg-primary/10", className)}
      {...props}
    />
  )
}

export { Skeleton }
