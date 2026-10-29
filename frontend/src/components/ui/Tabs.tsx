import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
}

/** NetBird-style underline tabs. */
export function Tabs({
  items, value, onChange, className, bordered = true,
}: { items: TabItem[]; value: string; onChange: (key: string) => void; className?: string; bordered?: boolean }) {
  return (
    <div className={cn('flex items-end gap-1 overflow-x-auto', bordered && 'border-b border-nb-gray-200 dark:border-nb-gray-900', className)}>
      {items.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={cn(
              'relative inline-flex items-center gap-2 whitespace-nowrap px-3 pt-1.5 pb-3 text-sm font-normal transition-colors',
              active
                ? 'text-netbird'
                : 'text-nb-gray-600 hover:text-nb-gray-900 dark:text-nb-gray-400 dark:hover:text-nb-gray-200',
            )}
          >
            {t.icon}
            {t.label}
            <span
              className={cn(
                'absolute left-0 right-0 bottom-0 h-[1.5px] transition-all',
                active ? 'bg-netbird' : 'bg-transparent',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

export interface PillTabItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
}

/**
 * Segmented "pill" tab bar for page-level view switches (Peers kinds, Admin
 * sections, Users/Groups, ...). This is the white-on-gray pill toggle that
 * several pages had copy-pasted inline; kept separate from {@link Tabs} because
 * that renders the NetBird underline style, a deliberately different look.
 * Markup is copied verbatim from those pages so they stay pixel-identical.
 */
export function PillTabs({
  items, value, onChange, className,
}: { items: PillTabItem[]; value: string; onChange: (key: string) => void; className?: string }) {
  return (
    <div className={cn('inline-flex max-w-full overflow-x-auto rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-0.5 bg-nb-gray-100/50 dark:bg-nb-gray-920', className)}>
      {items.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            // gap-2 only affects buttons that carry an icon; text-only tabs are unchanged.
            className={cn(
              'inline-flex items-center gap-2 whitespace-nowrap h-[38px] px-3.5 text-sm font-medium rounded transition-colors',
              active
                ? 'bg-white dark:bg-nb-gray-900 text-netbird shadow-sm'
                : 'text-nb-gray-500 hover:text-nb-gray-800 dark:hover:text-nb-gray-200',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
