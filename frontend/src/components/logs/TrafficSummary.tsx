import { useEffect, useState } from 'react';
import { ChevronRight, Monitor, Workflow, Globe, Network as NetworkIcon, Share2, ArrowRight, ArrowDown, ArrowUp, Server, User2, Mail, MapPin, Flag } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useLogSummary, useLogs, type LogParams } from '@/lib/queries';
import type { TrafficSummaryRow, LogEvent, UserRef } from '@/lib/types';
import { formatTimestamp, formatBytes, getServiceName } from '@/lib/logfmt';
import { type SortState } from '@/lib/useTableSort';
import { Button, EmptyState, LoadingState, LogLoader, useSettledDelay, Pagination, SortTh } from '@/components/ui';
import { EventsTable } from '@/components/logs/EventsTable';
import { RawModal } from '@/components/logs/RawModal';
import { PeerCell, TrafficCell } from '@/components/logs/cells';

const PROTO_NAME: Record<number, string> = { 1: 'ICMP', 6: 'TCP', 17: 'UDP' };

const rowKey = (r: TrafficSummaryRow) => `${r.sourceId || r.sourceHost}→${r.destinationId || r.destinationName || r.destinationHost}`;

// Header metrics match the plain <th>s. SortTh renders the shared <Th> (h-12/px-6/text-xs) and
// cn() is a plain join (no tailwind-merge), so we force the tighter metrics with `!` to keep the
// sortable headers pixel-identical to the non-sortable ones.
const TH_CLS = 'h-11 px-5 uppercase font-medium text-[0.68rem] tracking-wide text-nb-gray-500 dark:text-nb-gray-400';
const SORT_TH_CLS = 'h-11! px-5! text-[0.68rem]!';

// Header columns, in order. `sort` is the GET /api/logs/summary sort key. The combined Traffic
// cell shows rx (down) over tx (up); the API sorts each separately, so we sort it by `tx` (bytes
// the source sent). Protocol & Ports has no server sort key, and firstSeen has no column of its
// own (it's the "since ..." subtitle under Last Activity), so neither is offered.
const COLUMNS: { label: string; sort?: string }[] = [
  { label: 'Source', sort: 'source' },
  { label: 'Destination', sort: 'destination' },
  { label: 'Connections', sort: 'connections' },
  { label: 'Traffic', sort: 'tx' },
  { label: 'Protocol & Ports' },
  { label: 'Last Activity', sort: 'lastSeen' },
];

function destIcon(t: string) {
  if (t === 'HOST_RESOURCE') return <Workflow size={15} />;
  if (t === 'DOMAIN_RESOURCE') return <Globe size={15} />;
  if (t === 'SUBNET_RESOURCE') return <NetworkIcon size={15} />;
  return <Monitor size={15} />;
}

// Hover tooltip fields - identical shape to the detailed view's source/destination popups.
function srcFields(r: TrafficSummaryRow, user?: UserRef) {
  return [
    { icon: <Server size={14} />, label: 'Peer', value: r.sourceLabel || r.sourceName || r.sourceHost || 'Unknown' },
    r.sourceDns ? { icon: <Globe size={14} />, label: 'Domain', value: r.sourceDns } : null,
    user?.display_name ? { icon: <User2 size={14} />, label: 'User', value: user.display_name } : null,
    user?.email ? { icon: <Mail size={14} />, label: 'User E-Mail', value: user.email } : null,
    { icon: <MapPin size={14} />, label: 'Source', value: r.sourceHost || '-' },
    r.sourceGeo ? { icon: <Flag size={14} />, label: 'Region', value: r.sourceGeo } : null,
  ];
}
function dstFields(r: TrafficSummaryRow) {
  return [
    { icon: <Server size={14} />, label: r.destinationType === 'PEER' ? 'Peer' : 'Resource', value: r.destinationLabel || r.destinationName || r.destinationDns || r.destinationHost || 'Unknown' },
    r.destinationDns ? { icon: <Globe size={14} />, label: 'Domain', value: r.destinationDns } : null,
    { icon: <MapPin size={14} />, label: 'Destination', value: r.destinationHost || '-' },
    r.destinationGeo ? { icon: <Flag size={14} />, label: 'Region', value: r.destinationGeo } : null,
  ];
}

function PortBadges({ r }: { r: TrafficSummaryRow }) {
  const protos = r.protocols.map((p) => PROTO_NAME[p]).filter(Boolean);
  const shown = r.ports.slice(0, 4);
  const cls = 'inline-flex items-center gap-1 rounded-md border text-[0.72rem] py-1 px-2 whitespace-nowrap bg-nb-gray-100 dark:bg-nb-gray-930/60 border-nb-gray-200 dark:border-nb-gray-800/40 text-nb-gray-600 dark:text-nb-gray-300';
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {protos.map((p) => <span key={p} className={cn(cls, 'uppercase')}><Share2 size={11} />{p}</span>)}
      {shown.map((p) => {
        const service = getServiceName(`:${p}`);
        return (
          <span key={p} className="inline-flex items-baseline gap-1">
            <span className={cls}>{p}</span>
            {service && <span className="text-[0.6rem] leading-none text-netbird">{service}</span>}
          </span>
        );
      })}
      {r.ports.length > shown.length && <span className="text-[0.72rem] text-nb-gray-400">+{r.ports.length - shown.length}</span>}
    </div>
  );
}

/** The pair's most recent connections, loaded lazily when a summary row is expanded.
 *  "Load More" pulls additional connections inline; "View Full Details" jumps to the
 *  Detailed view pre-filtered to just this pair. */
function PairEvents({ base, row, onDrill }: { base: LogParams; row: TrafficSummaryRow; onDrill?: (r: TrafficSummaryRow) => void }) {
  const [raw, setRaw] = useState<LogEvent | null>(null);
  const [limit, setLimit] = useState(5);
  const { data, isLoading, isFetching } = useLogs({
    ...base,
    source: row.sourceHost || row.sourceName || undefined,
    destination: row.destinationName || row.destinationHost || undefined,
    page: 1,
    per_page: limit,
  });
  const events = data?.events || [];
  const total = data?.total || 0; // total CONNECTIONS (flows) of this pair under the current filters
  const usersMap: Record<string, UserRef> = data?.users || {};
  if (isLoading) return <div className="py-4"><LoadingState /></div>;
  return (
    <div>
      <EventsTable events={events} usersMap={usersMap} maxGroups={limit} onRaw={setRaw} showRouter={false} minWidth={720} />
      <div className="mt-2.5 flex flex-wrap items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <span className="text-[0.72rem] text-nb-gray-400">Showing {Math.min(limit, total)} of {total} connections</span>
        {total > limit && (
          <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + 10)} disabled={isFetching}>
            {isFetching ? 'Loading…' : 'Load More'}
          </Button>
        )}
        {onDrill && (
          <Button variant="secondary" size="sm" onClick={() => onDrill(row)}>
            View Full Details <ArrowRight size={13} />
          </Button>
        )}
      </div>
      <RawModal data={raw} onClose={() => setRaw(null)} />
    </div>
  );
}

/**
 * The Summary view of traffic events: one row per source→destination "conversation" with
 * connection counts, total traffic, ports and the activity window - aggregated server-side
 * over the WHOLE filtered range. Clicking a row expands its latest connections inline.
 */
export function TrafficSummary({ filters, perPage, onDrill, sortState }: {
  filters: Omit<LogParams, 'page' | 'per_page'>;
  perPage: number;
  /** Jump to the Detailed view pre-filtered to the given pair. */
  onDrill?: (r: TrafficSummaryRow) => void;
  // When provided, the sortable columns become clickable headers driving server-side sort.
  // Absent (the default) keeps every header a plain <th>, so existing consumers are unchanged.
  sortState?: SortState;
}) {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const key = JSON.stringify(filters);
  useEffect(() => { setPage(1); setOpen(null); }, [key, perPage]);

  const { data, isLoading } = useLogSummary({ ...filters, page, per_page: perPage });
  // The summary is the heaviest query in the app (it aggregates the whole filtered range), so it
  // gets the branded loader - held a beat past settling so the counter can land on 100%.
  const loader = useSettledDelay(isLoading);
  const rows = data?.rows || [];
  const usersMap: Record<string, UserRef> = data?.users || {};
  const totalPages = Math.max(data?.total_pages || 1, 1);

  if (loader.visible) return <LogLoader done={loader.done} label="Summarizing Traffic…" />;
  if (!rows.length) return <EmptyState title="No Traffic Found" hint="Try adjusting your filters or date range." />;

  return (
    <div>
      <div className="hidden md:block w-full overflow-x-auto">
        <table className="w-full border-collapse border-y border-nb-gray-200 dark:border-nb-gray-900" style={{ minWidth: 860 }}>
          <thead>
            <tr className="border-b border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-100/60 dark:bg-nb-gray-930/40 text-left">
              {COLUMNS.map((c) => (
                // Sortable only when a `sortState` is supplied and the column maps to a backend
                // sort key; otherwise (Protocol & Ports) it stays a plain <th>.
                sortState && c.sort
                  ? <SortTh key={c.label} label={c.label} sortKey={c.sort} state={sortState} className={SORT_TH_CLS} />
                  : <th key={c.label} className={TH_CLS}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const k = rowKey(r);
              const isOpen = open === k;
              const user = r.userId ? usersMap[r.userId] : undefined;
              return (
                <ReactGroup key={k}>
                  <tr onClick={() => setOpen(isOpen ? null : k)}
                    className={cn('border-b border-nb-gray-100 dark:border-nb-gray-900 cursor-pointer',
                      isOpen ? 'bg-nb-gray-100/70 dark:bg-nb-gray-920/80' : 'hover:bg-nb-gray-100/50 dark:hover:bg-nb-gray-910/15')}>
                    <td className={cn('px-5 py-3.5', isOpen && 'border-l-2 border-netbird/60')}>
                      <div className="flex items-center gap-2">
                        <ChevronRight size={15} className={cn('shrink-0 transition-transform', isOpen ? 'rotate-90 text-netbird' : 'text-nb-gray-400')} />
                        <div className="min-w-0">
                          <PeerCell name={r.sourceLabel || r.sourceName || r.sourceHost || 'Unknown'} addr={r.sourceHost || '-'} fields={srcFields(r, user)} peerId={r.sourceId || undefined} />
                          {(user?.display_name || user?.email) && (
                            <div className="mt-1 ml-[46px] flex items-center gap-1.5 text-[0.72rem] text-nb-gray-500 truncate">
                              <User2 size={11} className="shrink-0" /> {user.display_name || user.email}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <PeerCell name={r.destinationLabel || r.destinationName || r.destinationDns || r.destinationHost || 'Unknown'} addr={r.destinationHost || '-'}
                        fields={dstFields(r)} icon={destIcon(r.destinationType)}
                        peerId={r.destinationType === 'PEER' ? (r.destinationId || undefined) : undefined} />
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 tabular-nums">{r.connections.toLocaleString()}</span>
                      <span className="ml-1 text-[0.72rem] text-nb-gray-400">({r.eventCount.toLocaleString()} events)</span>
                    </td>
                    <td className="px-5 py-3.5"><TrafficCell rx={r.rx} tx={r.tx} /></td>
                    <td className="px-5 py-3.5"><PortBadges r={r} /></td>
                    <td className="px-5 py-3.5">
                      <div className="text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300 whitespace-nowrap">{formatTimestamp(r.lastSeen)}</div>
                      <div className="text-[0.7rem] text-nb-gray-400 whitespace-nowrap">since {formatTimestamp(r.firstSeen)}</div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-nb-gray-100 dark:border-nb-gray-900 bg-nb-gray-50/60 dark:bg-nb-gray-950/40">
                      <td colSpan={6} className="px-5 py-3 border-l-2 border-netbird/60">
                        <PairEvents base={filters} row={r} onDrill={onDrill} />
                      </td>
                    </tr>
                  )}
                </ReactGroup>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards instead of the wide table */}
      <div className="md:hidden flex flex-col gap-2.5">
        {rows.map((r) => {
          const k = rowKey(r);
          const isOpen = open === k;
          const user = r.userId ? usersMap[r.userId] : undefined;
          return (
            <div key={k} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950">
              <div onClick={() => setOpen(isOpen ? null : k)} className="p-3.5 cursor-pointer">
                <div className="flex items-center gap-2 min-w-0">
                  <ChevronRight size={15} className={cn('shrink-0 transition-transform', isOpen ? 'rotate-90 text-netbird' : 'text-nb-gray-400')} />
                  <span className="min-w-0 flex-1 flex items-center gap-1.5 text-sm text-nb-gray-800 dark:text-nb-gray-100">
                    <span className="truncate">{r.sourceLabel || r.sourceName || r.sourceHost}</span>
                    <ArrowRight size={13} className="shrink-0 text-nb-gray-400" />
                    <span className="truncate">{r.destinationLabel || r.destinationName || r.destinationDns || r.destinationHost}</span>
                  </span>
                </div>
                {(user?.display_name || user?.email) && (
                  <div className="mt-1 ml-6 flex items-center gap-1.5 text-[0.72rem] text-nb-gray-500 truncate">
                    <User2 size={11} className="shrink-0" /> {user.display_name || user.email}
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between gap-3 text-[0.78rem] text-nb-gray-500">
                  <span>{r.connections.toLocaleString()} connections</span>
                  <span className="inline-flex items-center gap-2 whitespace-nowrap font-medium text-nb-gray-600 dark:text-nb-gray-300">
                    <span className="inline-flex items-center gap-1"><ArrowDown size={13} className="text-sky-500 dark:text-sky-400" /> {formatBytes(r.rx)}</span>
                    <span className="inline-flex items-center gap-1"><ArrowUp size={13} className="text-netbird" /> {formatBytes(r.tx)}</span>
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-3">
                  <PortBadges r={r} />
                  <span className="shrink-0 text-[0.72rem] text-nb-gray-400 whitespace-nowrap">{formatTimestamp(r.lastSeen)}</span>
                </div>
              </div>
              {isOpen && (
                <div className="border-t border-nb-gray-100 dark:border-nb-gray-900 border-l-2 border-l-netbird/60 p-3 bg-nb-gray-100/60 dark:bg-nb-gray-930/60">
                  <PairEvents base={filters} row={r} onDrill={onDrill} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Pagination page={page} totalPages={totalPages} onPage={setPage} total={data?.total} totalCapped={data?.totalCapped} label="pairs" />
    </div>
  );
}

function ReactGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
