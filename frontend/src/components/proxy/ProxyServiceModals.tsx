import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Globe, Server, Container, CheckCircle2, AlertTriangle, ArrowRight, MoreVertical, Pencil,
  MinusCircle, Plus, PlusCircle, LockKeyhole, ShieldCheck, Settings as SettingsIcon,
  Network as NetworkIcon, Users as UsersIcon, RectangleEllipsis, Binary, FileCode2,
  Flag, Workflow, ShieldX, Monitor, Share2, ChevronDown, ChevronRight, ChevronsUpDown,
  ArrowUpRight, SearchIcon, X as XIcon, CircleUser, KeyRound, Braces, User as UserIcon2,
  CornerDownLeft,
} from 'lucide-react';
import { FaWindows, FaApple } from 'react-icons/fa6';
import { FcAndroidOs, FcLinux } from 'react-icons/fc';
import {
  useAppConfig, useProxyDomains, useNetworks, useNetworkDetail, useProxyServiceDetail,
  useGroups, useCountries, useProxyTargetOptions, usePeers,
} from '@/lib/queries';
import { useCreateProxyService, useExposeDocker, useUpdateProxyService } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import { registerPopup } from '@/lib/popupBus';
import type { ProxyCluster, ProxyDomain, ProxyTargetInput, EditableProxyTarget, EditableProxyService, UpdateProxyServiceInput } from '@/lib/types';
import { Modal, Tabs, FieldHint, Label, Input, SelectMenu, Button, Checkbox, GroupMultiSelect, Badge } from '@/components/ui';
import { cn } from '@/lib/cn';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// ─── Layout helpers: stacked label+hint blocks and label-left / control-right rows ───
function Block({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-0.5">
        <Label>{label}</Label>
        {hint && <FieldHint>{hint}</FieldHint>}
      </div>
      {children}
    </div>
  );
}
function SideRow({ label, hint, extra, children }: { label: React.ReactNode; hint?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-10">
      <div className="flex flex-col gap-0.5 min-w-0">
        <Label>{label}</Label>
        {hint && <FieldHint>{hint}</FieldHint>}
        {extra}
      </div>
      <div className="w-full sm:w-[260px] shrink-0">{children}</div>
    </div>
  );
}

// ─── Anchored dropdown base (portal + fixed position + single-popup coordination) ───
function useAnchoredPanel() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0 });
  useEffect(() => { if (open) return registerPopup(() => setOpen(false)); }, [open]);
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current; if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom, width: r.width });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, triggerRef, panelRef, pos };
}

const PANEL_CLS = 'rounded-md border border-neutral-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-950 shadow-lg shadow-nb-gray-950 overflow-hidden';

// ─── PlainSelect: compact dropdown with plain rows (no checkboxes) - official SelectDropdown ───
function PlainSelect({ value, onChange, options, className, disabled, joined }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: React.ReactNode }[];
  className?: string;
  disabled?: boolean;
  /** 'left' | 'right' | 'middle' - which side of a joined group this trigger sits on. */
  joined?: 'left' | 'right' | 'middle';
}) {
  const { open, setOpen, triggerRef, panelRef, pos } = useAnchoredPanel();
  const sel = options.find((o) => o.value === value);
  return (
    <>
      <button type="button" ref={triggerRef as React.RefObject<HTMLButtonElement>} disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          'min-h-[44px] w-full flex items-center justify-between gap-2 border px-3 py-2 text-sm transition-all',
          'border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40',
          joined === 'left' ? 'rounded-l-md' : joined === 'right' ? 'rounded-r-md border-l-0!' : joined === 'middle' ? 'border-l-0!' : 'rounded-md',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer dark:hover:bg-nb-gray-900/50',
          className,
        )}>
        <span className={cn('truncate', sel ? 'text-nb-gray-800 dark:text-nb-gray-200' : 'text-neutral-500 dark:text-nb-gray-400/70')}>{sel?.label || 'Select…'}</span>
        <ChevronsUpDown size={16} className="shrink-0 text-nb-gray-400" />
      </button>
      {open && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', left: pos.left, top: pos.top + 6, minWidth: Math.max(pos.width, 130), zIndex: 1100 }} className={PANEL_CLS}>
          <div className="flex flex-col p-1.5 gap-0.5">
            {options.map((o) => (
              <button key={o.value} type="button" onClick={() => { onChange(o.value); setOpen(false); }}
                className={cn('flex items-center gap-2 px-2.5 py-2 rounded-md text-sm text-left whitespace-nowrap transition-colors',
                  o.value === value ? 'bg-nb-gray-100 dark:bg-nb-gray-910 text-nb-gray-900 dark:text-nb-gray-100' : 'text-nb-gray-700 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-910')}>
                {o.label}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ─── Shared dropdown search bar (with the official ⏎ hint badge) ───
function PanelSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative border-b border-neutral-200 dark:border-nb-gray-700">
      <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="min-h-[42px] w-full bg-transparent text-sm outline-hidden font-light dark:text-nb-gray-100 dark:placeholder:text-nb-gray-400 placeholder:text-neutral-500 pl-10 pr-12" />
      <div className="absolute left-0 top-0 h-full flex items-center pl-4 text-nb-gray-400"><SearchIcon size={14} /></div>
      <div className="absolute right-3 top-0 h-full flex items-center">
        <span className="flex items-center rounded-[4px] border border-nb-gray-300 dark:border-nb-gray-500 bg-nb-gray-100 dark:bg-nb-gray-800 px-1.5 py-1 text-nb-gray-500 dark:text-nb-gray-300">
          <CornerDownLeft size={10} />
        </span>
      </div>
    </div>
  );
}

// ─── CountrySelect: searchable country dropdown with round SVG flags (official RoundedFlag) ───
function RoundedFlag({ cc, size = 20 }: { cc: string; size?: number }) {
  return (
    <span className="shrink-0 overflow-hidden rounded-full shadow-xl inline-flex" style={{ width: size, height: size }}>
      <img src={`/flags/4x3/${cc.toLowerCase()}.svg`} alt={cc} className="h-full w-full object-cover"
        onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
    </span>
  );
}

function CountrySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { open, setOpen, triggerRef, panelRef, pos } = useAnchoredPanel();
  const countries = useCountries().data || [];
  const [search, setSearch] = useState('');
  useEffect(() => { if (!open) setSearch(''); }, [open]);
  const q = search.toLowerCase().trim();
  const rows = countries.filter((c) => !q || c.country_name.toLowerCase().includes(q) || c.country_code.toLowerCase().includes(q));
  const sel = countries.find((c) => c.country_code === value);
  return (
    <>
      <button type="button" ref={triggerRef as React.RefObject<HTMLButtonElement>} onClick={() => setOpen((o) => !o)}
        className="min-h-[44px] w-full flex items-center justify-between gap-2 rounded-r-md border border-l-0! border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 px-3 py-2 text-sm cursor-pointer dark:hover:bg-nb-gray-900/50 transition-all">
        <span className={cn('truncate flex items-center gap-2', sel ? 'text-nb-gray-800 dark:text-nb-gray-200' : 'text-neutral-500 dark:text-nb-gray-400/70')}>
          {sel ? <><RoundedFlag cc={sel.country_code} size={18} /><span className="truncate">{sel.country_name} ({sel.country_code})</span></> : 'Select country...'}
        </span>
        <ChevronsUpDown size={16} className="shrink-0 text-nb-gray-400" />
      </button>
      {open && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', left: pos.left, top: pos.top + 6, width: Math.max(pos.width, 280), zIndex: 1100 }} className={PANEL_CLS}>
          <PanelSearch value={search} onChange={setSearch} placeholder="Search country..." />
          <div className="nb-scroll max-h-[300px] overflow-y-auto flex flex-col gap-1 p-2">
            {rows.map((c) => (
              <button key={c.country_code} type="button" onClick={() => { onChange(c.country_code); setOpen(false); }}
                className={cn('flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-sm text-left transition-colors',
                  c.country_code === value ? 'bg-nb-gray-100 dark:bg-nb-gray-910' : 'hover:bg-nb-gray-100 dark:hover:bg-nb-gray-910')}>
                <RoundedFlag cc={c.country_code} />
                <span className="truncate text-nb-gray-800 dark:text-nb-gray-200">{c.country_name} ({c.country_code})</span>
              </button>
            ))}
            {!rows.length && <div className="px-3 py-3 text-xs text-nb-gray-500">No countries found</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ─── DomainSelect: the official CustomDomainSelector - search, .domain rows with badges ───
function SmallBadge({ text, tone }: { text: string; tone: 'sky' | 'green' }) {
  return (
    <span className={cn('px-1.5 py-0.5 rounded-sm text-[0.65rem] font-medium border shrink-0',
      tone === 'sky' ? 'bg-sky-950/60 border-sky-500/40 text-sky-300' : 'bg-green-950 border-green-500/40 text-green-400')}>
      {text}
    </span>
  );
}

function DomainSelect({ domains, clusters, value, onChange }: {
  domains: ProxyDomain[];
  clusters: ProxyCluster[];
  value: string;
  onChange: (domain: string) => void;
}) {
  const { open, setOpen, triggerRef, panelRef, pos } = useAnchoredPanel();
  const [search, setSearch] = useState('');
  useEffect(() => { if (!open) setSearch(''); }, [open]);
  const isAccount = (d: ProxyDomain) => clusters.some((c) => c.address === (d.cluster || d.domain) && c.private);
  const q = search.toLowerCase().trim();
  const free = domains.filter((d) => d.type === 'free' && (!q || d.domain.includes(q)));
  const custom = domains.filter((d) => d.type === 'custom' && d.validated && (!q || d.domain.includes(q)));
  const row = (d: ProxyDomain) => (
    <button key={d.id || d.domain} type="button" onClick={() => { onChange(d.domain); setOpen(false); }}
      className={cn('flex items-center justify-between gap-2 w-full px-3 py-2 rounded-md text-sm text-left transition-colors',
        d.domain === value ? 'bg-nb-gray-100 dark:bg-nb-gray-910' : 'hover:bg-nb-gray-100 dark:hover:bg-nb-gray-910')}>
      <span className="truncate text-nb-gray-800 dark:text-nb-gray-200">.{d.domain}</span>
      {d.type === 'custom'
        ? <SmallBadge text="Custom" tone="sky" />
        : isAccount(d) ? <SmallBadge text="Account" tone="sky" /> : <SmallBadge text="Free" tone="green" />}
    </button>
  );
  return (
    <>
      <button type="button" ref={triggerRef as React.RefObject<HTMLButtonElement>} onClick={() => setOpen((o) => !o)}
        className="min-h-[44px] w-full flex items-center justify-between gap-2 rounded-r-md border border-l-0! border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 px-3 py-2 text-sm cursor-pointer dark:hover:bg-nb-gray-900/50 transition-all">
        <span className={cn('truncate', value ? 'text-nb-gray-800 dark:text-nb-gray-200' : 'text-neutral-500 dark:text-nb-gray-400/70')}>
          {value ? `.${value}` : 'Select domain...'}
        </span>
        <ChevronsUpDown size={16} className="shrink-0 text-nb-gray-400" />
      </button>
      {open && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', left: Math.min(pos.left, window.innerWidth - 388), top: pos.top + 6, width: 380, zIndex: 1100 }} className={PANEL_CLS}>
          <PanelSearch value={search} onChange={setSearch} placeholder="Search domains..." />
          <div className="nb-scroll max-h-[260px] overflow-y-auto flex flex-col gap-1 p-2">
            {free.map(row)}
            {custom.map(row)}
            {!free.length && !custom.length && <div className="px-3 py-3 text-xs text-nb-gray-500">No domains found</div>}
            <div title="Custom domains are added in your NetBird dashboard under Reverse Proxy - Custom Domains. Once validated they appear here."
              className="flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm text-netbird cursor-help hover:bg-nb-gray-100 dark:hover:bg-nb-gray-910 transition-colors">
              <span>Add Custom Domain</span>
              <ArrowUpRight size={16} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ─── TargetPicker: the official selector - search + Peers/Resources/Proxy Clusters tabs ───
// The official PeerOperatingSystemIcon: real OS logos, desaturated to gray.
function PeerOsIcon({ os }: { os: string }) {
  const o = (os || '').toLowerCase();
  const win = o.includes('windows');
  const mac = o.includes('darwin') || o.includes('mac') || o.includes('ios') || o.includes('iphone') || o.includes('ipad');
  const icon = win ? <FaWindows className="text-nb-gray-600 dark:text-white text-base" />
    : mac ? <FaApple className="text-nb-gray-600 dark:text-white text-base" />
      : o.includes('android') ? <FcAndroidOs className="text-nb-gray-600 dark:text-white text-2xl brightness-200" />
        : <FcLinux className="text-nb-gray-600 dark:text-white text-2xl brightness-150" />;
  return (
    <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center grayscale contrast-40', win && 'p-[2.5px]', mac && 'p-[2.7px]')}>
      {icon}
    </span>
  );
}

// The official RadioItem: 20px circle, netbird fill + white dot when selected.
function RadioCircle({ selected }: { selected: boolean }) {
  return (
    <span className={cn('relative h-5 w-5 shrink-0 rounded-full border',
      selected ? 'bg-netbird border-netbird' : 'bg-white dark:bg-nb-gray-950 border-neutral-300 dark:border-nb-gray-900')}>
      {selected && <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-white" />}
    </span>
  );
}

export interface TargetPick {
  kind: 'peer' | 'resource' | 'cluster' | 'container';
  refId: string;
  refLabel: string;
  resolvedHost: string;
  targetType: string;
  os?: string;
  /** Container picks only: the network whose routing peer resolves the container's DNS name. */
  networkId?: string;
}

function TargetPicker({ value, onChange, clusters }: {
  value: TargetPick | null;
  onChange: (v: TargetPick | null) => void;
  clusters: ProxyCluster[];
}) {
  const { open, setOpen, triggerRef, panelRef, pos } = useAnchoredPanel();
  const opts = useProxyTargetOptions().data;
  const [tab, setTab] = useState<'peers' | 'resources' | 'clusters' | 'containers'>('peers');
  const [search, setSearch] = useState('');
  useEffect(() => { if (!open) setSearch(''); }, [open]);

  const q = search.toLowerCase().trim();
  const peers = (opts?.peers || []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.ip.includes(q));
  const resources = (opts?.resources || []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.address.toLowerCase().includes(q) || r.network.toLowerCase().includes(q));
  const clusterRows = clusters.filter((c) => !q || c.address.toLowerCase().includes(q));

  const pick = (v: TargetPick) => { onChange(v); setOpen(false); };
  const isSel = (v: TargetPick) => !!value && value.kind === v.kind && (v.kind === 'cluster' ? value.refLabel === v.refLabel : value.refId === v.refId);
  const kindIcon = value?.kind === 'peer' ? <PeerOsIcon os={value.os || ''} />
    : value?.kind === 'resource' ? <Share2 size={12} />
    : value?.kind === 'container' ? <Container size={12} />
    : <Server size={12} />;

  const tabBtn = (k: typeof tab, icon: React.ReactNode, label: string) => (
    <button type="button" onClick={() => setTab(k)}
      className={cn('inline-flex items-center gap-1.5 px-3 py-2 text-[0.82rem] font-medium border-b-2 -mb-px transition-colors',
        tab === k ? 'text-netbird border-netbird' : 'text-nb-gray-500 border-transparent hover:text-nb-gray-700 dark:hover:text-nb-gray-300')}>
      {icon} {label}
    </button>
  );

  const itemRow = (key: string, icon: React.ReactNode, name: string, right: string, v: TargetPick) => (
    <button key={key} type="button" onClick={() => pick(v)}
      className="flex items-center justify-between gap-3 w-full px-2 py-[7px] rounded-md text-left hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800/20 transition-colors">
      <span className="inline-flex items-center h-7 gap-2 rounded-md border border-nb-gray-200 dark:border-nb-gray-800/50 bg-nb-gray-100 dark:bg-nb-gray-900 px-2 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-300 min-w-0">
        {icon}
        <span className="truncate max-w-[270px]">{name}</span>
      </span>
      <span className="inline-flex items-center gap-2 shrink-0 text-sm font-medium text-neutral-500 dark:text-nb-gray-300">
        {right}
        <RadioCircle selected={isSel(v)} />
      </span>
    </button>
  );

  return (
    <>
      <div ref={triggerRef as React.RefObject<HTMLDivElement>} onClick={() => setOpen((o) => !o)}
        className="min-h-[46px] w-full flex items-center justify-between gap-2 rounded-md border border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 px-3 py-2 text-sm cursor-pointer dark:hover:bg-nb-gray-900/50 transition-all">
        {value ? (
          <span className="inline-flex items-center h-7 gap-2 rounded-md border border-nb-gray-200 dark:border-nb-gray-800/50 bg-nb-gray-100 dark:bg-nb-gray-900 px-2 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-300"
            onClick={(e) => e.stopPropagation()}>
            {kindIcon}
            <span className="truncate max-w-[260px]">{value.refLabel}</span>
            <button type="button" className="text-nb-gray-400 hover:text-red-500" onClick={() => onChange(null)}><XIcon size={12} /></button>
          </span>
        ) : (
          <span className="text-neutral-500 dark:text-nb-gray-400/70">{clusters.length ? 'Select a peer, resource, proxy cluster or container...' : 'Select a peer, resource or container...'}</span>
        )}
        <ChevronsUpDown size={16} className="shrink-0 text-nb-gray-400" />
      </div>
      {open && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', left: pos.left, top: pos.top + 6, width: pos.width, zIndex: 1100 }} className={PANEL_CLS}>
          {tab !== 'containers' && (
            <PanelSearch value={search} onChange={setSearch}
              placeholder={tab === 'peers' ? 'Search peer by name or ip...' : tab === 'resources' ? 'Search resource by name or address...' : 'Search clusters...'} />
          )}
          <div className="flex items-center gap-1 px-2 border-b border-neutral-200 dark:border-nb-gray-800">
            {tabBtn('peers', <Monitor size={13} />, 'Peers')}
            {tabBtn('resources', <Share2 size={13} />, 'Resources')}
            {clusters.length > 0 && tabBtn('clusters', <Server size={13} />, 'Proxy Clusters')}
            {tabBtn('containers', <Container size={13} />, 'Container')}
          </div>
          <div className="nb-scroll max-h-[240px] overflow-y-auto flex flex-col gap-1 p-2">
            {tab === 'peers' && (peers.length
              ? peers.map((p) => itemRow(`p-${p.id}`, <PeerOsIcon os={p.os} />, p.name, p.ip,
                { kind: 'peer', refId: p.id, refLabel: p.name, resolvedHost: p.dns || p.ip, targetType: 'peer', os: p.os }))
              : <div className="px-4 py-5 text-center text-xs text-nb-gray-500 max-w-sm mx-auto">{q ? 'There are no peers matching your search. Please try a different search term.' : 'There are no peers available yet.'}</div>)}
            {tab === 'resources' && (resources.length
              ? resources.map((r) => itemRow(`r-${r.id}`,
                r.type === 'domain' ? <Globe size={12} className="shrink-0 text-nb-gray-400" /> : r.type === 'subnet' ? <NetworkIcon size={12} className="shrink-0 text-nb-gray-400" /> : <Workflow size={12} className="shrink-0 text-nb-gray-400" />,
                r.name, r.address,
                { kind: 'resource', refId: r.id, refLabel: r.name, resolvedHost: r.address, targetType: ['host', 'domain', 'subnet'].includes(r.type) ? r.type : 'host' }))
              : <div className="px-4 py-5 text-center text-xs text-nb-gray-500 max-w-sm mx-auto">{q ? 'There are no resources matching your search. Please try a different search term.' : 'There are no resources available yet.'}</div>)}
            {tab === 'clusters' && (clusterRows.length
              ? clusterRows.map((c) => itemRow(`c-${c.address}`, <Server size={12} className="shrink-0 text-nb-gray-400" />, c.address, '',
                { kind: 'cluster', refId: c.address, refLabel: c.address, resolvedHost: '', targetType: 'cluster' }))
              : <div className="px-4 py-5 text-center text-xs text-nb-gray-500 max-w-sm mx-auto">No proxy clusters available.</div>)}
            {/* One pick-row only - the network + DNS form lives in the MODAL BODY (like the
                cluster host field), where there's room and a normal SelectMenu works. */}
            {tab === 'containers' && itemRow('container', <Container size={12} className="shrink-0 text-nb-gray-400" />,
              'Docker Container', 'by DNS name',
              { kind: 'container', refId: '', refLabel: 'Docker Container', resolvedHost: '', targetType: 'container' })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// Single-select NETWORK picker in the exact same anchored-panel style as the target picker
// (trigger field → portal panel with search + chip rows + radio) - the app-wide picker look.
function NetworkPickerField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { open, setOpen, triggerRef, panelRef, pos } = useAnchoredPanel();
  const networks = useNetworks().data || [];
  const [search, setSearch] = useState('');
  useEffect(() => { if (!open) setSearch(''); }, [open]);
  const q = search.toLowerCase().trim();
  const rows = networks.filter((n) => !q || (n.name || n.id).toLowerCase().includes(q));
  const sel = networks.find((n) => n.id === value);
  return (
    <>
      <div ref={triggerRef as React.RefObject<HTMLDivElement>} onClick={() => setOpen((o) => !o)}
        className="min-h-[46px] w-full flex items-center justify-between gap-2 rounded-md border border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 px-3 py-2 text-sm cursor-pointer dark:hover:bg-nb-gray-900/50 transition-all">
        {sel ? (
          <span className="inline-flex items-center h-7 gap-2 rounded-md border border-nb-gray-200 dark:border-nb-gray-800/50 bg-nb-gray-100 dark:bg-nb-gray-900 px-2 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-300"
            onClick={(e) => e.stopPropagation()}>
            <NetworkIcon size={12} className="shrink-0 text-nb-gray-400" />
            <span className="truncate max-w-[260px]">{sel.name || sel.id}</span>
            <button type="button" className="text-nb-gray-400 hover:text-red-500" onClick={() => onChange('')}><XIcon size={12} /></button>
          </span>
        ) : (
          <span className="text-neutral-500 dark:text-nb-gray-400/70">Select the network of the Docker host...</span>
        )}
        <ChevronsUpDown size={16} className="shrink-0 text-nb-gray-400" />
      </div>
      {open && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', left: pos.left, top: pos.top + 6, width: pos.width, zIndex: 1100 }} className={PANEL_CLS}>
          <PanelSearch value={search} onChange={setSearch} placeholder="Search networks..." />
          <div className="nb-scroll max-h-[240px] overflow-y-auto flex flex-col gap-1 p-2">
            {rows.length ? rows.map((n) => (
              <button key={n.id} type="button" onClick={() => { onChange(n.id); setOpen(false); }}
                className="flex items-center justify-between gap-3 w-full px-2 py-[7px] rounded-md text-left hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800/20 transition-colors">
                <span className="inline-flex items-center h-7 gap-2 rounded-md border border-nb-gray-200 dark:border-nb-gray-800/50 bg-nb-gray-100 dark:bg-nb-gray-900 px-2 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-300 min-w-0">
                  <NetworkIcon size={12} className="shrink-0 text-nb-gray-400" />
                  <span className="truncate max-w-[270px]">{n.name || n.id}</span>
                </span>
                <RadioCircle selected={value === n.id} />
              </button>
            )) : <div className="px-4 py-5 text-center text-xs text-nb-gray-500 max-w-sm mx-auto">{q ? 'There are no networks matching your search.' : 'No networks available.'}</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ─── Domain draft: subdomain + selected base domain (cluster derives from the base) ───
export interface DomainDraft { sub: string; base: string }
export const emptyDomain: DomainDraft = { sub: '', base: '' };

function domainEntry(domains: ProxyDomain[], base: string) {
  return domains.find((d) => d.domain === base);
}
export function composeDomain(d: DomainDraft, domains: ProxyDomain[]): string {
  if (!d.base) return '';
  const entry = domainEntry(domains, d.base);
  if (entry?.requireSubdomain && !d.sub.trim()) return '';
  // Subdomain is optional (unless the domain requires one) - empty uses the domain directly.
  return d.sub.trim() ? `${d.sub.trim().toLowerCase()}.${d.base}` : d.base;
}
// The cluster is DERIVED from the chosen domain, exactly like the official dashboard.
export function clusterForDomain(domains: ProxyDomain[], clusters: ProxyCluster[], base: string, fallback: string): string {
  const entry = domainEntry(domains, base);
  if (entry?.cluster) return entry.cluster;
  if (entry?.type === 'free' && clusters.some((c) => c.address === entry.domain)) return entry.domain;
  return fallback || clusters[0]?.address || '';
}

function DomainField({ value, onChange, domains, clusters }: {
  value: DomainDraft;
  onChange: (d: DomainDraft) => void;
  domains: ProxyDomain[];
  clusters: ProxyCluster[];
}) {
  const appCfg = useAppConfig().data;
  // Default base: the domain chosen in Settings - General, else the first one.
  useEffect(() => {
    if (value.base || !domains.length) return;
    const preferred = appCfg?.proxyDefaultDomain
      ? domains.find((d) => d.domain === appCfg.proxyDefaultDomain)
      : undefined;
    onChange({ ...value, base: (preferred || domains[0]).domain });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domains, appCfg?.proxyDefaultDomain]);
  const entry = domainEntry(domains, value.base);
  const required = !!entry?.requireSubdomain;
  return (
    <Block label="Domain" hint={required ? 'Enter a subdomain and select a domain for your service.' : 'Optionally enter a subdomain, or use the domain directly.'}>
      <div className="flex items-stretch min-w-0">
        <Input autoFocus className="flex-1 min-w-0 rounded-r-none!" value={value.sub}
          onChange={(e) => onChange({ ...value, sub: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
          placeholder={required ? 'myapp' : 'myapp (optional)'} />
        <div className="w-[46%] max-w-[280px] shrink-0">
          <DomainSelect domains={domains} clusters={clusters} value={value.base} onChange={(b) => onChange({ ...value, base: b })} />
        </div>
      </div>
    </Block>
  );
}

// ─── Target draft (UI-side) ───
interface TargetDraft {
  kind: 'peer' | 'resource' | 'cluster' | 'container';
  refId: string;
  refLabel: string;
  resolvedHost: string;
  targetType: string;
  protocol: string;
  port: string;
  path: string;
  enabled: boolean;
  skipTlsVerify: boolean;
  preservePath: boolean;
  os?: string;
  networkId?: string;
  /** NetBird v0.81+ per-path access. undefined = never set on this target (nothing is sent). */
  accessAction?: ProxyAccessAction;
}

type ProxyAccessAction = 'inherit' | 'bypass' | 'block';
const normPath = (p: string) => (p.trim() ? (p.trim().startsWith('/') ? p.trim() : `/${p.trim()}`) : '/');

function draftToInput(d: TargetDraft): ProxyTargetInput {
  const hasPath = !!d.path.trim() && d.path.trim() !== '/';
  return {
    type: d.targetType as ProxyTargetInput['type'],
    // Cluster targets need BOTH: the host to dial and the cluster's apex domain as target_id.
    // Container targets carry network + DNS name - the backend creates/reuses the resource.
    ...(d.kind === 'cluster' ? { host: d.resolvedHost.trim(), id: d.refId }
      : d.kind === 'container' ? { networkId: d.networkId, containerDomain: d.resolvedHost.trim() }
        : { id: d.refId }),
    port: parseInt(d.port, 10) || (d.protocol === 'https' ? 443 : 80),
    protocol: d.protocol,
    ...(hasPath ? { path: d.path.trim() } : {}),
    enabled: d.enabled,
    ...(d.skipTlsVerify ? { skipTlsVerify: true } : {}),
    ...(hasPath && d.preservePath ? { preservePath: true } : {}),
    ...(d.accessAction ? { accessAction: d.accessAction } : {}),
  };
}

const destinationLabel = (d: TargetDraft) =>
  `${d.protocol}://${d.resolvedHost || d.refLabel}${d.port ? `:${d.port}` : ''}`;

// ─── Add/Edit Target modal - official field order ───
function TargetModal({ serviceDomain, clusters, existing, taken, isPrivate, isHttp, onSave, onClose }: {
  serviceDomain: string;
  clusters: ProxyCluster[];
  existing: TargetDraft | null;
  /** NetBird-Only service: Bypass is not allowed there (Block is). */
  isPrivate: boolean;
  /** Per-path access actions exist for HTTP services only. */
  isHttp: boolean;
  taken: string[];
  onSave: (d: TargetDraft) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<TargetPick | null>(existing ? {
    kind: existing.kind, refId: existing.refId, refLabel: existing.refLabel,
    resolvedHost: existing.kind === 'cluster' ? '' : existing.resolvedHost, targetType: existing.targetType, os: existing.os,
    networkId: existing.networkId,
  } : null);
  const [host, setHost] = useState(existing?.kind === 'cluster' ? existing.resolvedHost : '');
  // Container form (modal-level - see the picker's containers tab note).
  const [cNetId, setCNetId] = useState(existing?.kind === 'container' ? existing.networkId || '' : '');
  const [cDomain, setCDomain] = useState(existing?.kind === 'container' ? existing.resolvedHost : '');
  const [protocol, setProtocol] = useState(existing?.protocol || 'http');
  const [port, setPort] = useState(existing?.port || '');
  const [path, setPath] = useState(existing?.path || '');
  const [skipTls, setSkipTls] = useState(existing?.skipTlsVerify || false);
  const [preservePath, setPreservePath] = useState(existing?.preservePath || false);
  const [accessAction, setAccessAction] = useState<ProxyAccessAction | undefined>(existing?.accessAction);
  const [optOpen, setOptOpen] = useState(!!existing?.accessAction && existing.accessAction !== 'inherit');
  const [error, setError] = useState('');

  const isCluster = picked?.kind === 'cluster';
  const action: ProxyAccessAction = accessAction || 'inherit';
  // Picking "Use Service Authentication" on a target that never had an action sends nothing.
  const pickAction = (v: string) => setAccessAction(v === 'inherit' && !existing?.accessAction ? undefined : v as ProxyAccessAction);
  const dupPath = (() => {
    const p = path.trim() ? (path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`) : '/';
    return taken.includes(p);
  })();

  const isContainer = picked?.kind === 'container';
  const save = () => {
    setError('');
    if (!picked) { setError('Choose where the proxy should forward incoming requests.'); return; }
    if (isCluster && !host.trim()) { setError('Enter the host the proxy should dial.'); return; }
    if (isContainer && !cNetId) { setError('Choose the network of the Docker host.'); return; }
    if (isContainer && !DOMAIN_RE.test(cDomain.trim().toLowerCase())) { setError('Enter the container DNS name in domain format (e.g. grafana.internal).'); return; }
    const p = port.trim() ? parseInt(port, 10) : (protocol === 'https' ? 443 : 80);
    if (!(p >= 1 && p <= 65535)) { setError('Enter a valid port (1-65535).'); return; }
    if (dupPath) { setError('This location is already used by another target and cannot be added. Please use a different location.'); return; }
    if (isPrivate && action === 'bypass') { setError("Bypass Authentication isn't available on a NetBird-Only service."); return; }
    const containerDomain = cDomain.trim().toLowerCase();
    onSave({
      kind: picked.kind, refId: picked.refId,
      refLabel: isContainer ? containerDomain : picked.refLabel,
      resolvedHost: isCluster ? host.trim() : isContainer ? containerDomain : picked.resolvedHost,
      targetType: picked.targetType, os: picked.os, networkId: isContainer ? cNetId : picked.networkId,
      protocol, port: String(p), path: path.trim(), enabled: existing?.enabled ?? true, skipTlsVerify: protocol === 'https' && skipTls,
      preservePath: preservePath && !!path.trim() && path.trim() !== '/',
      accessAction: isHttp ? accessAction : existing?.accessAction,
    });
    onClose();
  };

  return (
    <Modal open onClose={onClose} size="lg" icon={<Server size={18} />}
      title={existing ? 'Edit Target' : 'Add Target'}
      subtitle="Configure the target for your reverse proxy."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!picked}>
            {existing ? 'Save Changes' : <><PlusCircle size={15} /> Add Target</>}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-6">
        <Block
          label={
            <>
              Select{' '}
              <span className="underline decoration-dotted decoration-nb-gray-500 underline-offset-4 cursor-help"
                title="A peer is a machine (e.g., laptop, server, container) running NetBird. Select a peer if your service runs directly on it.">Peer</span>
              {', '}
              <span className="underline decoration-dotted decoration-nb-gray-500 underline-offset-4 cursor-help"
                title="A resource is a destination (IP, subnet, or domain) that can't run NetBird directly. Resources are part of a network and are reached through a routing peer that forwards traffic to them.">Resource</span>
              {', '}
              <span className="underline decoration-dotted decoration-nb-gray-500 underline-offset-4 cursor-help"
                title="A proxy cluster forwards inbound traffic to an upstream the proxy reaches without WireGuard. Useful for external APIs and services co-located with the proxy.">Proxy Cluster</span>
              {' or '}
              <span className="underline decoration-dotted decoration-nb-gray-500 underline-offset-4 cursor-help"
                title="A Docker container reached by its DNS name through a network's routing peer - a domain resource is created (or reused) for it automatically.">Container</span>
            </>
          }
          hint="Choose where the proxy should forward incoming requests.">
          <TargetPicker value={picked} onChange={setPicked} clusters={clusters} />
        </Block>

        {isContainer && (
          <Block label="Container"
            hint="The network whose routing peer resolves the container's DNS name - a domain resource is created in it (or reused) automatically.">
            <div className="flex flex-col gap-2.5">
              <NetworkPickerField value={cNetId} onChange={setCNetId} />
              <Input value={cDomain} onChange={(e) => setCDomain(e.target.value)} placeholder="Container DNS name, e.g. grafana.internal" />
            </div>
          </Block>
        )}

        <div>
          <Block label="Location (Optional)" hint="Specify an optional path from where requests are routed to your service.">
            <div className="flex items-stretch min-w-0">
              <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 text-sm text-nb-gray-500 whitespace-nowrap max-w-[55%] overflow-hidden text-ellipsis">
                {serviceDomain || 'domain.example.com'}
              </span>
              <span className="w-px bg-neutral-200 dark:bg-nb-gray-700" />
              <Input className="flex-1 min-w-0 rounded-l-none! border-l-0!" value={path} disabled={!picked}
                onChange={(e) => { const v = e.target.value; setPath(v && !v.startsWith('/') ? `/${v}` : v); }}
                placeholder="/" />
            </div>
          </Block>
          {dupPath && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[0.8rem] text-nb-gray-700 dark:text-nb-gray-300">
              <AlertTriangle size={14} className="text-amber-500 shrink-0" />
              This location is already used by another target and cannot be added. Please use a different location.
            </div>
          )}
          {/* Official "Preserve Full Path" toggle - only meaningful when a location is set:
              off = the matched prefix is stripped (/docs/users → /users), on = kept as-is. */}
          {path.trim() && path.trim() !== '/' && picked && !dupPath && (
            <div className="mt-3">
              <ToggleRow icon={<CornerDownLeft size={15} />} label="Preserve Full Path"
                help={`Keep the original full request path when forwarding (${path.trim()}/users stays ${path.trim()}/users). When disabled the matched prefix path is stripped.`}
                checked={preservePath} onChange={setPreservePath} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center">
            <Label className="flex-1">Protocol &amp; Host / IP</Label>
            <span className="w-[110px] shrink-0">
              <Label>Port <span className="cursor-help text-nb-gray-400" title="Enter the port where your service is currently listening. If left empty, defaults to port 80 for HTTP or 443 for HTTPS.">ⓘ</span></Label>
            </span>
          </div>
          <div className="flex items-stretch min-w-0">
            <div className="w-[110px] shrink-0">
              <PlainSelect joined="left" value={protocol} onChange={setProtocol}
                options={[{ value: 'http', label: 'http://' }, { value: 'https', label: 'https://' }]} />
            </div>
            <Input className="flex-1 min-w-0 rounded-none! border-l-0! border-r-0!" value={isCluster ? host : (picked?.resolvedHost || '')}
              onChange={(e) => setHost(e.target.value)} readOnly={!isCluster} disabled={!picked}
              placeholder={isCluster ? 'e.g., 127.0.0.1 or backend.lan' : 'e.g., 192.168.0.10'} />
            <span className="inline-flex items-center px-1 border-y border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 text-nb-gray-500 text-sm select-none">:</span>
            <Input className="w-[110px] shrink-0 rounded-l-none! border-l-0!" value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              placeholder={protocol === 'https' ? '443' : '80'} />
          </div>
        </div>

        <div>
          <button type="button" onClick={() => setOptOpen((o) => !o)}
            className="inline-flex items-center gap-2 text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 hover:text-netbird transition-colors">
            {optOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Optional Settings
          </button>
          {optOpen && (
            <div className="mt-3 flex flex-col gap-3">
              {isHttp && (
                <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-4 py-3 flex flex-col gap-2.5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <span>
                      <span className="flex items-center gap-2 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100"><LockKeyhole size={15} /> Access</span>
                      <span className="block mt-0.5 text-[0.78rem] text-nb-gray-500">What happens to requests that start with this location.</span>
                    </span>
                    <div className="w-full sm:w-[230px] shrink-0">
                      <PlainSelect value={action} onChange={pickAction} options={[
                        { value: 'inherit', label: 'Use Service Authentication' },
                        ...(isPrivate && action !== 'bypass' ? [] : [{ value: 'bypass', label: 'Bypass Authentication' }]),
                        { value: 'block', label: 'Block Access' },
                      ]} />
                    </div>
                  </div>
                  {action === 'bypass' && !isPrivate && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[0.76rem] text-amber-700 dark:text-amber-400">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>Requests to <span className="font-mono">{serviceDomain || 'this service'}{normPath(path)}</span>{normPath(path) === '/' ? ' (the whole service)' : ' and everything under it'} skip SSO, password, PIN and header authentication. CIDR, country and CrowdSec (Enforce) restrictions still apply.</span>
                    </div>
                  )}
                  {isPrivate && action === 'bypass' && (
                    <p className="text-[0.76rem] text-red-500">Bypass Authentication isn't available on a NetBird-Only service - choose another option.</p>
                  )}
                  <FieldHint>
                    {isPrivate ? 'NetBird-Only services allow Block Access only. ' : ''}
                    The location matches as a literal, case-sensitive prefix: /api also matches /apix and /api/v2.
                    Every proxy in the cluster must run NetBird v0.81 or newer - older proxies ignore this setting, so saving it doesn't prove it is enforced.
                  </FieldHint>
                </div>
              )}
              {protocol === 'https' ? (
                <label className="flex items-center justify-between gap-4 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-4 py-3 cursor-pointer">
                  <span>
                    <span className="flex items-center gap-2 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100"><ShieldX size={15} /> Skip TLS Verification</span>
                    <span className="block mt-0.5 text-[0.78rem] text-nb-gray-500">Skip certificate verification when connecting to this target. Useful if your service already uses a self-signed certificate.</span>
                  </span>
                  <Checkbox checked={skipTls} onChange={(e) => setSkipTls(e.target.checked)} />
                </label>
              ) : !isHttp ? (
                <FieldHint>No optional settings for HTTP targets.</FieldHint>
              ) : null}
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

// ─── Targets list (Service tab), official row layout: path pill → arrow → destination + controls ───
function TargetsList({ targets, onEdit, onToggle, onRemove }: {
  targets: TargetDraft[];
  onEdit: (i: number) => void;
  onToggle: (i: number) => void;
  onRemove: (i: number) => void;
}) {
  const [menu, setMenu] = useState<{ i: number; left: number; top: number } | null>(null);
  return (
    <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 divide-y divide-nb-gray-100 dark:divide-nb-gray-900 overflow-visible">
      {targets.map((t, i) => (
        <div key={i} className={cn('flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40', !t.enabled && 'opacity-50')}
          onClick={() => onEdit(i)}>
          <span className="font-mono text-[0.78rem] px-2 py-0.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-600 dark:text-nb-gray-300 shrink-0">
            {t.path && t.path !== '' ? (t.path.startsWith('/') ? t.path : `/${t.path}`) : '/'}
          </span>
          <ArrowRight size={12} className="text-nb-gray-400 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-200">{destinationLabel(t)}</span>
          {t.accessAction === 'bypass' && <Badge tone="orange">Bypass Auth</Badge>}
          {t.accessAction === 'block' && <Badge tone="red">Blocked</Badge>}
          <span className="text-[0.72rem] text-nb-gray-500 shrink-0 hidden sm:inline">{t.refLabel}</span>
          <span onClick={(e) => e.stopPropagation()} className="shrink-0 inline-flex items-center gap-1.5">
            <button type="button" role="switch" aria-checked={t.enabled} onClick={() => onToggle(i)}
              className={cn('relative h-5 w-9 rounded-full transition-colors', t.enabled ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700')}>
              <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all', t.enabled ? 'left-[18px]' : 'left-0.5')} />
            </button>
            <button type="button" className="inline-flex items-center justify-center h-7 w-7 rounded-md text-nb-gray-500 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900"
              onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu(menu?.i === i ? null : { i, left: r.right - 180, top: r.bottom + 4 }); }}>
              <MoreVertical size={15} />
            </button>
          </span>
        </div>
      ))}
      {menu && createPortal(
        <>
          <div className="fixed inset-0 z-1090" onClick={() => setMenu(null)} />
          <div style={{ position: 'fixed', left: menu.left, top: menu.top, zIndex: 1100, minWidth: 180 }}
            className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
            <button onClick={() => { const i = menu.i; setMenu(null); onEdit(i); }}
              className="flex items-center gap-3 w-full px-2.5 py-2 rounded-sm text-sm text-nb-gray-700 dark:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
              <Pencil size={14} /> Edit Target
            </button>
            <button onClick={() => { const i = menu.i; setMenu(null); onRemove(i); }}
              className="flex items-center gap-3 w-full px-2.5 py-2 rounded-sm text-sm text-red-500 hover:bg-red-500/10">
              <MinusCircle size={14} /> Remove Target
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// ─── Authentication tab: official SettingCard-style rows, click to configure ───
function AuthRow({ icon, label, desc, on, onClick, disabled, disabledHint }: {
  icon: React.ReactNode; label: string; desc: string; on: boolean; onClick: () => void; disabled?: boolean; disabledHint?: string;
}) {
  return (
    <button type="button" onClick={disabled ? undefined : onClick} title={disabled ? disabledHint : undefined}
      className={cn('w-full flex items-center justify-between gap-4 px-4 py-3.5 text-left border-b last:border-b-0 border-nb-gray-100 dark:border-nb-gray-900 transition-colors',
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40 cursor-pointer')}>
      <span className="flex items-center gap-3 min-w-0">
        <span className="text-nb-gray-400 shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">{label}</span>
          <span className="block text-[0.78rem] text-nb-gray-500 truncate">{desc}</span>
        </span>
      </span>
      <Badge tone={on ? 'green' : 'gray'}>{on ? 'On' : 'Off'}</Badge>
    </button>
  );
}

function GroupsAuthModal({ title, desc, groups, value, onSave, onClose, requireGroups, allLabel }: {
  title: string; desc: string; groups: { id: string; name: string }[]; value: { enabled: boolean; groups: string[] };
  onSave: (v: { enabled: boolean; groups: string[] }) => void; onClose: () => void;
  requireGroups?: boolean; allLabel?: string;
}) {
  const [sel, setSel] = useState<string[]>(value.groups);
  return (
    <Modal open onClose={onClose} size="md" icon={<UsersIcon size={18} />} title={title} subtitle={desc}
      footer={
        <>
          {value.enabled && (
            <button type="button" className="mr-auto text-sm text-red-500 hover:underline" onClick={() => { onSave({ enabled: false, groups: [] }); onClose(); }}>Remove</button>
          )}
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!!requireGroups && !sel.length}
            onClick={() => { onSave({ enabled: true, groups: sel }); onClose(); }}>
            {value.enabled ? 'Save' : 'Enable'}
          </Button>
        </>
      }>
      <GroupMultiSelect groups={groups} value={sel} onChange={setSel} placeholder={allLabel || 'Select access groups…'} />
    </Modal>
  );
}

function SecretAuthModal({ title, desc, icon, hasExisting, numeric, onSave, onClose }: {
  title: string; desc: string; icon: React.ReactNode; hasExisting: boolean; numeric?: boolean;
  onSave: (v: { enabled: boolean; value?: string }) => void; onClose: () => void;
}) {
  const [val, setVal] = useState('');
  return (
    <Modal open onClose={onClose} size="sm" icon={icon} title={title} subtitle={desc}
      footer={
        <>
          {hasExisting && (
            <button type="button" className="mr-auto text-sm text-red-500 hover:underline" onClick={() => { onSave({ enabled: false }); onClose(); }}>Remove</button>
          )}
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!hasExisting && !val.trim()}
            onClick={() => { onSave({ enabled: true, ...(val.trim() ? { value: val.trim() } : {}) }); onClose(); }}>
            {hasExisting ? 'Save' : `Add ${title}`}
          </Button>
        </>
      }>
      <Input type="password" autoFocus value={val} autoComplete="new-password"
        onChange={(e) => setVal(numeric ? e.target.value.replace(/\D/g, '') : e.target.value)}
        placeholder={hasExisting ? (numeric ? '******' : '**********') : (numeric ? 'Enter PIN code…' : 'Enter password…')}
        maxLength={numeric ? 6 : undefined} />
      {hasExisting && <FieldHint>Leave blank to keep the current {numeric ? 'PIN' : 'password'}.</FieldHint>}
    </Modal>
  );
}

// ─── HTTP Headers auth: the official AuthHeaderModal (Basic / Bearer / Custom) ───
export interface HeaderEntry { enabled: boolean; header: string; value: string; existing: boolean }

type HeaderDraftType = 'basic' | 'bearer' | 'custom';
interface HeaderDraftItem { id: number; type: HeaderDraftType; header: string; value: string; username: string; password: string; existing: boolean }

const b64 = (s: string) => btoa(new TextEncoder().encode(s).reduce((acc, byte) => acc + String.fromCharCode(byte), ''));

function HeadersAuthModal({ current, onSave, onClose }: {
  current: HeaderEntry[];
  onSave: (headers: HeaderEntry[]) => void;
  onClose: () => void;
}) {
  const newItem = (id: number): HeaderDraftItem => ({ id, type: 'basic', header: 'Authorization', value: '', username: '', password: '', existing: false });
  const [items, setItems] = useState<HeaderDraftItem[]>(() =>
    current.length
      ? current.map((h, i) => ({ id: i, type: 'custom' as HeaderDraftType, header: h.header, value: '', username: '', password: '', existing: true }))
      : [newItem(0)]);
  const nextId = useRef(current.length || 1);
  const editing = current.length > 0;

  const upd = (id: number, patch: Partial<HeaderDraftItem>) => setItems((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x));
  const valid = (it: HeaderDraftItem) => it.existing
    ? !!it.header.trim()
    : it.type === 'basic' ? (!!it.username.trim() && !!it.password)
      : it.type === 'bearer' ? !!it.value.trim()
        : (!!it.header.trim() && !!it.value.trim());
  const canSave = items.length > 0 && items.every(valid);

  const toEntry = (it: HeaderDraftItem): HeaderEntry => {
    if (it.existing) return { enabled: true, header: it.header.trim(), value: it.value, existing: true }; // blank value = keep current secret
    if (it.type === 'basic') return { enabled: true, header: 'Authorization', value: `Basic ${b64(`${it.username}:${it.password}`)}`, existing: false };
    if (it.type === 'bearer') return { enabled: true, header: 'Authorization', value: `Bearer ${it.value.trim()}`, existing: false };
    return { enabled: true, header: it.header.trim(), value: it.value, existing: false };
  };

  return (
    <Modal open onClose={onClose} size="md" icon={<FileCode2 size={18} />}
      title="HTTP Headers" subtitle="Require specific HTTP headers to access this service."
      footer={
        <>
          {editing && (
            <button type="button" className="mr-auto text-sm text-red-500 hover:underline"
              onClick={() => { onSave([]); onClose(); }}>Remove All</button>
          )}
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!canSave}
            onClick={() => { onSave(items.map(toEntry)); onClose(); }}>
            {editing ? 'Save' : 'Add Headers'}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-3">
        {items.map((it, index) => (
          <div key={it.id} className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-920/30 px-4 pt-2.5 pb-4 flex flex-col gap-2">
            <div className="flex items-center justify-between h-6">
              <span className="text-xs text-nb-gray-600 dark:text-nb-gray-200 flex items-center gap-2">
                <FileCode2 size={14} />
                {it.existing ? `Header ${index + 1} - ${it.header}` : `Header ${index + 1}`}
              </span>
              {items.length > 1 && (
                <button type="button" className="inline-flex items-center gap-1 text-xs text-red-500 hover:underline"
                  onClick={() => setItems((p) => p.filter((x) => x.id !== it.id))}>
                  <MinusCircle size={12} /> Remove
                </button>
              )}
            </div>

            {it.existing ? (
              <>
                <Input type="password" value={it.value} autoComplete="new-password"
                  onChange={(e) => upd(it.id, { value: e.target.value })}
                  placeholder="••••••••" />
                <FieldHint>Leave blank to keep the current value.</FieldHint>
              </>
            ) : (
              <>
                <PlainSelect value={it.type}
                  onChange={(v) => upd(it.id, { type: v as HeaderDraftType, header: v === 'custom' ? '' : 'Authorization', value: '', username: '', password: '' })}
                  options={[
                    { value: 'basic', label: <span className="inline-flex items-center gap-2"><CircleUser size={14} /> Basic Auth</span> },
                    { value: 'bearer', label: <span className="inline-flex items-center gap-2"><KeyRound size={14} /> Bearer Token</span> },
                    { value: 'custom', label: <span className="inline-flex items-center gap-2"><Braces size={14} /> Custom Header</span> },
                  ]} />

                {it.type === 'basic' && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-stretch min-w-0">
                      <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 text-nb-gray-500"><UserIcon2 size={15} /></span>
                      <Input className="flex-1 min-w-0 rounded-l-none!" value={it.username} autoComplete="off"
                        onChange={(e) => upd(it.id, { username: e.target.value })} placeholder="Username" />
                    </div>
                    <div className="flex items-stretch min-w-0">
                      <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 text-nb-gray-500"><KeyRound size={15} /></span>
                      <Input className="flex-1 min-w-0 rounded-l-none!" type="password" value={it.password} autoComplete="new-password"
                        onChange={(e) => upd(it.id, { password: e.target.value })} placeholder="Password" />
                    </div>
                  </div>
                )}

                {it.type === 'bearer' && (
                  <div className="flex items-stretch min-w-0">
                    <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 text-sm text-nb-gray-500">Bearer</span>
                    <Input className="flex-1 min-w-0 rounded-l-none!" type="password" value={it.value} autoComplete="off"
                      onChange={(e) => upd(it.id, { value: e.target.value })} placeholder="e.g. eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..." />
                  </div>
                )}

                {it.type === 'custom' && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-stretch min-w-0">
                      <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 text-sm text-nb-gray-500 min-w-[64px]">Name</span>
                      <Input className="flex-1 min-w-0 rounded-l-none!" value={it.header} autoComplete="off"
                        onChange={(e) => upd(it.id, { header: e.target.value })} placeholder="e.g., X-API-Key" />
                    </div>
                    <div className="flex items-stretch min-w-0">
                      <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 text-sm text-nb-gray-500 min-w-[64px]">Value</span>
                      <Input className="flex-1 min-w-0 rounded-l-none!" type="password" value={it.value} autoComplete="off"
                        onChange={(e) => upd(it.id, { value: e.target.value })} placeholder="e.g., AIiaSyDaGmWKa4JsXZ-HjGw7ISLn..." />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        <button type="button" onClick={() => setItems((p) => [...p, newItem(nextId.current++)])}
          className="w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:border-netbird hover:text-netbird py-2.5 text-sm font-medium transition-colors">
          <Plus size={14} /> Add Header
        </button>

        {items.length > 1 && (
          <div className="flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[0.8rem] text-nb-gray-700 dark:text-nb-gray-300">
            <FileCode2 size={14} className="text-sky-400 shrink-0 mt-0.5" />
            <span>Any request matching one of these headers will grant access. Matched headers are stripped before reaching your backend.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Access Control tab: official rule rows (action + type + value) ───
interface AccessRule { action: 'allow' | 'block'; type: 'country' | 'ip' | 'cidr'; value: string }

function rulesFromAccess(a: { allowedCidrs: string[]; blockedCidrs: string[]; allowedCountries: string[]; blockedCountries: string[] }): AccessRule[] {
  const out: AccessRule[] = [];
  for (const c of a.allowedCountries) out.push({ action: 'allow', type: 'country', value: c });
  for (const c of a.blockedCountries) out.push({ action: 'block', type: 'country', value: c });
  const cidr = (action: 'allow' | 'block') => (v: string) =>
    out.push(/\/32$/.test(v) ? { action, type: 'ip', value: v.replace(/\/32$/, '') } : v.includes('/') ? { action, type: 'cidr', value: v } : { action, type: 'ip', value: v });
  a.allowedCidrs.forEach(cidr('allow'));
  a.blockedCidrs.forEach(cidr('block'));
  return out;
}
function rulesToAccess(rules: AccessRule[]) {
  const a = { allowedCidrs: [] as string[], blockedCidrs: [] as string[], allowedCountries: [] as string[], blockedCountries: [] as string[] };
  for (const r of rules) {
    const v = r.value.trim();
    if (!v) continue;
    if (r.type === 'country') (r.action === 'allow' ? a.allowedCountries : a.blockedCountries).push(v.toUpperCase());
    else {
      const cidr = r.type === 'ip' && !v.includes('/') ? `${v}/32` : v;
      (r.action === 'allow' ? a.allowedCidrs : a.blockedCidrs).push(cidr);
    }
  }
  return a;
}

function AccessRulesEditor({ rules, setRules, crowdsec, setCrowdsec, isPrivate }: {
  rules: AccessRule[]; setRules: (r: AccessRule[]) => void;
  crowdsec: string; setCrowdsec: (v: string) => void;
  isPrivate: boolean;
}) {
  const upd = (i: number, patch: Partial<AccessRule>) => setRules(rules.map((r, idx) => idx === i ? { ...r, ...patch, ...(patch.type && patch.type !== r.type ? { value: '' } : {}) } : r));
  return (
    <div className="flex flex-col gap-5">
      {isPrivate && (
        <div className="flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-300">
          <NetworkIcon size={14} className="text-sky-400 shrink-0" />
          This service is accessible via NetBird only. An allow rule for the NetBird network range is applied by default. Any rules you add here are layered on top.
        </div>
      )}

      <SideRow label="CrowdSec IP Reputation" hint="Detect malicious IPs with CrowdSec. Enforce to block them or Observe to only log without blocking.">
        <PlainSelect value={crowdsec} onChange={setCrowdsec}
          options={[
            { value: 'off', label: 'Disabled' },
            { value: 'enforce', label: 'Enforce' },
            { value: 'observe', label: 'Observe' },
          ]} />
      </SideRow>

      <Block label="Access Control Rules"
        hint="Define rules to allow or block traffic based on country, IP address, or CIDR block. Block rules always take priority over allow rules.">
        <div className="mt-1 flex flex-col gap-3">
          {rules.map((r, i) => (
            <div key={i} className="flex items-stretch min-w-0">
              <div className="w-[140px] shrink-0">
                <PlainSelect joined="left" value={r.action} onChange={(v) => upd(i, { action: v as AccessRule['action'] })}
                  options={[
                    { value: 'allow', label: <span className="inline-flex items-center gap-2"><ShieldCheck size={13} className="text-green-500" /> Allow Only</span> },
                    { value: 'block', label: <span className="inline-flex items-center gap-2"><ShieldX size={13} className="text-red-500" /> Block Only</span> },
                  ]} />
              </div>
              <div className="w-[150px] shrink-0">
                <PlainSelect joined="middle" value={r.type} onChange={(v) => upd(i, { type: v as AccessRule['type'] })}
                  options={[
                    { value: 'country', label: <span className="inline-flex items-center gap-2"><Flag size={13} /> Country</span> },
                    { value: 'ip', label: <span className="inline-flex items-center gap-2"><Workflow size={13} /> IP Address</span> },
                    { value: 'cidr', label: <span className="inline-flex items-center gap-2"><NetworkIcon size={13} /> CIDR Block</span> },
                  ]} />
              </div>
              {r.type === 'country' ? (
                <div className="flex-1 min-w-0">
                  <CountrySelect value={r.value} onChange={(v) => upd(i, { value: v })} />
                </div>
              ) : (
                <Input className="flex-1 min-w-0 rounded-l-none! border-l-0!" value={r.value} onChange={(e) => upd(i, { value: e.target.value })}
                  placeholder={r.type === 'ip' ? 'e.g., 85.203.15.42 or 2001:db8::1' : 'e.g., 74.125.0.0/16 or 2001:db8::/64'} />
              )}
              <button type="button" aria-label="Remove rule" onClick={() => setRules(rules.filter((_, idx) => idx !== i))}
                className="ml-2 shrink-0 inline-flex items-center justify-center h-[44px] w-[44px] rounded-md border border-nb-gray-200 dark:border-nb-gray-800 text-nb-gray-500 hover:text-red-500 hover:border-red-500/30">
                <MinusCircle size={16} />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setRules([...rules, { action: 'allow', type: 'country', value: '' }])}
            className="w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:border-netbird hover:text-netbird py-2.5 text-sm font-medium transition-colors">
            <Plus size={14} /> Add Rule
          </button>
        </div>
      </Block>
    </div>
  );
}

// ─── Advanced Settings toggles ───
function ToggleRow({ icon, label, help, checked, onChange }: {
  icon: React.ReactNode; label: string; help: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-4 py-3.5 cursor-pointer">
      <span>
        <span className="flex items-center gap-2 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">{icon} {label}</span>
        <span className="block mt-0.5 text-[0.78rem] text-nb-gray-500">{help}</span>
      </span>
      <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

// ─── Shared Authentication + Access Control block (service modal AND Expose Docker wizard) ───
function useProtection() {
  const nbGroups = useGroups().data || [];
  const [priv, setPriv] = useState(false);
  const [accessGroups, setAccessGroups] = useState<string[]>([]);
  const [sso, setSso] = useState<{ enabled: boolean; groups: string[] }>({ enabled: false, groups: [] });
  const [pwd, setPwd] = useState<{ enabled: boolean; set: boolean; value?: string }>({ enabled: false, set: false });
  const [pin, setPin] = useState<{ enabled: boolean; set: boolean; value?: string }>({ enabled: false, set: false });
  const [headerEntries, setHeaderEntries] = useState<HeaderEntry[]>([]);
  const [rules, setRules] = useState<AccessRule[]>([]);
  const [crowdsec, setCrowdsec] = useState('off');
  const [authModal, setAuthModal] = useState<'netbird' | 'sso' | 'password' | 'pin' | 'headers' | null>(null);

  // CrowdSec Observe only logs, it never blocks - so only Enforce counts as a restriction.
  const hasRestrictions = rules.some((r) => r.value.trim()) || crowdsec === 'enforce';
  const hasProtection = priv || sso.enabled || pwd.enabled || pin.enabled || headerEntries.length > 0 || hasRestrictions;

  const buildAuthPatch = (): UpdateProxyServiceInput['auth'] => ({
    sso: { enabled: sso.enabled, groups: sso.groups },
    password: { enabled: pwd.enabled, ...(pwd.value ? { value: pwd.value } : {}) },
    pin: { enabled: pin.enabled, ...(pin.value ? { value: pin.value } : {}) },
    headers: headerEntries.map((h) => ({ enabled: h.enabled, header: h.header, ...(h.value ? { value: h.value } : {}) })),
  });
  const buildAccessPatch = () => ({ ...rulesToAccess(rules), crowdsec });

  // Fill the state from an existing service (edit mode).
  const loadFrom = (s: EditableProxyService) => {
    setPriv(s.private); setAccessGroups(s.accessGroups.slice());
    setSso({ enabled: s.auth.sso.enabled, groups: s.auth.sso.groups.slice() });
    setPwd({ enabled: s.auth.password.enabled, set: s.auth.password.set });
    setPin({ enabled: s.auth.pin.enabled, set: s.auth.pin.set });
    setHeaderEntries(s.auth.headers.map((h) => ({ enabled: h.enabled, header: h.header, value: '', existing: true })));
    setRules(rulesFromAccess(s.access));
    setCrowdsec(s.access.crowdsec || 'off');
  };

  const authTab = (
    <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 overflow-hidden">
      <AuthRow icon={<NetworkIcon size={16} />} label="NetBird-Only Access"
        desc="Reachable only from connected peers in the selected NetBird groups."
        on={priv} onClick={() => setAuthModal('netbird')} />
      {!priv && (
        <>
          <AuthRow icon={<UsersIcon size={16} />} label="SSO (Single Sign-On)"
            desc="Require users to authenticate via SSO to access this service."
            on={sso.enabled} onClick={() => setAuthModal('sso')} />
          <AuthRow icon={<RectangleEllipsis size={16} />} label="Password"
            desc="Require a password to access this service."
            on={pwd.enabled} onClick={() => setAuthModal('password')} />
          <AuthRow icon={<Binary size={16} />} label="PIN Code"
            desc="Require a numeric PIN code to access this service."
            on={pin.enabled} onClick={() => setAuthModal('pin')} />
          <AuthRow icon={<FileCode2 size={16} />} label="HTTP Headers"
            desc="Require specific HTTP headers to access this service."
            on={headerEntries.length > 0} onClick={() => setAuthModal('headers')} />
        </>
      )}
    </div>
  );

  const accessTab = (
    <AccessRulesEditor rules={rules} setRules={setRules} crowdsec={crowdsec} setCrowdsec={setCrowdsec} isPrivate={priv} />
  );

  const modals = (
    <>
      {authModal === 'netbird' && (
        <GroupsAuthModal title="NetBird-Only Access" desc="Reachable from peers in selected groups only."
          groups={nbGroups} value={{ enabled: priv, groups: accessGroups }} requireGroups
          onSave={(v) => { setPriv(v.enabled); setAccessGroups(v.groups); }}
          onClose={() => setAuthModal(null)} allLabel="Select access groups…" />
      )}
      {authModal === 'sso' && (
        <GroupsAuthModal title="SSO (Single Sign-On)" desc="Require users to authenticate via SSO to access this service."
          groups={nbGroups} value={{ enabled: sso.enabled, groups: sso.groups }}
          onSave={(v) => setSso(v)} onClose={() => setAuthModal(null)} allLabel="All Users - or select user groups…" />
      )}
      {authModal === 'password' && (
        <SecretAuthModal title="Password" desc="Require a password to access this service." icon={<RectangleEllipsis size={18} />}
          hasExisting={pwd.enabled && pwd.set}
          onSave={(v) => setPwd({ enabled: v.enabled, set: pwd.set || !!v.value, value: v.value })}
          onClose={() => setAuthModal(null)} />
      )}
      {authModal === 'pin' && (
        <SecretAuthModal title="PIN Code" desc="Require a numeric PIN code to access this service." icon={<Binary size={18} />} numeric
          hasExisting={pin.enabled && pin.set}
          onSave={(v) => setPin({ enabled: v.enabled, set: pin.set || !!v.value, value: v.value })}
          onClose={() => setAuthModal(null)} />
      )}
      {authModal === 'headers' && (
        <HeadersAuthModal current={headerEntries} onSave={setHeaderEntries} onClose={() => setAuthModal(null)} />
      )}
    </>
  );

  return { priv, accessGroups, hasProtection, hasRestrictions, buildAuthPatch, buildAccessPatch, loadFrom, authTab, accessTab, modals };
}

// ─── The service modal shell (create wizard + edit), mirroring the official ReverseProxyModal ───
type SvcTab = 'targets' | 'auth' | 'access-control' | 'settings';

function ServiceModal({ clusters, serviceId, onClose }: { clusters: ProxyCluster[]; serviceId?: string; onClose: () => void }) {
  const editing = !!serviceId;
  const detailQ = useProxyServiceDetail(serviceId);
  const create = useCreateProxyService();
  const update = useUpdateProxyService();
  const confirm = useConfirm();
  const targetOpts = useProxyTargetOptions().data;
  const domains = useProxyDomains().data || [];
  const prot = useProtection();

  const [tab, setTab] = useState<SvcTab>('targets');
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [domain, setDomain] = useState<DomainDraft>(emptyDomain);
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [targets, setTargets] = useState<TargetDraft[]>([]);
  const [targetModal, setTargetModal] = useState<{ index: number | null } | null>(null);
  // Advanced
  const [passHostHeader, setPassHostHeader] = useState(false);
  const [rewriteRedirects, setRewriteRedirects] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);

  // Load existing service into the form (edit mode).
  useEffect(() => {
    const s = detailQ.data;
    if (!editing || !s || loadedId === s.id || !targetOpts) return;
    setLoadedId(s.id);
    setName(s.name); setEnabled(s.enabled);
    prot.loadFrom(s);
    setPassHostHeader(!!s.passHostHeader);
    setRewriteRedirects(!!s.rewriteRedirects);
    setTargets(s.targets.map((t: EditableProxyTarget): TargetDraft => {
      if (t.target_type === 'cluster' || t.direct) {
        const cid = t.target_id || detailQ.data?.cluster || '';
        return { kind: 'cluster', refId: cid, refLabel: cid || 'Direct', resolvedHost: t.host, targetType: 'cluster', protocol: t.protocol, port: String(t.port || ''), path: t.path || '', enabled: t.enabled, skipTlsVerify: !!t.skipTlsVerify, preservePath: !!t.preservePath, accessAction: t.accessAction };
      }
      if (t.target_type === 'peer') {
        const p = (targetOpts.peers || []).find((x) => x.id === t.target_id);
        return { kind: 'peer', refId: t.target_id, refLabel: p?.name || t.target_id, resolvedHost: p?.dns || p?.ip || t.host, targetType: 'peer', os: p?.os || '', protocol: t.protocol, port: String(t.port || ''), path: t.path || '', enabled: t.enabled, skipTlsVerify: !!t.skipTlsVerify, preservePath: !!t.preservePath, accessAction: t.accessAction };
      }
      const r = (targetOpts.resources || []).find((x) => x.id === t.target_id);
      return { kind: 'resource', refId: t.target_id, refLabel: r?.name || t.target_id, resolvedHost: r?.address || t.host, targetType: t.target_type, protocol: t.protocol, port: String(t.port || ''), path: t.path || '', enabled: t.enabled, skipTlsVerify: !!t.skipTlsVerify, preservePath: !!t.preservePath, accessAction: t.accessAction };
    }));
  }, [detailQ.data, editing, loadedId, targetOpts]);

  const serviceDomain = editing ? (detailQ.data?.domain || '') : composeDomain(domain, domains);
  // The Proxy Clusters tab in the target picker only offers the service's own cluster (derived from the domain).
  const derivedCluster = editing
    ? (detailQ.data?.cluster || '')
    : (domain.base ? clusterForDomain(domains, clusters, domain.base, '') : '');
  const targetClusters: ProxyCluster[] = derivedCluster
    ? (clusters.some((c) => c.address === derivedCluster)
      ? clusters.filter((c) => c.address === derivedCluster)
      : [{ id: derivedCluster, address: derivedCluster, type: '', online: true, connectedProxies: 0, private: true, services: 0 }])
    : clusters;
  const domainValid = editing || DOMAIN_RE.test(serviceDomain);
  const canContinue = domainValid && targets.length > 0;

  const submit = async () => {
    setError('');
    if (!canContinue) { setError('A valid domain and at least one target are required.'); setTab('targets'); return; }
    if (prot.priv && !prot.accessGroups.length) { setError('NetBird-Only is on but no access groups are set. Pick at least one group.'); setTab('auth'); return; }
    // NetBird-Only can't be combined with Bypass (Block is fine) - say so instead of dropping it.
    if (prot.priv && targets.some((t) => t.accessAction === 'bypass')) {
      setError("Bypass Authentication isn't available on a NetBird-Only service. Set those targets back to Use Service Authentication, or turn NetBird-Only off.");
      setTab('targets'); return;
    }
    // Effective protection: a live bypass on "/" opens the whole service without login, so the
    // auth methods alone no longer count; any other bypass path is confirmed by name.
    const bypassPaths = prot.priv ? [] : targets.filter((t) => t.enabled && t.accessAction === 'bypass').map((t) => normPath(t.path));
    const rootBypass = bypassPaths.includes('/');
    if (!prot.hasProtection || (rootBypass && !prot.hasRestrictions)) {
      const ok = await confirm({
        title: 'No Protection Configured',
        message: prot.hasProtection
          ? 'A target on "/" bypasses authentication and no access control rules are configured (CrowdSec Observe only logs), so the whole service will be publicly accessible to everyone on the internet. Are you sure you want to continue?'
          : 'This service has no authentication or access control rules configured. It will be publicly accessible to everyone on the internet. Are you sure you want to continue?',
        confirmText: editing ? 'Save Changes' : 'Add Service',
      });
      if (!ok) return;
    } else if (bypassPaths.length) {
      const ok = await confirm({
        title: 'Authentication Bypassed',
        message: `Requests to ${bypassPaths.join(', ')} skip this service's authentication.${prot.hasRestrictions ? ' Access control rules (CIDR, country, CrowdSec Enforce) still apply.' : ' No access control rules are configured (CrowdSec Observe only logs), so these paths are open to everyone on the internet.'} Continue?`,
        confirmText: editing ? 'Save Changes' : 'Add Service',
      });
      if (!ok) return;
    }
    try {
      const access = prot.buildAccessPatch();
      if (editing) {
        await update.mutateAsync({
          id: serviceId!,
          patch: {
            domain: serviceDomain, name: name.trim() || undefined, enabled,
            targets: targets.map((t) => ({ ...draftToInput(t), target_type: t.targetType })),
            private: prot.priv, accessGroups: prot.accessGroups, auth: prot.buildAuthPatch(), access,
            passHostHeader, rewriteRedirects,
          },
        });
        onClose();
      } else {
        // The cluster is derived from the chosen domain, like the official dashboard.
        const cluster = clusterForDomain(domains, clusters, domain.base, '');
        if (!cluster) { setError('The selected domain has no serving cluster.'); return; }
        const out = await create.mutateAsync({
          name: name.trim() || undefined, domain: serviceDomain, cluster,
          targets: targets.map(draftToInput), passHostHeader, rewriteRedirects,
        });
        if (prot.hasProtection) {
          await update.mutateAsync({
            id: out.id,
            patch: { domain: out.domain, private: prot.priv, accessGroups: prot.accessGroups, auth: prot.buildAuthPatch(), access },
          }).catch((e) => { throw new Error(`Service created, but applying auth/access failed: ${(e as Error).message}`); });
        }
        setDone(out.domain);
      }
    } catch (e) { setError((e as Error).message); }
  };

  // During creation, tabs beyond the first stay visually locked (dimmed) until valid.
  const locked = !editing && !canContinue;
  const dim = (k: string) => locked && k !== 'targets' ? 'opacity-40' : '';
  const tabItems = [
    { key: 'targets', label: <span className={cn('inline-flex items-center gap-2', dim('targets'))}><Globe size={14} /> Service</span> },
    { key: 'auth', label: <span className={cn('inline-flex items-center gap-2', dim('auth'))}><LockKeyhole size={14} /> Authentication</span> },
    { key: 'access-control', label: <span className={cn('inline-flex items-center gap-2', dim('access-control'))}><ShieldCheck size={14} /> Access Control</span> },
    { key: 'settings', label: <span className={cn('inline-flex items-center gap-2', dim('settings'))}><SettingsIcon size={14} /> Advanced Settings</span> },
  ];

  const wizardNext: Record<SvcTab, SvcTab | null> = { targets: 'auth', auth: 'access-control', 'access-control': 'settings', settings: null };
  const wizardPrev: Record<SvcTab, SvcTab | null> = { targets: null, auth: 'targets', 'access-control': 'auth', settings: 'access-control' };

  return (
    <>
    <Modal open onClose={onClose} size="lg" icon={<Globe size={18} />}
      title={editing ? 'Edit HTTPS Service' : 'Add HTTPS Service'}
      subtitle="Expose services securely through NetBird's reverse proxy."
      tabs={<Tabs bordered={false} items={tabItems} value={tab} onChange={(k) => {
        if (locked && k !== 'targets') return;
        setTab(k as SvcTab);
      }} />}
      footer={done ? (
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      ) : (
        <>
          {editing ? (
            <>
              <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={submit} disabled={update.isPending || detailQ.isLoading}>
                {update.isPending ? 'Saving…' : 'Save Changes'}
              </Button>
            </>
          ) : (
            <>
              {wizardPrev[tab]
                ? <Button variant="secondary" size="sm" onClick={() => setTab(wizardPrev[tab]!)}>Back</Button>
                : <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>}
              {wizardNext[tab]
                ? <Button variant="primary" size="sm" disabled={!canContinue} onClick={() => setTab(wizardNext[tab]!)}>Continue</Button>
                : <Button variant="primary" size="sm" onClick={submit} disabled={create.isPending || update.isPending}>
                    <PlusCircle size={15} /> {create.isPending ? 'Adding…' : 'Add Service'}
                  </Button>}
            </>
          )}
        </>
      )}>
      {done ? (
        <div className="flex items-start gap-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3.5">
          <CheckCircle2 size={20} className="text-green-500 shrink-0" />
          <div className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
            <div className="font-semibold text-nb-gray-800 dark:text-nb-gray-100">Service Created</div>
            <a href={`https://${done}`} target="_blank" rel="noreferrer" className="text-netbird hover:underline">{done}</a>
            <div className="mt-1 text-[0.8rem] text-nb-gray-500">Certificate issuing may take a minute - watch the Status column.</div>
          </div>
        </div>
      ) : (editing && (detailQ.isLoading || !detailQ.data)) ? (
        <div className="py-10 text-center text-sm text-nb-gray-500">Loading service…</div>
      ) : (
        <div className="flex flex-col gap-6">
          {tab === 'targets' && (
            <>
              {editing ? (
                <Block label="Domain">
                  <Input value={serviceDomain} disabled />
                </Block>
              ) : (
                <DomainField value={domain} onChange={setDomain} domains={domains} clusters={clusters} />
              )}

              <SideRow label="Service Type" hint="Select a type to define how the proxy handles and forwards traffic to your backend services.">
                <PlainSelect value="http" onChange={() => { }} disabled={editing}
                  options={[{ value: 'http', label: <span className="inline-flex items-center gap-2"><Globe size={14} /> HTTPS Service</span> }]} />
              </SideRow>

              {prot.priv && !prot.accessGroups.length && (
                <p className="text-xs text-yellow-500">NetBird-only is on but no access groups are set. Open it on the Authentication tab and pick at least one group.</p>
              )}

              <Block label="HTTPS Targets" hint="Add one or more devices running your service or resources to make it publicly accessible.">
                <div className="flex flex-col gap-2">
                  {targets.length > 0 && (
                    <TargetsList targets={targets}
                      onEdit={(i) => setTargetModal({ index: i })}
                      onToggle={(i) => setTargets((p) => p.map((x, idx) => idx === i ? { ...x, enabled: !x.enabled } : x))}
                      onRemove={(i) => setTargets((p) => p.filter((_, idx) => idx !== i))} />
                  )}
                  <button type="button" onClick={() => setTargetModal({ index: null })}
                    className="w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:border-netbird hover:text-netbird py-2.5 text-sm font-medium transition-colors">
                    <Plus size={14} /> Add Target
                  </button>
                </div>
              </Block>
            </>
          )}

          {tab === 'auth' && prot.authTab}

          {tab === 'access-control' && prot.accessTab}

          {tab === 'settings' && (
            <div className="flex flex-col gap-4">
              <Block label="Service Name (Optional)">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the domain" maxLength={80} />
              </Block>
              <ToggleRow icon={<Globe size={15} />} label="Pass Host Header"
                help="Forward the original Host header to the backend instead of rewriting it to the target address."
                checked={passHostHeader} onChange={setPassHostHeader} />
              <ToggleRow icon={<ArrowRight size={15} />} label="Rewrite Redirects"
                help="Rewrite Location headers in backend responses to use the public domain instead of the internal backend address."
                checked={rewriteRedirects} onChange={setRewriteRedirects} />
              {editing && (
                <ToggleRow icon={<Globe size={15} />} label="Service Enabled"
                  help="A disabled service stops serving requests but keeps its configuration."
                  checked={enabled} onChange={setEnabled} />
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      )}
    </Modal>

    {targetModal && (
      <TargetModal
        serviceDomain={serviceDomain}
        clusters={targetClusters}
        existing={targetModal.index != null ? targets[targetModal.index] : null}
        taken={targets.filter((_, i) => i !== targetModal.index).map((t) => t.path.trim() ? (t.path.startsWith('/') ? t.path : `/${t.path}`) : '/')}
        isPrivate={prot.priv}
        isHttp={!editing || (detailQ.data?.mode || 'http') === 'http'}
        onSave={(d) => setTargets((p) => targetModal.index != null ? p.map((x, i) => i === targetModal.index ? d : x) : [...p, d])}
        onClose={() => setTargetModal(null)}
      />
    )}

    {prot.modals}
    </>
  );
}

export function AddServiceModal({ clusters, onClose }: { clusters: ProxyCluster[]; onClose: () => void }) {
  return <ServiceModal clusters={clusters} onClose={onClose} />;
}
export function EditServiceModal({ serviceId, clusters = [], onClose }: { serviceId: string; clusters?: ProxyCluster[]; onClose: () => void }) {
  return <ServiceModal clusters={clusters} serviceId={serviceId} onClose={onClose} />;
}

// ─── Expose Docker Container: the proven recipe, automated with rollback - full wizard
//     with the same Authentication / Access Control / Advanced Settings tabs as Add Service ───
type DockerTab = 'container' | 'auth' | 'access-control' | 'settings';

export function ExposeDockerModal({ clusters, onClose }: { clusters: ProxyCluster[]; onClose: () => void }) {
  const expose = useExposeDocker();
  const update = useUpdateProxyService();
  const confirm = useConfirm();
  const peers = usePeers().data || [];
  const networks = useNetworks().data || [];
  const domains = useProxyDomains().data || [];
  const prot = useProtection();

  const [tab, setTab] = useState<DockerTab>('container');
  const [netId, setNetId] = useState('');
  const [containerDomain, setContainerDomain] = useState('');
  const [port, setPort] = useState('80');
  const [protocol, setProtocol] = useState('http');
  const [path, setPath] = useState('');
  const [preservePath, setPreservePath] = useState(false);
  const [routerPeerId, setRouterPeerId] = useState('');
  const [domain, setDomain] = useState<DomainDraft>(emptyDomain);
  const [serviceName, setServiceName] = useState('');
  const [passHostHeader, setPassHostHeader] = useState(false);
  const [rewriteRedirects, setRewriteRedirects] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const detail = useNetworkDetail(netId || undefined);
  const routers = detail.data?.routers || [];
  const needsRouter = !!netId && !detail.isLoading && routers.length === 0;

  const p = parseInt(port, 10);
  const dom = composeDomain(domain, domains);
  const canContinue = !!netId && DOMAIN_RE.test(containerDomain.trim().toLowerCase()) &&
    p >= 1 && p <= 65535 && DOMAIN_RE.test(dom) && !(needsRouter && !routerPeerId);

  const submit = async () => {
    setError('');
    if (!canContinue) { setError('Complete the container details first (network, container domain/port and service domain).'); setTab('container'); return; }
    if (prot.priv && !prot.accessGroups.length) { setError('NetBird-Only is on but no access groups are set. Pick at least one group.'); setTab('auth'); return; }
    const cluster = clusterForDomain(domains, clusters, domain.base, '');
    if (!cluster) { setError('The selected domain has no serving cluster.'); setTab('container'); return; }
    if (!prot.hasProtection) {
      const ok = await confirm({
        title: 'No Protection Configured',
        message: 'This service has no authentication or access control rules configured. It will be publicly accessible to everyone on the internet. Are you sure you want to continue?',
        confirmText: 'Expose Container',
      });
      if (!ok) return;
    }
    try {
      const out = await expose.mutateAsync({
        networkId: netId,
        containerDomain: containerDomain.trim().toLowerCase(),
        port: p, protocol,
        ...(path.trim() && path.trim() !== '/' ? { path: path.trim(), ...(preservePath ? { preservePath: true } : {}) } : {}),
        routerPeerId: routerPeerId || undefined,
        serviceDomain: dom,
        serviceName: serviceName.trim() || undefined,
        cluster,
        passHostHeader, rewriteRedirects,
      });
      const svcId = out.service?.id;
      if (svcId && prot.hasProtection) {
        await update.mutateAsync({
          id: svcId,
          patch: { domain: out.service?.domain || dom, private: prot.priv, accessGroups: prot.accessGroups, auth: prot.buildAuthPatch(), access: prot.buildAccessPatch() },
        }).catch((e) => { throw new Error(`Container exposed, but applying auth/access failed: ${(e as Error).message}`); });
      }
      setDone(out.service?.domain || dom);
    } catch (e) { setError((e as Error).message); }
  };

  const locked = !canContinue;
  const dim = (k: string) => locked && k !== 'container' ? 'opacity-40' : '';
  const tabItems = [
    { key: 'container', label: <span className={cn('inline-flex items-center gap-2', dim('container'))}><Container size={14} /> Container</span> },
    { key: 'auth', label: <span className={cn('inline-flex items-center gap-2', dim('auth'))}><LockKeyhole size={14} /> Authentication</span> },
    { key: 'access-control', label: <span className={cn('inline-flex items-center gap-2', dim('access-control'))}><ShieldCheck size={14} /> Access Control</span> },
    { key: 'settings', label: <span className={cn('inline-flex items-center gap-2', dim('settings'))}><SettingsIcon size={14} /> Advanced Settings</span> },
  ];
  const wizardNext: Record<DockerTab, DockerTab | null> = { container: 'auth', auth: 'access-control', 'access-control': 'settings', settings: null };
  const wizardPrev: Record<DockerTab, DockerTab | null> = { container: null, auth: 'container', 'access-control': 'auth', settings: 'access-control' };

  return (
    <>
    <Modal open onClose={onClose} size="lg" icon={<Container size={18} />}
      title="Expose Docker Container"
      subtitle="Creates the domain resource + service (and a routing peer if needed) in one step - rolled back together if anything fails."
      tabs={<Tabs bordered={false} items={tabItems} value={tab} onChange={(k) => {
        if (locked && k !== 'container') return;
        setTab(k as DockerTab);
      }} />}
      footer={done ? (
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      ) : (
        <>
          {wizardPrev[tab]
            ? <Button variant="secondary" size="sm" onClick={() => setTab(wizardPrev[tab]!)}>Back</Button>
            : <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>}
          {wizardNext[tab]
            ? <Button variant="primary" size="sm" disabled={!canContinue} onClick={() => setTab(wizardNext[tab]!)}>Continue</Button>
            : <Button variant="primary" size="sm" onClick={submit} disabled={expose.isPending || update.isPending}>
                <PlusCircle size={15} /> {expose.isPending || update.isPending ? 'Creating…' : 'Expose Container'}
              </Button>}
        </>
      )}>
      {done ? (
        <div className="flex items-start gap-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3.5">
          <CheckCircle2 size={20} className="text-green-500 shrink-0" />
          <div className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
            <div className="font-semibold text-nb-gray-800 dark:text-nb-gray-100">Container Exposed</div>
            <a href={`https://${done}`} target="_blank" rel="noreferrer" className="text-netbird hover:underline">{done}</a>
            <div className="mt-1 text-[0.8rem] text-nb-gray-500">Resource + service created. Certificate issuing may take a minute.</div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {tab === 'container' && (
            <>
              <Block label="Network" hint="The NetBird network of the Docker host (its routing peer resolves the container's DNS name).">
                <SelectMenu value={netId} onChange={(v) => { setNetId(v); setRouterPeerId(''); }} placeholder="Select a network…"
                  options={networks.map((n) => ({ value: n.id, label: n.name || n.id }))} />
              </Block>

              {netId && !detail.isLoading && (
                routers.length > 0 ? (
                  <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-300">
                    <Server size={14} className="text-green-500 shrink-0" />
                    <span>{routers.length} routing peer{routers.length === 1 ? '' : 's'} on this network - the container's domain will resolve there.</span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                    <div className="flex items-center gap-2 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-300">
                      <AlertTriangle size={14} className="text-amber-500 shrink-0" />
                      <span><b>No routing peer on this network.</b> Attach the peer that runs on the Docker host - without it the container's domain cannot be reached.</span>
                    </div>
                    <SelectMenu value={routerPeerId} onChange={setRouterPeerId} placeholder="Attach a routing peer…"
                      options={peers.map((pr) => ({ value: pr.id, label: `${pr.name || pr.dns_label || pr.id}${pr.ip ? ` (${pr.ip})` : ''}` }))} />
                  </div>
                )
              )}

              <div className="flex items-end gap-3 min-w-0">
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <div className="flex flex-col gap-0.5">
                    <Label>Container Domain</Label>
                    <FieldHint>The container's DNS name on the Docker network (domain format).</FieldHint>
                  </div>
                  <div className="flex items-stretch min-w-0">
                    <div className="w-[110px] shrink-0">
                      <PlainSelect joined="left" value={protocol} onChange={setProtocol}
                        options={[{ value: 'http', label: 'http://' }, { value: 'https', label: 'https://' }]} />
                    </div>
                    <Input className="flex-1 min-w-0 rounded-l-none! border-l-0!" value={containerDomain} onChange={(e) => setContainerDomain(e.target.value)} placeholder="e.g. grafana.internal" />
                  </div>
                </div>
                <div className="w-[130px] shrink-0 flex flex-col gap-1.5">
                  <Label>Container Port</Label>
                  <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="80" />
                </div>
              </div>

              <Block label="Location (Optional)" hint="Specify an optional path from where requests are routed to the container.">
                <div className="flex items-stretch min-w-0">
                  <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 text-sm text-nb-gray-500 whitespace-nowrap max-w-[55%] overflow-hidden text-ellipsis">
                    {DOMAIN_RE.test(containerDomain.trim().toLowerCase()) ? containerDomain.trim().toLowerCase() : 'container.domain'}
                  </span>
                  <span className="w-px bg-neutral-200 dark:bg-nb-gray-700" />
                  <Input className="flex-1 min-w-0 rounded-l-none! border-l-0!" value={path}
                    onChange={(e) => { const v = e.target.value; setPath(v && !v.startsWith('/') ? `/${v}` : v); }}
                    placeholder="/" />
                </div>
              </Block>
              {path.trim() && path.trim() !== '/' && (
                <ToggleRow icon={<CornerDownLeft size={15} />} label="Preserve Full Path"
                  help={`Keep the original full request path when forwarding (${path.trim()}/users stays ${path.trim()}/users). When disabled the matched prefix path is stripped.`}
                  checked={preservePath} onChange={setPreservePath} />
              )}

              <div className="border-t border-nb-gray-200 dark:border-nb-gray-800 pt-5 flex flex-col gap-5">
                <DomainField value={domain} onChange={setDomain} domains={domains} clusters={clusters} />
              </div>

              <FieldHint>
                What happens: {needsRouter && routerPeerId ? 'the routing peer is attached, ' : ''}a domain resource for the container is created in the network, then a service pointing at it. If any step fails, everything created here is removed again.
              </FieldHint>
            </>
          )}

          {tab === 'auth' && prot.authTab}

          {tab === 'access-control' && prot.accessTab}

          {tab === 'settings' && (
            <div className="flex flex-col gap-4">
              <Block label="Service Name (Optional)">
                <Input value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="Defaults to the domain" maxLength={80} />
              </Block>
              <ToggleRow icon={<Globe size={15} />} label="Pass Host Header"
                help="Forward the original Host header to the backend instead of rewriting it to the target address."
                checked={passHostHeader} onChange={setPassHostHeader} />
              <ToggleRow icon={<ArrowRight size={15} />} label="Rewrite Redirects"
                help="Rewrite Location headers in backend responses to use the public domain instead of the internal backend address."
                checked={rewriteRedirects} onChange={setRewriteRedirects} />
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      )}
    </Modal>

    {prot.modals}
    </>
  );
}
