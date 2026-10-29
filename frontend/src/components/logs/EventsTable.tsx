import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Code2, ChevronRight, CornerDownRight, Workflow, Globe, Network, Monitor, Server, User2, Mail, MapPin, Flag } from 'lucide-react';
import { cn } from '@/lib/cn';
import { getProtocol, formatTimestamp } from '@/lib/logfmt';
import type { LogEvent, UserRef } from '@/lib/types';
import { type SortState } from '@/lib/useTableSort';
import { EmptyState, SortTh } from '@/components/ui';
import { PeerCell, ProtocolBadge, TrafficCell, EventDescription } from './cells';

interface Group { flowId: string | null; events: LogEvent[] }

// The table's own header metrics (tighter than the shared <Th> default). SortTh renders a <Th>,
// and cn() is a plain string join (no tailwind-merge), so we force h-11/px-5/text-[0.68rem] with
// `!` to keep the sortable headers pixel-identical to the plain <th>s next to them.
const TH_CLS = 'h-11 px-5 uppercase font-medium text-[0.68rem] tracking-wide text-nb-gray-500 dark:text-nb-gray-400';
const SORT_TH_CLS = '!h-11 !px-5 !text-[0.68rem]';

// Header columns, in order. `sort` is the GET /api/logs sort key for the sortable ones; Traffic
// (combined rx/tx) and Router have no server sort key, so they stay plain. There's no User column
// here (owner info is embedded in the peer cells), so the API's `user` sort isn't offered.
const COLUMNS: { label: string; sort?: string }[] = [
  { label: 'Event', sort: 'time' },
  { label: 'Source', sort: 'source' },
  { label: 'Protocol & Port', sort: 'protocol' },
  { label: 'Destination', sort: 'destination' },
  { label: 'Traffic' },
  { label: 'Router' },
];

// Peer ids for linking source/destination to the peer detail page. Resource
// destinations (host/domain/subnet) and id-less "Unknown" endpoints aren't peers.
const RESOURCE_TYPES = new Set(['HOST_RESOURCE', 'DOMAIN_RESOURCE', 'SUBNET_RESOURCE']);
const srcPeerId = (ev: LogEvent) => (ev.source_id ? String(ev.source_id) : undefined);
const dstPeerId = (ev: LogEvent) =>
  (ev.destination_id && !RESOURCE_TYPES.has(ev.destination_type || '') ? String(ev.destination_id) : undefined);

/**
 * The Traffic Events table: groups events by flow_id (expandable), renders the
 * NetBird-style columns. Shared by the Activity page and the Peer → Traffic Events
 * tab. Purely presentational - fetching/pagination live in the parent.
 */
export function EventsTable({ events, usersMap, maxGroups, onRaw, minWidth = 900, showRouter = true, sortState }: {
  events: LogEvent[];
  usersMap: Record<string, UserRef>;
  maxGroups: number;
  onRaw: (e: LogEvent) => void;
  minWidth?: number;
  showRouter?: boolean;
  // When provided, the sortable columns become clickable headers driving server-side sort.
  // Absent (the default) keeps every header a plain <th>, so existing consumers are unchanged.
  sortState?: SortState;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    const map = new Map<string, Group>();
    for (const ev of events) {
      const fid = ev.flow_id;
      if (fid && map.has(fid)) map.get(fid)!.events.push(ev);
      else if (fid) { const g = { flowId: fid, events: [ev] }; map.set(fid, g); out.push(g); }
      else out.push({ flowId: null, events: [ev] });
    }
    return out.slice(0, maxGroups);
  }, [events, maxGroups]);

  if (!groups.length) return <EmptyState title="No Events Found" hint="Try adjusting your filters or date range." />;

  return (
    <>
    <div className="hidden md:block w-full overflow-x-auto">
      <table className="w-full border-collapse border-y border-nb-gray-200 dark:border-nb-gray-900" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-100/60 dark:bg-nb-gray-930/40 text-left">
            {COLUMNS.filter((c) => showRouter || c.label !== 'Router').map((c) => (
              // Sortable only when a `sortState` is supplied and the column maps to a backend sort
              // key; otherwise (and for Traffic/Router, which the API can't sort) it's a plain <th>.
              sortState && c.sort
                ? <SortTh key={c.label} label={c.label} sortKey={c.sort} state={sortState} className={SORT_TH_CLS} />
                : <th key={c.label} className={TH_CLS}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g, gi) => {
            if (g.events.length === 1) return <EventRow key={gi} ev={g.events[0]} usersMap={usersMap} onRaw={onRaw} showRouter={showRouter} />;
            const latest = g.events[0];
            const rx = g.events.reduce((s, e) => s + (parseInt(String(e.rx_bytes), 10) || 0), 0);
            const tx = g.events.reduce((s, e) => s + (parseInt(String(e.tx_bytes), 10) || 0), 0);
            const isOpen = expanded.has(gi);
            return (
              <ReactGroup key={gi}>
                <GroupRow ev={latest} count={g.events.length} rx={rx} tx={tx} open={isOpen} onToggle={() => toggle(gi)} usersMap={usersMap} showRouter={showRouter} />
                {isOpen && g.events.map((ev, i) => <EventRow key={i} ev={ev} usersMap={usersMap} onRaw={onRaw} sub showRouter={showRouter} />)}
              </ReactGroup>
            );
          })}
        </tbody>
      </table>
    </div>

    {/* Mobile: cards instead of a wide table */}
    <div className="md:hidden flex flex-col gap-2.5">
      {groups.map((g, gi) => {
        if (g.events.length === 1) return <EventCard key={gi} ev={g.events[0]} usersMap={usersMap} onRaw={onRaw} showRouter={showRouter} />;
        const latest = g.events[0];
        const rx = g.events.reduce((s, e) => s + (parseInt(String(e.rx_bytes), 10) || 0), 0);
        const tx = g.events.reduce((s, e) => s + (parseInt(String(e.tx_bytes), 10) || 0), 0);
        const isOpen = expanded.has(gi);
        return (
          <div key={gi} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950">
            <div onClick={() => toggle(gi)} className="p-3.5 cursor-pointer">
              <div className="flex items-center gap-2">
                <ChevronRight size={15} className={cn('shrink-0 text-nb-gray-400 transition-transform', isOpen && 'rotate-90')} />
                <EventHead ev={latest} count={g.events.length} />
              </div>
              <div className="mt-2">
                <EventCardBody ev={latest} usersMap={usersMap} showRouter={showRouter} traffic={<TrafficCell rx={rx} tx={tx} />} />
              </div>
            </div>
            {isOpen && (
              <div className="border-t border-nb-gray-100 dark:border-nb-gray-900 border-l-2 border-l-netbird/60 divide-y divide-nb-gray-100 dark:divide-nb-gray-900 bg-nb-gray-100/60 dark:bg-nb-gray-930/60">
                {g.events.map((ev, i) => <EventCard key={i} ev={ev} usersMap={usersMap} onRaw={onRaw} showRouter={showRouter} sub />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
    </>
  );
}

function ReactGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// Destination identification icon - resources get a type-specific icon, peers a monitor.
function destIcon(ev: LogEvent) {
  const t = ev.destination_type || '';
  if (t === 'HOST_RESOURCE') return <Workflow size={15} />;
  if (t === 'DOMAIN_RESOURCE') return <Globe size={15} />;
  if (t === 'SUBNET_RESOURCE') return <Network size={15} />;
  return <Monitor size={15} />;
}

function StatusDotSmall({ start }: { start?: boolean }) {
  return <span className={cn('h-2 w-2 rounded-full shrink-0', start ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />;
}

function EventHead({ ev, count }: { ev: LogEvent; count?: number }) {
  return (
    <div className="flex items-center gap-2">
      <StatusDotSmall start={ev.message === 'TYPE_START'} />
      <span className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">{formatTimestamp(ev.timestamp)}</span>
      {count != null && (
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-netbird/15 text-netbird text-[0.65rem] font-bold">{count}</span>
      )}
    </div>
  );
}

function RouterCell({ ev, usersMap }: { ev: LogEvent; usersMap: Record<string, UserRef> }) {
  const isRouted = ev.destination_type === 'HOST_RESOURCE';
  const routerName = ev.reporter_name || '';
  const email = (ev.user_id && usersMap[ev.user_id]?.email) || '';
  if (!isRouted || (!routerName && !email)) {
    return <td className="px-5 py-4 text-nb-gray-500">-</td>;
  }
  // The router is itself a peer (reporter_id) - link the whole cell to its device page.
  const body = (
    <div className="flex items-center gap-2 min-w-0">
      <StatusDotSmall start />
      <div className="min-w-0">
        {routerName && <div className={cn('text-sm truncate text-nb-gray-700 dark:text-nb-gray-200', ev.reporter_id && 'group-hover/router:text-netbird group-hover/router:underline transition-colors')}>{routerName}</div>}
        {email && <div className="text-[0.72rem] text-nb-gray-500 truncate">{email}</div>}
      </div>
    </div>
  );
  return (
    <td className="px-5 py-4">
      {ev.reporter_id ? (
        <Link to={`/peers/${encodeURIComponent(ev.reporter_id)}`} onClick={(e) => e.stopPropagation()} className="group/router inline-flex max-w-full">{body}</Link>
      ) : body}
    </td>
  );
}

function srcFields(ev: LogEvent, usersMap: Record<string, UserRef>) {
  const info = ev.user_id ? usersMap[ev.user_id] : undefined;
  const region = [ev.source_geo_country, ev.source_geo_city].filter(Boolean).join(', ');
  return [
    { icon: <Server size={14} />, label: 'Peer', value: ev.source_name || ev.source_dns_label || 'Unknown' },
    ev.source_dns_label ? { icon: <Globe size={14} />, label: 'Domain', value: ev.source_dns_label } : null,
    info?.display_name ? { icon: <User2 size={14} />, label: 'User', value: info.display_name } : null,
    info?.email ? { icon: <Mail size={14} />, label: 'User E-Mail', value: info.email } : null,
    { icon: <MapPin size={14} />, label: 'Source', value: ev.source_addr || '-' },
    region ? { icon: <Flag size={14} />, label: 'Region', value: region } : null,
  ];
}

function dstFields(ev: LogEvent) {
  const region = [ev.destination_geo_country, ev.destination_geo_city].filter(Boolean).join(', ');
  return [
    { icon: <Server size={14} />, label: 'Peer', value: ev.destination_name || ev.destination_dns_label || 'Unknown' },
    ev.destination_dns_label ? { icon: <Globe size={14} />, label: 'Domain', value: ev.destination_dns_label } : null,
    { icon: <MapPin size={14} />, label: 'Destination', value: ev.destination_addr || '-' },
    region ? { icon: <Flag size={14} />, label: 'Region', value: region } : null,
  ];
}

function Cells({ ev, usersMap, traffic, showRouter, sub }: { ev: LogEvent; usersMap: Record<string, UserRef>; traffic: React.ReactNode; showRouter: boolean; sub?: boolean }) {
  const proto = getProtocol(ev.protocol, ev);
  return (
    <>
      {/* Sub-events carry the orange guide line (continuing from the expanded parent) + an
          indented ↳ connector, so it's obvious they belong to the flow above. */}
      <td className={cn('px-5 py-4 align-top', sub && 'border-l-2 border-netbird/60 pl-7')}>
        <div className="flex items-start gap-2">
          {sub && <CornerDownRight size={14} className="mt-0.5 shrink-0 text-netbird/70" />}
          <div className="flex flex-col gap-0.5">
            <EventHead ev={ev} />
            <span className="text-sm text-nb-gray-600 dark:text-nb-gray-300"><EventDescription ev={ev} /></span>
          </div>
        </div>
      </td>
      <td className="px-5 py-4"><PeerCell name={ev.source_name || ev.source_dns_label || 'Unknown'} addr={ev.source_addr || '-'} fields={srcFields(ev, usersMap)} peerId={srcPeerId(ev)} /></td>
      <td className="px-5 py-4"><ProtocolBadge cls={proto.cls} label={proto.label} icmpLabel={proto.icmpLabel} port={ev.destination_port} /></td>
      <td className="px-5 py-4"><PeerCell name={ev.destination_name || ev.destination_dns_label || 'Unknown'} addr={ev.destination_addr || '-'} fields={dstFields(ev)} icon={destIcon(ev)} peerId={dstPeerId(ev)} /></td>
      <td className="px-5 py-4">{traffic}</td>
      {showRouter && <RouterCell ev={ev} usersMap={usersMap} />}
    </>
  );
}

function EventRow({ ev, usersMap, onRaw, sub, showRouter }: { ev: LogEvent; usersMap: Record<string, UserRef>; onRaw: (e: LogEvent) => void; sub?: boolean; showRouter: boolean }) {
  return (
    <tr className={cn('border-b border-nb-gray-100 dark:border-nb-gray-900 last:border-0', sub ? 'bg-nb-gray-100/60 dark:bg-nb-gray-930/60' : 'hover:bg-nb-gray-100/50 dark:hover:bg-nb-gray-910/[0.15]')}>
      <Cells
        ev={ev}
        usersMap={usersMap}
        showRouter={showRouter}
        sub={sub}
        traffic={
          <TrafficCell
            rx={ev.rx_bytes}
            tx={ev.tx_bytes}
            raw={
              <button onClick={() => onRaw(ev)} title="View raw" className="text-nb-gray-400 hover:text-netbird shrink-0">
                <Code2 size={15} />
              </button>
            }
          />
        }
      />
    </tr>
  );
}

function GroupRow({ ev, count, rx, tx, open, onToggle, usersMap, showRouter }: {
  ev: LogEvent; count: number; rx: number; tx: number; open: boolean; onToggle: () => void; usersMap: Record<string, UserRef>; showRouter: boolean;
}) {
  return (
    <tr onClick={onToggle} className={cn('border-b border-nb-gray-100 dark:border-nb-gray-900 cursor-pointer',
      open ? 'bg-nb-gray-100/70 dark:bg-nb-gray-920/80' : 'hover:bg-nb-gray-100/50 dark:hover:bg-nb-gray-910/[0.15]')}>
      {/* When expanded, the orange guide line starts here and runs down through the sub-events. */}
      <td className={cn('px-5 py-4 align-top', open && 'border-l-2 border-netbird/60')}>
        <div className="flex items-start gap-2">
          <ChevronRight size={15} className={cn('mt-0.5 transition-transform', open ? 'rotate-90 text-netbird' : 'text-nb-gray-400')} />
          <div className="flex flex-col gap-0.5">
            <EventHead ev={ev} count={count} />
            <span className="text-sm text-nb-gray-600 dark:text-nb-gray-300"><EventDescription ev={ev} /></span>
          </div>
        </div>
      </td>
      <td className="px-5 py-4"><PeerCell name={ev.source_name || ev.source_dns_label || 'Unknown'} addr={ev.source_addr || '-'} fields={srcFields(ev, usersMap)} peerId={srcPeerId(ev)} /></td>
      <td className="px-5 py-4"><ProtocolBadge cls={getProtocol(ev.protocol, ev).cls} label={getProtocol(ev.protocol, ev).label} icmpLabel={getProtocol(ev.protocol, ev).icmpLabel} port={ev.destination_port} /></td>
      <td className="px-5 py-4"><PeerCell name={ev.destination_name || ev.destination_dns_label || 'Unknown'} addr={ev.destination_addr || '-'} fields={dstFields(ev)} icon={destIcon(ev)} peerId={dstPeerId(ev)} /></td>
      <td className="px-5 py-4"><TrafficCell rx={rx} tx={tx} /></td>
      {showRouter && <RouterCell ev={ev} usersMap={usersMap} />}
    </tr>
  );
}

// ─── Mobile cards (md:hidden) - the same data the table shows, stacked ───
function MobilePeer({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5">
      <div className="mb-1.5 text-[0.6rem] font-medium uppercase tracking-wide text-nb-gray-400 dark:text-nb-gray-500">{label}</div>
      {children}
    </div>
  );
}

function EventCardBody({ ev, usersMap, traffic, showRouter }: {
  ev: LogEvent; usersMap: Record<string, UserRef>; traffic: React.ReactNode; showRouter: boolean;
}) {
  const proto = getProtocol(ev.protocol, ev);
  const routed = ev.destination_type === 'HOST_RESOURCE';
  const routerName = ev.reporter_name || '';
  const routerEmail = (ev.user_id && usersMap[ev.user_id]?.email) || '';
  return (
    <>
      <span className="block text-sm text-nb-gray-600 dark:text-nb-gray-300"><EventDescription ev={ev} /></span>
      <div className="mt-2.5 rounded-md border border-nb-gray-100 dark:border-nb-gray-900 divide-y divide-nb-gray-100 dark:divide-nb-gray-900">
        <MobilePeer label="Source">
          <PeerCell name={ev.source_name || ev.source_dns_label || 'Unknown'} addr={ev.source_addr || '-'} fields={srcFields(ev, usersMap)} peerId={srcPeerId(ev)} />
        </MobilePeer>
        <MobilePeer label="Destination">
          <PeerCell name={ev.destination_name || ev.destination_dns_label || 'Unknown'} addr={ev.destination_addr || '-'} fields={dstFields(ev)} icon={destIcon(ev)} peerId={dstPeerId(ev)} />
        </MobilePeer>
      </div>
      <div className="mt-2.5 flex items-start justify-between gap-3 flex-wrap">
        <ProtocolBadge cls={proto.cls} label={proto.label} icmpLabel={proto.icmpLabel} port={ev.destination_port} />
        {traffic}
      </div>
      {showRouter && routed && (routerName || routerEmail) && (
        <div className="mt-2.5 flex items-center gap-2">
          <span className="text-[0.6rem] font-medium uppercase tracking-wide text-nb-gray-400 dark:text-nb-gray-500">Router</span>
          <StatusDotSmall start />
          {ev.reporter_id
            ? <Link to={`/peers/${encodeURIComponent(ev.reporter_id)}`} onClick={(e) => e.stopPropagation()} className="text-sm text-nb-gray-700 dark:text-nb-gray-200 truncate hover:text-netbird hover:underline">{routerName || routerEmail}</Link>
            : <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200 truncate">{routerName || routerEmail}</span>}
        </div>
      )}
    </>
  );
}

function EventCard({ ev, usersMap, onRaw, showRouter, sub }: {
  ev: LogEvent; usersMap: Record<string, UserRef>; onRaw: (e: LogEvent) => void; showRouter: boolean; sub?: boolean;
}) {
  return (
    <div className={cn(sub ? 'p-3.5' : 'rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5')}>
      <div className="flex items-center justify-between gap-2">
        <EventHead ev={ev} />
        <button onClick={() => onRaw(ev)} title="View raw" className="text-nb-gray-400 hover:text-netbird shrink-0">
          <Code2 size={15} />
        </button>
      </div>
      <div className="mt-2">
        <EventCardBody ev={ev} usersMap={usersMap} showRouter={showRouter} traffic={<TrafficCell rx={ev.rx_bytes} tx={ev.tx_bytes} />} />
      </div>
    </div>
  );
}
