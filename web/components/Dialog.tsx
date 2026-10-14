import { t } from '../i18n.js';
import { Icon } from './Icon.js';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
export function Dialog({ title, children, onClose, busy = false }: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    busy?: boolean;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const id = useId();
    useEffect(() => {
        const dialog = ref.current!;
        const previous = document.activeElement as HTMLElement | null;
        dialog.showModal();
        return () => { dialog.close(); previous?.focus(); };
    }, []);
    return <dialog ref={ref} aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy)
        onClose(); }}>
    <div className="dialog-heading"><h2 id={id}>{title}</h2><button type="button" onClick={onClose} disabled={busy} aria-label={t("关闭对话框")}><Icon name="close"/></button></div>
    {children}
  </dialog>;
}
export function FormError({ message }: {
    message: string;
}) { return message ? <p className="form-error" role="alert">{message}</p> : null; }
