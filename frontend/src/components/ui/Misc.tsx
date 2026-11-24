import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { IconTile } from './IconTile';

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
      {icon && <IconTile icon={icon} tone="neutral" className="mb-1 [&_svg]:size-5" />}
      <p className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-300">{title}</p>
      {hint && <p className="text-xs text-nb-gray-500">{hint}</p>}
    </div>
  );
}
