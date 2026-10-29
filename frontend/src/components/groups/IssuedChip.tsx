import type { ReactNode } from 'react';
import { Workflow, KeyRound } from 'lucide-react';
import { cn } from '@/lib/cn';

// A group's `issued` source → a compact icon. Replaces the old text badge
// ("INTEGRATION" / "JWT") to save horizontal space; the full label shows on hover.
const ISSUED: Record<string, { icon: ReactNode; label: string }> = {
  integration: { icon: <Workflow size={12} />, label: 'Issued by integration' },
  jwt: { icon: <KeyRound size={12} />, label: 'Issued by JWT (IdP claim)' },
};

/** Small icon chip for a group's `issued` value. `api` (the default) renders nothing. */
export function IssuedChip({ issued, className }: { issued: string; className?: string }) {
  if (!issued || issued === 'api') return null;
  const m = ISSUED[issued];
  return (
    <span
      title={m ? m.label : `Issued by ${issued}`}
      className={cn(
        'inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded shrink-0 border',
        'border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500 dark:text-nb-gray-400',
        className,
      )}
    >
      {m ? m.icon : <span className="text-[0.58rem] font-medium uppercase">{issued.slice(0, 3)}</span>}
    </span>
  );
}
