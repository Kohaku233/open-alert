import { useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { useDisclosureMotion, useLoadingMotion, useMotionPresence } from '../motion.js';
import { ChevronDown } from 'lucide-react';
import { Card } from './ui/card.js';
import { Empty } from './ui/empty.js';
import { Skeleton } from './ui/skeleton.js';
import { Spinner } from './ui/spinner.js';
import { Alert } from './ui/alert.js';
import { Button } from './ui/button.js';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible.js';
import { t } from '../i18n.js';

export function Panel({ as: Element = 'section', ...props }: ComponentProps<'section'> & { as?: 'section' | 'aside' }) {
  return <Card asChild><Element {...props}/></Card>;
}
export function PageHeader(props: ComponentProps<'div'>) { return <div {...props} className={`page-heading ${props.className ?? ''}`} data-slot="page-header"/>; }
export function EmptyState(props: ComponentProps<typeof Empty>) { return <Empty {...props}/>; }
export function Notice({ as: Element = 'div', role = 'note', ...props }: ComponentProps<'div'> & { as?: 'div' | 'p' }) { return <Alert asChild role={role}><Element {...props}/></Alert>; }
export function Disclosure({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const { present, finish } = useMotionPresence(open);
  useDisclosureMotion(content, open, finish);
  return <Collapsible open={open} onOpenChange={setOpen} className={`disclosure ${className}`} data-slot="collapsible">
    <CollapsibleTrigger asChild><Button variant="ghost" className="disclosure-trigger"><span>{title}</span><ChevronDown aria-hidden="true"/></Button></CollapsibleTrigger>
    <CollapsibleContent forceMount asChild><div ref={content} hidden={!present} inert={!open} className="disclosure-content" data-slot="collapsible-content"><div>{children}</div></div></CollapsibleContent>
  </Collapsible>;
}
export function LoadingStatus({ children }: { children: ReactNode }) { return <div className="loading-status" role="status" aria-live="polite" aria-atomic="true"><Spinner/>{children}</div>; }
export function LoadingRegion({ label, children, className = '', contentClassName = '' }: {
  label: string;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  return <div ref={root} className={`loading-region ${className}`.trim()} aria-busy="true">
    <LoadingStatus>{label}</LoadingStatus>
    {children && <div className={`loading-region-content ${contentClassName}`.trim()} aria-hidden="true">{children}</div>}
  </div>;
}
export function ListSkeleton({ label, children, className = '', contentClassName = '', rows = 3 }: {
  label: string;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  rows?: number;
}) {
  const items = children ?? Array.from({ length: rows }, (_, row) => <div className="skeleton-row" key={row}><Skeleton className="skeleton-line"/><Skeleton className="skeleton-line short"/></div>);
  return <LoadingRegion
    label={label}
    className={`list-skeleton ${className}`.trim()}
    contentClassName={`list-skeleton-content ${contentClassName}`.trim()}
  >{items}</LoadingRegion>;
}
/** Retained failure surface for a first load that came back with an error: the
    page states what happened instead of holding an empty placeholder. */
export function PageError({ title }: { title?: string }) {
  return <section className="page-failure" data-slot="page-error">
    <PageHeader><div>{title && <h1>{title}</h1>}</div></PageHeader>
    <EmptyState className="load-error"><p>{t('暂时无法读取页面')}</p><p className="muted small">{t('请检查网络和服务连接，再重试。')}</p></EmptyState>
  </section>;
}
