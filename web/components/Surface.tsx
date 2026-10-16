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
export function LoadingStatus({ children }: { children: ReactNode }) { return <div className="loading-status" role="status"><Spinner/>{children}</div>; }
export function ListSkeleton({ label }: { label: string }) {
  const root = useRef<HTMLDivElement>(null);
  useLoadingMotion(root);
  return <div ref={root} className="list-skeleton" aria-busy="true"><LoadingStatus>{label}</LoadingStatus><div aria-hidden="true">{[0, 1, 2].map(row => <div className="skeleton-row" key={row}><Skeleton className="skeleton-line"/><Skeleton className="skeleton-line short"/></div>)}</div></div>;
}
export function PageSkeleton({ title, label, dashboard = false, error, hidden }: { title?: string; label: string; dashboard?: boolean; error?: string; hidden?: boolean }) {
  const root = useRef<HTMLElement>(null);
  useLoadingMotion(root, 'skeleton', !hidden && !error);
  return <section ref={root} className="page-skeleton" hidden={hidden} aria-busy={!error} data-slot="page-skeleton">
    <PageHeader><div>{title ? <h1>{title}</h1> : <Skeleton className="skeleton-title" aria-hidden="true"/>}{!error && <LoadingStatus>{label}</LoadingStatus>}</div></PageHeader>
    {error ? <EmptyState className="load-error"><p>{t('暂时无法读取页面')}</p><p className="muted small">{t('请检查网络和服务连接，再重试。')}</p></EmptyState> : <div aria-hidden="true">
      {dashboard && <div className="skeleton-market"><Skeleton className="skeleton-line"/><Skeleton className="skeleton-price"/></div>}
      <div className={dashboard ? 'workspace skeleton-workspace' : 'settings-grid'}>
        <Panel className={dashboard ? 'skeleton-chart' : 'skeleton-settings'}><Skeleton className="skeleton-line"/>{dashboard ? <div className="skeleton-chart-grid"/> : [0, 1, 2, 3].map(row => <div className="skeleton-row" key={row}><Skeleton className="skeleton-line"/><Skeleton className="skeleton-field"/></div>)}</Panel>
        <Panel className={dashboard ? 'skeleton-alerts' : 'skeleton-settings'}><Skeleton className="skeleton-title"/>{[0, 1, 2].map(row => <div className="skeleton-row" key={row}><Skeleton className="skeleton-line"/><Skeleton className="skeleton-line short"/></div>)}</Panel>
      </div>
    </div>}
  </section>;
}
