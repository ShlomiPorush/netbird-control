import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconTile } from './IconTile';

/** Orange inline link with optional external-link icon (NetBird InlineLink). */
export function InlineLink({ to, href, children }: { to?: string; href?: string; children: ReactNode }) {
  const cls = 'inline-flex items-center gap-1 text-netbird hover:underline underline-offset-4 font-normal transition-all';
  if (to) return <Link to={to} className={cls}>{children}</Link>;
  return <a href={href} target="_blank" rel="noopener" className={cls}>{children}</a>;
}

export interface Crumb { label: string; icon?: ReactNode; to?: string }

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <div className="flex items-center gap-2 mb-4 min-w-0">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          // Earlier crumbs keep their width; the last one (often a long name) truncates
          // instead of wrapping to a second line on narrow screens.
          <div key={i} className={cn('flex items-center gap-2 group', last ? 'min-w-0' : 'shrink-0')}>
            {i > 0 && <ChevronRight size={16} className="shrink-0 text-nb-gray-400" />}
            <div className={cn('flex items-center gap-2 transition-all min-w-0',
              last ? 'text-nb-gray-600 dark:text-nb-gray-300' : 'text-nb-gray-400 hover:text-nb-gray-600 dark:hover:text-nb-gray-300')}>
              {c.icon && <span className="shrink-0 inline-flex">{c.icon}</span>}
              {c.to ? <Link to={c.to} className="truncate">{c.label}</Link> : <span className="truncate">{c.label}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const PAGE_TITLE = 'text-2xl font-bold tracking-tight text-nb-gray-900 dark:text-nb-gray-50';

export function PageHeader({ breadcrumb, title, description, icon, actions, className }: {
  breadcrumb?: Crumb[]; title: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; className?: string;
}) {
  const text = (
    <>
      <h1 className={PAGE_TITLE}>{title}</h1>
      {description && (
        <p className="mt-1 text-base flex flex-wrap items-center gap-x-1.5 text-nb-gray-500 dark:text-nb-gray-400">{description}</p>
      )}
    </>
  );
  const heading = icon ? (
    <div className="flex min-w-0 items-start gap-3.5">
      <IconTile icon={icon} className="mt-0.5" />
      <div className="min-w-0">{text}</div>
    </div>
  ) : actions ? <div className="min-w-0">{text}</div> : text;
  return (
    <div className={cn('mb-6', className)}>
      {breadcrumb && <Breadcrumbs items={breadcrumb} />}
      {actions ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          {heading}
          <div className="flex flex-wrap gap-2 sm:max-w-[60%] sm:shrink-0 sm:justify-end sm:pt-1">{actions}</div>
        </div>
      ) : heading}
    </div>
  );
}
