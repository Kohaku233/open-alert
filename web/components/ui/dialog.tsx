"use client"

import * as React from "react"
import { FloatingOpenContext, useFloatingMotion, useMotionPresence, useOpenState } from '../../motion.js'

import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "../../lib/utils.js"
import { t } from '../../i18n.js'

function Dialog({ open, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [current, change] = useOpenState({ open, defaultOpen, onOpenChange });
  return <FloatingOpenContext value={current}><DialogPrimitive.Root open={current} onOpenChange={change} {...props}/></FloatingOpenContext>;
}

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      "fixed inset-0 z-50 bg-black/80  ",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { closeDisabled?: boolean; onExitComplete?: (() => void) | undefined }
>(({ className, children, closeDisabled = false, onExitComplete, ...props }, ref) => {
  const open = React.useContext(FloatingOpenContext);
  const { present, finish } = useMotionPresence(open);
  const content = React.useRef<HTMLDivElement>(null), overlay = React.useRef<HTMLDivElement>(null);
  const attach = useFloatingMotion(content, open, present, () => { finish(); onExitComplete?.(); }, 'dialog', overlay, ref);
  if (!present) return null;
  return (
  <DialogPortal forceMount>
    <DialogOverlay ref={overlay} forceMount />
    <DialogPrimitive.Content
      forceMount
      ref={attach}
      inert={!open}
      data-slot="dialog-content"
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg transform-[translate(-50%,-50%)] gap-4 border bg-background p-6 shadow-lg duration-200 sm:rounded-lg",
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close disabled={closeDisabled} aria-label={t('关闭对话框')} className="ui-dialog-close absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">{t('关闭对话框')}</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
);
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
