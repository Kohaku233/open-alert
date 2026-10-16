import { useDialogPresence } from '../motion.js';
import { Notice } from './Surface.js';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Dialog as DialogRoot, DialogContent, DialogTitle } from './ui/dialog.js';
export function Dialog({ title, children, onClose, busy = false }: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    busy?: boolean;
}) {
    const presence = useDialogPresence();
    const previousFocus = useRef(document.activeElement as HTMLElement | null);
    return <DialogRoot open={presence?.open ?? true} onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent onExitComplete={presence?.finish} className="app-dialog" closeDisabled={busy} aria-modal="true" aria-describedby={undefined}
        onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={event => event.preventDefault()}
        onCloseAutoFocus={event => { event.preventDefault(); previousFocus.current?.focus(); }}>
        <div className="dialog-heading"><DialogTitle>{title}</DialogTitle></div>
        {children}
      </DialogContent>
    </DialogRoot>;
}
export function FormError({ message }: {
    message: string;
}) { return message ? <Notice className="form-error" role="alert">{message}</Notice> : null; }
