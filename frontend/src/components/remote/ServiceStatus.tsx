import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { RemoteHealth, ServiceState } from '@/lib/remoteAccess';

const LABEL: Record<ServiceState, string> = { up: 'Online', down: 'Offline', unknown: 'Unknown' };
const DOT: Record<ServiceState, string> = {
  up: 'bg-green-500',
  down: 'bg-red-500',
  unknown: 'bg-nb-gray-400 dark:bg-nb-gray-500',
};

// One compact line on the connect card: is NetBird answering, and is each Browser Gateway up. The
// page asks only on a user action (loading the page, starting a check, this refresh button), so
// the line never keeps an idle sign-in alive.
export function ServiceStatus({ health, loading, onRefresh }: { health: RemoteHealth | null; loading: boolean; onRefresh: () => void }) {
  const items: [string, ServiceState | undefined][] = [
    ['NetBird', health?.netbird],
    ['Browser Gateway', health?.gateway],
    ...(health?.namesGateway ? [['Host Name Gateway', health.namesGateway] as [string, ServiceState]] : []),
  ];
  return (
    <div className="mt-5 flex items-center gap-2 border-t border-nb-gray-100 pt-3 dark:border-nb-gray-900">
      <ul aria-label="Service Status" aria-live="polite"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3.5 gap-y-1 text-[0.75rem]">
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
      <button type="button" onClick={onRefresh} disabled={loading} title="Refresh Status" aria-label="Refresh Status"
        className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-nb-gray-500 transition-colors',
          'hover:bg-nb-gray-100 hover:text-nb-gray-800 disabled:cursor-default disabled:opacity-60',
          'dark:text-nb-gray-400 dark:hover:bg-nb-gray-900 dark:hover:text-nb-gray-100',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-netbird-700 dark:focus-visible:outline-netbird-400')}>
        <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
      </button>
    </div>
  );
}
