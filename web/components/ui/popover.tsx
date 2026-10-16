"use client"

import * as React from "react"
import { FloatingOpenContext, FloatingTriggerContext, mergeRefs, useFloatingFocus, useFloatingMotion, useMotionPresence, useOpenState } from '../../motion.js'

import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "../../lib/utils.js"

function Popover({ open, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const [current, change] = useOpenState({ open, defaultOpen, onOpenChange });
  const trigger = React.useRef<HTMLButtonElement>(null);
  return <FloatingOpenContext value={current}><FloatingTriggerContext value={trigger}><PopoverPrimitive.Root open={current} onOpenChange={change} {...props}/></FloatingTriggerContext></FloatingOpenContext>;
}

const PopoverTrigger = React.forwardRef<React.ElementRef<typeof PopoverPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>>((props, ref) => {
  const trigger = React.useContext(FloatingTriggerContext);
  return <PopoverPrimitive.Trigger ref={mergeRefs(trigger, ref)} {...props}/>;
});
PopoverTrigger.displayName = PopoverPrimitive.Trigger.displayName;

const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, onInteractOutside, onCloseAutoFocus, onEscapeKeyDown, ...props }, ref) => {
  const open = React.useContext(FloatingOpenContext);
  const { present, finish } = useMotionPresence(open);
  const local = React.useRef<HTMLDivElement>(null);
  const focus = useFloatingFocus(open, local);
  const attach = useFloatingMotion(local, open, present, finish, 'popover', undefined, ref);
  if (!present) return null;
  return (
  <PopoverPrimitive.Portal forceMount>
    <PopoverPrimitive.Content
      forceMount
      data-slot="popover-content"
      inert={!open}
      ref={attach}
      onInteractOutside={event => {
        onInteractOutside?.(event);
        if (event.target instanceof Element && event.target.closest('[data-slot="select-content"]')) event.preventDefault();
        focus.trackOutside(event);
        // inert blurs the closing input; that blur is not an intentional outside interaction.
        if (!open && event.detail.originalEvent.type === 'focusin') event.preventDefault();
      }}
      onEscapeKeyDown={event => { focus.allowReturn(); onEscapeKeyDown?.(event); }}
      onCloseAutoFocus={event => { onCloseAutoFocus?.(event); focus.preventLateFocus(event); }}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none origin-[--radix-popover-content-transform-origin]",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
);
})
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
