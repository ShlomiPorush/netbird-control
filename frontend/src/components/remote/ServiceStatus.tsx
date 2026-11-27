import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { RemoteHealth, ServiceState } from '@/lib/remoteAccess';

type Shown = ServiceState | 'partial';
const LABEL: Record<Shown, string> = { up: 'Online', down: 'Offline', partial: 'Partly Online', unknown: 'Unknown' };
const DOT: Record<Shown, string> = {
  up: 'bg-green-500',
  down: 'bg-red-500',
  partial: 'bg-amber-500',
  unknown: 'bg-nb-gray-400 dark:bg-nb-gray-500',
};
// The user doesn't need to tell the gateways apart: one item for all of them. Online when every
// one is up, Partly Online when some are, Offline when none is and one is known down, else Unknown.
function gatewaysState(states: (ServiceState | undefined)[]): Shown | undefined {
  const known = states.filter((s): s is ServiceState => !!s);
  if (!known.length) return undefined;
  const up = known.filter((s) => s === 'up').length;
  if (up === known.length) return 'up';
  if (up > 0) return 'partial';
  return known.some((s) => s === 'down') ? 'down' : 'unknown';
}
// A refresh usually answers at once; the icon keeps turning for a moment so the click shows.
const MIN_SPIN_MS = 700;

export function ServiceStatus({ health, loading, onRefresh }: { health: RemoteHealth | null; loading: boolean; onRefresh: () => void }) {
  const items: [string, Shown | undefined][] = [
    ['NetBird', health?.netbird],
    ['Gateways', health ? gatewaysState([health.gateway, health.namesGateway]) : undefined],
    ...(health?.browserGateway ? [['Browser', health.browserGateway] as [string, Shown]] : []),
  ];
  const [spinUntil, setSpinUntil] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const spinning = loading || spinUntil > 0;
  const refresh = () => {
    window.clearTimeout(timer.current);
    setSpinUntil(Date.now() + MIN_SPIN_MS);
    timer.current = window.setTimeout(() => setSpinUntil(0), MIN_SPIN_MS);
    onRefresh();
  };
  return (
    <div className="mt-5 flex items-center gap-2 border-t border-nb-gray-100 pt-3 dark:border-nb-gray-900">
      <ul aria-label="Service Status" aria-live="polite"
        className={cn('flex min-w-0 flex-1 flex-wrap items-center gap-x-3.5 gap-y-1 text-[0.75rem] transition-opacity', spinning && 'opacity-50')}>
        {items.map(([name, state]) => {
          const waiting = !state && loading;
          const s = state || 'unknown';
          return (
            <li key={name} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', waiting ? 'bg-nb-gray-300 dark:bg-nb-gray-700' : DOT[s])} />
              <span className="font-medium text-nb-gray-700 dark:text-nb-gray-200">{name}</span>
              <span className="text-nb-gray-500 dark:text-nb-gray-400">{waiting ? 'Checking' : LABEL[s]}</span>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={refresh} disabled={spinning} title="Refresh Status" aria-label="Refresh Status"
        className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-nb-gray-500 transition-colors',
          'hover:bg-nb-gray-100 hover:text-nb-gray-800 disabled:cursor-default disabled:opacity-60',
          'dark:text-nb-gray-400 dark:hover:bg-nb-gray-900 dark:hover:text-nb-gray-100',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-netbird-700 dark:focus-visible:outline-netbird-400')}>
        <RefreshCw size={13} className={spinning ? 'animate-spin' : undefined} />
      </button>
    </div>
  );
}
