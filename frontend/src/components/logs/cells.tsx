import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Monitor, Copy, Check, ArrowDown, ArrowUp, Share2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { getServiceName, formatBytes, type ProtoClass } from '@/lib/logfmt';
import type { LogEvent } from '@/lib/types';

// NetBird "gray" Badge.
const grayBadge =
  'inline-flex items-center gap-1.5 rounded-md border text-[0.75rem] py-1.5 px-3 tracking-wider font-medium whitespace-nowrap ' +
  'bg-nb-gray-100 dark:bg-nb-gray-930/60 border-nb-gray-200 dark:border-nb-gray-800/40 text-nb-gray-600 dark:text-nb-gray-300';

// Protocol & Port - gray protocol badge (Share2 + name) + separate gray port/ICMP badges.
export function ProtocolBadge({ cls, label, icmpLabel, port }: { cls: ProtoClass; label: string; icmpLabel?: string; port?: ReactNode }) {
  const hasPort = port != null && String(port) !== '' && String(port) !== '0';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={cn(grayBadge, cls !== 'icmp' && 'uppercase')}><Share2 size={12} />{label}</span>
      {hasPort && <span className={cn(grayBadge, 'uppercase')}>{port}</span>}
      {icmpLabel && <span className={grayBadge}>{icmpLabel}</span>}
    </div>
  );
}

export function TrafficCell({ rx, tx, raw }: { rx: unknown; tx: unknown; raw?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex flex-col gap-1 text-xs font-medium text-nb-gray-600 dark:text-nb-gray-300">
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <ArrowDown size={15} className="text-sky-500 dark:text-sky-400" /> {formatBytes(rx)}
        </span>
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <ArrowUp size={15} className="text-netbird" /> {formatBytes(tx)}
        </span>
      </div>
      {raw}
    </div>
  );
}

interface TipField { icon: ReactNode; label: string; value?: string }

function CopyValue({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }); }}
      className="text-nb-gray-400 hover:text-netbird shrink-0"
      title="Copy"
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

// The fields box shown on hover. Rendered into a portal (below) so it's never clipped by
// the table's horizontal-scroll container.
function TooltipContent({ items }: { items: TipField[] }) {
  return (
    <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-2xl divide-y divide-nb-gray-100 dark:divide-nb-gray-800/50">
      {items.map((f, i) => (
        <div key={i} className="flex items-center justify-between gap-4 px-3.5 py-2 text-[0.8rem]">
          <span className="inline-flex items-center gap-2.5 text-nb-gray-500 dark:text-nb-gray-400 shrink-0">
            <span className="text-nb-gray-400 dark:text-nb-gray-500">{f.icon}</span>
            {f.label}
          </span>
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-nb-gray-900 dark:text-nb-gray-100 font-medium truncate">{f.value}</span>
            {f.value && <CopyValue value={f.value} />}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PeerCell({ name, addr, fields, icon, peerId }: { name: string; addr: string; fields: (TipField | null)[]; icon?: ReactNode; peerId?: string }) {
  const service = getServiceName(addr);
  const nameCls = 'mb-1 text-[0.85rem] truncate';
  const items = fields.filter(Boolean) as TipField[];

  // Hover popover positioned in a fixed-position portal so it floats above everything and
  // isn't clipped by the table's `overflow-x-auto`. A short close-delay + the popover's own
  // hover keep it open while the pointer moves onto it (so the copy buttons stay usable).
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const W = 300;
  const open = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
    const below = window.innerHeight - r.bottom;
    const above = below < 220 && r.top > below;
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
  };
  const close = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setPos(null), 120); };

  // Icon + name + address - the whole block links to the peer's device page when a peer id
  // is known (source_id / destination_id), so clicking anywhere in the cell navigates there.
  const inner = (
    <>
      <div className="flex items-center justify-center h-9 w-9 rounded-md shrink-0 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500 dark:text-nb-gray-300">
        {icon || <Monitor size={15} />}
      </div>
      <div className="flex flex-col leading-none min-w-0">
        <span className={cn(nameCls, 'text-nb-gray-700 dark:text-nb-gray-100', peerId && 'group-hover/peer:text-netbird group-hover/peer:underline transition-colors')}>{name}</span>
        <span className="flex items-baseline gap-1 min-w-0 text-[0.82rem] text-nb-gray-500 dark:text-nb-gray-400">
          <span className="min-w-0 truncate">{addr}</span>
          {service && <span className="shrink-0 self-start text-[0.6rem] leading-none text-netbird">{service}</span>}
        </span>
      </div>
    </>
  );
  return (
    <div
      ref={ref}
      onMouseEnter={items.length ? open : undefined}
      onMouseLeave={items.length ? close : undefined}
      className="flex min-w-0"
    >
      {peerId ? (
        <Link to={`/peers/${encodeURIComponent(peerId)}`} onClick={(e) => e.stopPropagation()}
          className="group/peer flex flex-1 items-center gap-2.5 min-w-0">
          {inner}
        </Link>
      ) : (
        <div className="flex flex-1 items-center gap-2.5 min-w-0">{inner}</div>
      )}
      {pos && createPortal(
        <div
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: W, transform: pos.above ? 'translateY(-100%)' : undefined }}
          onMouseEnter={open}
          onMouseLeave={close}
          className="z-[1100]"
        >
          <TooltipContent items={items} />
        </div>,
        document.body,
      )}
    </div>
  );
}

export function EventDescription({ ev }: { ev: LogEvent }) {
  const isStart = ev.message === 'TYPE_START';
  const action = isStart ? 'requested connection to' : 'stopped connection to';
  const srcName = ev.source_name || ev.source_dns_label || 'Unknown';
  const dstAddr = ev.destination_addr || '';
  const dstName = ev.destination_name || '';
  const peer = <span className="text-nb-gray-700 dark:text-nb-gray-300 font-medium">{srcName}</span>;

  if (ev.destination_type === 'HOST_RESOURCE' && dstName) {
    const res = <span className="text-netbird font-medium">{dstName}</span>;
    return isStart
      ? <>Routing peer {peer} received connection to Resource {res}</>
      : <>Peer {peer} {action} {res}</>;
  }
  const target = dstAddr || dstName || 'unknown';
  return <>Peer {peer} {action} {target}</>;
}
