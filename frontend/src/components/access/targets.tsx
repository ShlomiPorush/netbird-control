import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Network as NetworkIcon, Share2, FolderGit2, Layers, Tag, Boxes, Hash, Copy, Check, MonitorSmartphone } from 'lucide-react';
import { Badge } from '@/components/ui';
import { useNetworks } from '@/lib/queries';
import { useViewer } from '@/contexts/ViewerContext';
import type { GrantTarget, GrantTargetType } from '@/lib/types';

export const TARGET_META: Record<GrantTargetType, { icon: ReactNode; label: string }> = {
  network: { icon: <NetworkIcon size={13} />, label: 'Network' },
  resource: { icon: <Share2 size={13} />, label: 'Resource' },
  group: { icon: <FolderGit2 size={13} />, label: 'Group' },
  profile: { icon: <Layers size={13} />, label: 'Profile' },
  peer: { icon: <MonitorSmartphone size={13} />, label: 'Device' },
};

// Where a chip links to. Resources open in their network's Resources tab (same deep-link a
// group's Resources tab uses); a network opens its detail. Group/profile detail is admin-only,
// so those only link for admins (non-admins get a plain, tooltip-only chip).
function targetHref(t: GrantTarget, canAdmin: boolean): string | null {
  if (t.type === 'resource' && t.networkId) return `/networks/${encodeURIComponent(t.networkId)}?tab=resources&resource=${encodeURIComponent(t.id)}`;
  if (t.type === 'network') return `/networks/${encodeURIComponent(t.id)}`;
  if (t.type === 'peer') return `/peers/${encodeURIComponent(t.id)}`;
  if (t.type === 'group' && canAdmin) return `/groups/${encodeURIComponent(t.id)}`;
  if (t.type === 'profile' && canAdmin) return '/operations?tab=profiles';
  return null;
}

export function TargetChips({ targets }: { targets: GrantTarget[] }) {
  const networks = useNetworks().data || [];
  const { restricted } = useViewer();
  const netName = (id?: string) => (id ? networks.find((n) => n.id === id)?.name || '' : '');
  if (!targets?.length) return <span className="text-nb-gray-400 text-sm">-</span>;
  return (
    <div className="flex flex-wrap gap-1.5 max-w-[360px]">
      {targets.map((t, i) => <TargetChip key={`${t.type}-${t.id}-${i}`} t={t} netName={netName} canAdmin={!restricted} />)}
    </div>
  );
}

interface TipField { icon: ReactNode; label: string; value?: string }

function TargetChip({ t, netName, canAdmin }: { t: GrantTarget; netName: (id?: string) => string; canAdmin: boolean }) {
  const meta = TARGET_META[t.type];
  const href = targetHref(t, canAdmin);

  const fields: TipField[] = [
    { icon: <Tag size={13} />, label: 'Name', value: t.name || t.id },
    { icon: <Boxes size={13} />, label: 'Type', value: meta?.label },
    t.type === 'resource' && t.networkId ? { icon: <NetworkIcon size={13} />, label: 'Network', value: netName(t.networkId) || t.networkId } : null,
    t.type === 'resource' && t.resourceType ? { icon: <Share2 size={13} />, label: 'Kind', value: t.resourceType.replace(/_/g, ' ') } : null,
    t.access ? {
      icon: <Share2 size={13} />, label: 'Granted Ports',
      value: [
        t.access.tcp ? `TCP ${t.access.tcp.length ? t.access.tcp.join(', ') : 'all'}` : '',
        t.access.udp ? `UDP ${t.access.udp.length ? t.access.udp.join(', ') : 'all'}` : '',
        t.access.icmp ? 'ICMP' : '',
      ].filter(Boolean).join(' · '),
    } : null,
    { icon: <Hash size={13} />, label: 'ID', value: t.id },
  ].filter(Boolean) as TipField[];

  // Hover popover in a fixed-position portal (never clipped by a table's overflow), matching the
  // events page. Short close-delay + the popover's own hover keep it open while moving onto it.
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const W = 260;
  const open = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
    const below = window.innerHeight - r.bottom;
    const above = below < 200 && r.top > below;
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
  };
  const close = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setPos(null), 120); };

  const chip = (
    <Badge tone="cyan" icon={meta?.icon} className={href ? 'cursor-pointer' : 'cursor-default'}>
      {t.name || t.id}
    </Badge>
  );

  return (
    <span ref={ref} onMouseEnter={open} onMouseLeave={close} className="inline-flex">
      {href ? <Link to={href} onClick={(e) => e.stopPropagation()}>{chip}</Link> : chip}
      {pos && createPortal(
        <div style={{ position: 'fixed', left: pos.left, top: pos.top, width: W, transform: pos.above ? 'translateY(-100%)' : undefined }}
          onMouseEnter={open} onMouseLeave={close} className="z-1100">
          <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-2xl divide-y divide-nb-gray-100 dark:divide-nb-gray-800/50">
            {fields.map((f, i) => (
              <div key={i} className="flex items-center justify-between gap-4 px-3.5 py-2 text-[0.8rem]">
                <span className="inline-flex items-center gap-2.5 text-nb-gray-500 dark:text-nb-gray-400 shrink-0">
                  <span className="text-nb-gray-400 dark:text-nb-gray-500">{f.icon}</span>{f.label}
                </span>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-nb-gray-900 dark:text-nb-gray-100 font-medium truncate">{f.value || '-'}</span>
                  {f.value && <CopyValue value={f.value} />}
                </span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

function CopyValue({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }); }}
      className="text-nb-gray-400 hover:text-netbird shrink-0" title="Copy">
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
