import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'gray' | 'green' | 'red' | 'orange' | 'cyan';

const tones: Record<Tone, string> = {
  gray: 'bg-nb-gray-100 text-nb-gray-600 border-nb-gray-200 dark:bg-nb-gray-900 dark:text-nb-gray-300 dark:border-nb-gray-800/50',
  green: 'bg-green-500/10 text-green-600 border-green-500/30 dark:text-green-500',
  red: 'bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-500',
  orange: 'bg-netbird/10 text-netbird border-netbird/30',
  cyan: 'bg-nb-blue-400/10 text-nb-blue-600 border-nb-blue-400/30 dark:text-nb-blue-400',
};

/** A small pill/chip - used for groups, protocols, statuses. */
export function Badge({
  children, tone = 'gray', icon, className,
}: { children: ReactNode; tone?: Tone; icon?: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border text-[0.75rem] py-1.5 px-3 whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** A status dot (e.g. peer connected/disconnected). */
export function StatusDot({ on, className }: { on?: boolean; className?: string }) {
  return <span className={cn('h-2 w-2 rounded-full', on ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600', className)} />;
}
