import { useState } from 'react';
import { Search } from 'lucide-react';
import { useRequestTargetSearch } from '@/lib/queries';
import { useDebounced } from '@/lib/useDebounced';
import type { GrantTarget } from '@/lib/types';
import { Input } from '@/components/ui';
import { TARGET_META } from '@/components/access/targets';

/**
 * Typeahead over everything grantable (resources, networks, access profiles) - one search box
 * instead of cascading type/network/target selects. Clicking a result calls onPick. Shared by
 * the Request Access page and the admin Temporary Access grant modal. Backed by
 * `GET /api/request-targets`, which any logged-in user may call.
 */
export function TargetSearch({
  chosen, onPick, placeholder = 'Search resources, networks or access profiles…', types, onEnterFree,
}: {
  chosen: GrantTarget[];
  onPick: (t: GrantTarget) => void;
  placeholder?: string;
  /** Restrict the result list to these target types (e.g. Troubleshoot: resource/network only). */
  types?: string[];
  /** When set, pressing Enter hands the RAW typed text to the caller (Troubleshoot's
   *  free address check for things that aren't a listed resource). */
  onEnterFree?: (text: string) => void;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, isFetching } = useRequestTargetSearch(dq, true);
  // A resource and its port-policy sub-entries share the same id - dedupe against the chosen
  // list by (type, id, access scope) so picking "Host · Veeam (TCP 9392)" still leaves the
  // other port entries (and the whole-resource entry) pickable.
  const sig = (t: { type: string; id: string; access?: unknown }) => `${t.type}:${t.id}:${JSON.stringify(t.access ?? null)}`;
  const results = (data?.results || [])
    .filter((r) => !types || types.includes(r.type))
    .filter((r) => !chosen.some((c) => sig(c) === sig(r)));
  const open = dq.trim().length >= 2;
  return (
    <div>
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-nb-gray-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="w-full pl-9"
          onKeyDown={(e) => { if (e.key === 'Enter' && onEnterFree && q.trim()) { onEnterFree(q.trim()); setQ(''); } }} />
      </div>
      {open && (
        <div className="nb-scroll mt-1 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 divide-y divide-nb-gray-100 dark:divide-nb-gray-900 max-h-64 overflow-y-auto">
          {!results.length ? (
            <div className="px-3 py-2.5 text-sm text-nb-gray-500">
              {isFetching ? 'Searching…' : onEnterFree ? 'No matches - press Enter to check it as an address (IP or host, optional :port).' : 'No matches - try another name.'}
            </div>
          ) : results.map((r) => (
            // Deliberately does NOT clear the query on pick - every caller collects multiple
            // targets, and closing the list after each pick forced re-searching. The picked
            // item drops out of the list (chosen filter), so picking several in a row is
            // one search + N clicks.
            <button key={sig(r)} type="button" onClick={() => onPick({ type: r.type, id: r.id, name: r.name, networkId: r.networkId, resourceType: r.resourceType, groupId: r.groupId, access: r.access })}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/50">
              <span className="text-nb-gray-400">{TARGET_META[r.type].icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-nb-gray-800 dark:text-nb-gray-100">{r.name}</span>
                {r.subtitle && <span className="block truncate text-[0.76rem] text-nb-gray-500">{r.subtitle}</span>}
              </span>
              <span className="text-[0.66rem] uppercase text-nb-gray-400 whitespace-nowrap">{r.access ? 'Ports Only' : TARGET_META[r.type].label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
