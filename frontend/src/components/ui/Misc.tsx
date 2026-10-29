import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Spinner({ className }: { className?: string }) {
  return <div className={cn('h-5 w-5 animate-spin rounded-full border-2 border-nb-gray-300 dark:border-nb-gray-700 border-t-netbird', className)} />;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-nb-gray-500">
      <Spinner />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {icon && <div className="text-nb-gray-400 dark:text-nb-gray-600 mb-1">{icon}</div>}
      <p className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-300">{title}</p>
      {hint && <p className="text-xs text-nb-gray-500">{hint}</p>}
    </div>
  );
}

/** Page heading: title + optional description (with inline link slot). */
export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold text-nb-gray-900 dark:text-nb-gray-50">{title}</h1>
      {children && <p className="mt-1.5 text-nb-gray-500 dark:text-nb-gray-400 text-[0.95rem] flex flex-wrap items-center gap-x-1.5">{children}</p>}
    </div>
  );
}
