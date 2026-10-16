"use client"

import * as React from "react"
import { FloatingOpenContext, useFloatingMotion, useMotionPresence, useOpenState } from '../../motion.js'

import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "../../lib/utils.js"

const TooltipProvider = TooltipPrimitive.Provider

function Tooltip({ open, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [current, change] = useOpenState({ open, defaultOpen, onOpenChange });
  return <FloatingOpenContext value={current}><TooltipPrimitive.Root open={current} onOpenChange={change} {...props}/></FloatingOpenContext>;
}

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => {
  const open = React.useContext(FloatingOpenContext);
  const { present, finish } = useMotionPresence(open);
  const local = React.useRef<HTMLDivElement>(null);
  const attach = useFloatingMotion(local, open, present, finish, 'tooltip', undefined, ref);
  if (!present) return null;
  return (
  <TooltipPrimitive.Portal forceMount>
    <TooltipPrimitive.Content
      forceMount
      data-slot="tooltip-content"
      inert={!open}
      ref={attach}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground origin-[--radix-tooltip-content-transform-origin]",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
);
})
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
