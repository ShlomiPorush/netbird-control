import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// The look of the remote connection flow, shared by the Remote Access page and the session view:
// one centered card, a header with an icon tile, large fields and full-width buttons.

// The ! marks: Input and Button set their own height and corners, and cn() does not merge classes.
/** Large inputs for the flow's forms. */
export const FLOW_INPUT = 'h-12! w-full min-w-0 rounded-lg! text-[0.95rem]';
/** A full-width flow button (with variant="primary" or the default secondary). */
export const FLOW_BUTTON = 'h-11! w-full rounded-lg! text-[0.95rem] font-semibold';
/** The quiet way out under the main button (Cancel). */
export const FLOW_QUIET = 'h-9! w-full rounded-lg! text-sm';
export const FLOW_NOTICE = cn(
  'mb-4 w-full overflow-hidden rounded-2xl border border-nb-gray-100 bg-white',
  'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-18px_rgba(0,0,0,0.2)]',
  'dark:border-nb-gray-900 dark:bg-nb-gray-940 dark:shadow-[0_12px_32px_-18px_rgba(0,0,0,0.7)]',
);

export function FlowCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(
      'w-full max-w-[460px] rounded-2xl border border-nb-gray-100 bg-white p-5 sm:p-7',
      'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_18px_48px_-18px_rgba(0,0,0,0.22)]',
      'dark:border-nb-gray-900 dark:bg-nb-gray-940 dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.7)]',
      className,
    )}>
      {children}
    </div>
  );
}

type Tone = 'brand' | 'danger' | 'neutral';
const TILE: Record<Tone, string> = {
  brand: 'bg-linear-to-br from-netbird-400 to-netbird-600 text-white shadow-[0_6px_16px_-6px_rgba(229,83,17,0.7)]',
  danger: 'bg-linear-to-br from-red-500 to-red-700 text-white shadow-[0_6px_16px_-6px_rgba(185,28,28,0.7)]',
  neutral: 'bg-nb-gray-200 text-nb-gray-700 dark:bg-nb-gray-800 dark:text-nb-gray-100',
};

export function FlowTile({ icon, tone = 'brand', large }: { icon: ReactNode; tone?: Tone; large?: boolean }) {
  return (
    <div className={cn('flex shrink-0 items-center justify-center', large ? 'h-14 w-14 rounded-2xl' : 'h-10 w-10 rounded-xl', TILE[tone])}>
      {icon}
    </div>
  );
}

/** A card's header: the icon tile, a short title and (optionally) the server it is about. */
export function FlowHeader({ icon, tone, title, subtitle }: { icon: ReactNode; tone?: Tone; title: string; subtitle?: string }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <FlowTile icon={icon} tone={tone} />
      <div className="min-w-0">
        <h2 className="text-[1.05rem] font-bold leading-tight tracking-tight text-nb-gray-900 dark:text-white">{title}</h2>
        {subtitle && <div className="mt-0.5 truncate text-[0.8rem] text-nb-gray-500 dark:text-nb-gray-400" title={subtitle}>{subtitle}</div>}
      </div>
    </div>
  );
}
