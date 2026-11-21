import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// A content card in the Remote Access finish: softer corners, a light border and a soft, deep
// shadow. Padding is the caller's (cn() does not merge conflicting classes).
const CARD =
  'min-w-0 rounded-xl border border-nb-gray-100 bg-white ' +
  'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-16px_rgba(0,0,0,0.14)] ' +
  'dark:border-nb-gray-900 dark:bg-nb-gray-940 dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_12px_32px_-16px_rgba(0,0,0,0.6)]';

/** hoverable: the card is (inside) a link - its border warms on hover. */
export function Card({ children, className, hoverable }: { children: ReactNode; className?: string; hoverable?: boolean }) {
  return (
    <div className={cn(CARD, hoverable && 'transition-colors hover:border-netbird/40 dark:hover:border-netbird/40', className)}>
      {children}
    </div>
  );
}
