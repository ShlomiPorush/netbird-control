import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { ArrowUpDown, ArrowUpNarrowWide, ArrowDownWideNarrow } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { SortState } from '@/lib/useTableSort';

/** Full-bleed table matching NetBird (top/bottom borders only, no rounded card). */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // Scroll wide tables horizontally on small screens instead of breaking the page layout.
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse border-y border-nb-gray-200 dark:border-nb-gray-900 text-sm', className)}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-100/60 dark:bg-nb-gray-930/40">
        {children}
      </tr>
    </thead>
  );
}

export function Th({ children, className, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <th
      className={cn('h-12 px-6 text-left align-middle uppercase font-medium text-xs tracking-wide text-nb-gray-500 dark:text-nb-gray-400', className)}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function Tr({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'border-b border-nb-gray-100 dark:border-nb-gray-900 last:border-0 transition-colors',
        'hover:bg-nb-gray-100/60 dark:hover:bg-nb-gray-910/[0.15]',
        onClick && 'cursor-pointer',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function Td({ children, className, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <td className={cn('px-6 py-3 align-middle', className)} {...rest}>
      {children}
    </td>
  );
}

/** A clickable, sortable column header. Pass the `state` from useTableSort. */
export function SortTh({ label, sortKey: k, state, className, align = 'left' }: {
  label: ReactNode;
  sortKey: string;
  state: SortState;
  className?: string;
  align?: 'left' | 'right' | 'center';
}) {
  const active = state.sortKey === k;
  return (
    <Th onClick={() => state.onSort(k)} className={cn('cursor-pointer select-none hover:text-nb-gray-700 dark:hover:text-nb-gray-200 transition-colors', className)}>
      <span className={cn('inline-flex items-center gap-1.5', align === 'right' && 'justify-end w-full', align === 'center' && 'justify-center w-full')}>
        {label}
        {!active ? (
          <ArrowUpDown size={13} className="opacity-40 shrink-0" />
        ) : state.sortDir === 'asc' ? (
          <ArrowUpNarrowWide size={13} className="text-netbird shrink-0" />
        ) : (
          <ArrowDownWideNarrow size={13} className="text-netbird shrink-0" />
        )}
      </span>
    </Th>
  );
}
