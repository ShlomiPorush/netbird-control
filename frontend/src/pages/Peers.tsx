import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import {
  Monitor, Smartphone, Globe, History, Grid3x3, AlertTriangle, ShieldCheck, MonitorSmartphone,
  Filter, ChevronsUpDown, ChevronRight, Check, X, RefreshCw, Rows3, ExternalLink, ShieldOff,
  MapPin, Network, Flag, Trash2, ArrowRight, Tag as TagIcon, Clock3,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePeers } from '@/lib/queries';
import { useDeletePeer, useBulkDeletePeers, useNetbirdRefresh, useRevokeBypass, useBulkTagPeers } from '@/lib/mutations';
import { ComplianceIcon } from '@/components/peers/Compliance';
import { AddPeerButton, PeersEmptyState } from '@/components/peers/AddPeerModal';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useViewer } from '@/contexts/ViewerContext';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import type { Peer, PeerKind } from '@/lib/types';
import { SearchInput, Badge, Button, Checkbox, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td, CopyButton, ClearFiltersButton, RowMenu, MenuItem, HoverCard, FlagIcon, Pagination, PillTabs, Modal, Input, Field, FieldHint } from '@/components/ui';
import { UserSelect } from '@/components/logs/UserSelect';
import { formatTimestamp } from '@/lib/logfmt';
import { macQueryKey, macMatches } from '@/lib/str';
import { ToolbarMenu } from '@/components/logs/toolbar';

type StatusF = 'all' | 'online' | 'offline';
type ComplianceF = 'none' | 'non-compliant' | 'bypassed';

// Bulk "Add Tags": merges the chosen tags into every selected device's existing tags
// (nothing is removed; notes untouched). Suggestions come from tags already in use.
function BulkTagModal({ ids, suggestions, onClose, onDone }: {
  ids: string[]; suggestions: string[]; onClose: () => void; onDone: () => void;
}) {
  const bulkTag = useBulkTagPeers();
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const addTag = (raw: string) => {
    const v = raw.trim();
    if (!v || tags.includes(v)) { setInput(''); return; }
    setTags((p) => [...p, v]);
    setInput('');
  };
  const shownSuggestions = suggestions
    .filter((t) => !tags.includes(t) && (!input.trim() || t.toLowerCase().includes(input.trim().toLowerCase())))
    .slice(0, 8);

  const onApply = async () => {
    setError('');
    try {
      await bulkTag.mutateAsync({ ids, tags });
      onDone();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} size="md" icon={<TagIcon size={18} />}
      title="Add Tags"
      subtitle={`Tag ${ids.length} selected device${ids.length === 1 ? '' : 's'} - existing tags and notes are kept.`}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={onApply} disabled={!tags.length || bulkTag.isPending}>
          {bulkTag.isPending ? 'Tagging…' : `Add To ${ids.length} Device${ids.length === 1 ? '' : 's'}`}
        </Button>
      </>}>
      <div className="flex flex-col gap-3">
        <Field label="Tags">
          {tags.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-md border border-nb-gray-200 dark:border-nb-gray-800/60 bg-nb-gray-100 dark:bg-nb-gray-930/60 px-2 py-0.5 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-200">
                  <TagIcon size={11} className="text-nb-gray-400" /> {t}
                  <button onClick={() => setTags((p) => p.filter((x) => x !== t))} title="Remove" className="text-nb-gray-400 hover:text-red-500"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <Input value={input} autoFocus
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(input); } }}
            placeholder="Type a tag and press Enter…" />
          <FieldHint>Tags are merged into each device's existing tags - nothing is removed.</FieldHint>
        </Field>
        {shownSuggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[0.72rem] text-nb-gray-400">Existing:</span>
            {shownSuggestions.map((t) => (
              <button key={t} onClick={() => addTag(t)}
                className="rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 px-2 py-0.5 text-[0.74rem] text-nb-gray-500 hover:text-netbird hover:border-netbird transition-colors">
                + {t}
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

// Small operational-tag chips under the device name (max 3 shown; the note becomes a
// tooltip on the tag row). Editing lives on the peer's detail page.
function PeerTagChips({ tags, note }: { tags?: string[]; note?: string }) {
  if (!tags?.length) return null;
  const shown = tags.slice(0, 3);
  return (
    <div className="mt-0.5 flex items-center gap-1 flex-wrap" title={note || undefined}>
      {shown.map((t) => (
        <span key={t} className="inline-flex items-center gap-0.5 rounded border border-nb-gray-200 dark:border-nb-gray-800/60 bg-nb-gray-100 dark:bg-nb-gray-930/60 px-1.5 py-px text-[0.68rem] text-nb-gray-500 dark:text-nb-gray-400">
          <TagIcon size={9} /> {t}
        </span>
      ))}
      {tags.length > shown.length && <span className="text-[0.68rem] text-nb-gray-400">+{tags.length - shown.length}</span>}
    </div>
  );
}

const OS_ORDER = ['windows', 'mac', 'linux', 'android', 'ios', 'other'];
const OS_LABEL: Record<string, string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS', other: 'Other' };
const STATUS_OPTS: { v: StatusF; label: string; dot: string }[] = [
  { v: 'all', label: 'All', dot: 'bg-nb-gray-400' },
  { v: 'online', label: 'Online', dot: 'bg-green-500' },
  { v: 'offline', label: 'Offline', dot: 'bg-nb-gray-500 dark:bg-nb-gray-600' },
];

function osKindOf(os?: string): string {
  const o = (os || '').toLowerCase();
  if (o.includes('windows')) return 'windows';
  if (o.includes('android')) return 'android';
  if (o.includes('ios') || o.includes('iphone') || o.includes('ipad')) return 'ios';
  if (o.includes('mac') || o.includes('darwin') || o.includes('os x')) return 'mac';
  if (o.includes('linux') || o.includes('debian') || o.includes('ubuntu') || o.includes('fedora') || o.includes('centos') || o.includes('redhat')) return 'linux';
  return 'other';
}

// Country flag from /public/images/flags, falling back to a globe for unknown/missing codes.
function relativeTime(iso?: string): string {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '-';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24); if (d === 1) return 'a day ago'; if (d < 30) return `${d} days ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.floor(mo / 12); return `${y} year${y === 1 ? '' : 's'} ago`;
}

const KIND_META: Record<PeerKind, { label: string; desc: string }> = {
  'user-device': {
    label: 'User Devices',
    desc: 'Laptops, phones and other personal devices with a user behind them, typically added when the user signs in with SSO.',
  },
  server: {
    label: 'Servers',
    desc: 'Machines without a user behind them - servers, routers and other infrastructure peers, typically added with a setup key.',
  },
};

export default function Peers() {
  const navigate = useNavigate();
  const { viewer, restricted, isAdmin, can } = useViewer();
  // Non-admins normally see only their own devices; 'peers.all' lifts that, and so does
  // 'networks.manage' (its holders get the full peers list for routing-peer selection).
  const limited = restricted && !can('peers.all') && !can('networks.manage');
  const canBulk = isAdmin;
  const del = useDeletePeer();
  const bulkDel = useBulkDeletePeers();
  const revokeBypass = useRevokeBypass();
  const confirm = useConfirm();
  const [kind, setKind] = useState<PeerKind>('user-device');
  const [search, setSearch] = useState('');
  // Deep-linkable status filter (?status=online) - the Dashboard's Peers Online tile lands here
  // pre-filtered to connected peers.
  const [urlParams] = useSearchParams();
  const [status, setStatus] = useState<StatusF>(() => {
    const s = urlParams.get('status');
    return s === 'online' || s === 'offline' ? s : 'all';
  });
  const [osKinds, setOsKinds] = useState<string[]>([]);
  const [groupSel, setGroupSel] = useState<string[]>([]);
  const [compliance, setCompliance] = useState<ComplianceF>('none');
  const [staleDays, setStaleDays] = useState(0); // 0 = off; otherwise "not seen for N+ days"
  const [tagSel, setTagSel] = useState<string[]>([]); // operational-tag filter
  const [user, setUser] = useState(''); // owner filter (by e-mail)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const pq = usePeers();
  const refresh = useNetbirdRefresh();

  const list = pq.data || [];
  const kindList = useMemo(() => list.filter((p) => limited || p.kind === kind), [list, kind, limited]);

  const osOptions = useMemo(() => {
    const present = new Set(kindList.map((p) => osKindOf(p.os)));
    return OS_ORDER.filter((k) => present.has(k));
  }, [kindList]);
  const groupOptions = useMemo(() => {
    const s = new Set<string>();
    kindList.forEach((p) => (p.groups || []).forEach((g) => s.add(g)));
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [kindList]);
  const tagOptions = useMemo(() => {
    const s = new Set<string>();
    kindList.forEach((p) => (p.tags || []).forEach((t) => s.add(t)));
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [kindList]);
  const anyFilter = status !== 'all' || osKinds.length > 0 || groupSel.length > 0 || compliance !== 'none' || staleDays > 0 || tagSel.length > 0 || !!user;
  // "Empty account" = no peers of ANY kind and nothing filtered away, so the onboarding screen
  // never hides rows that a filter (or the kind tab) merely excluded.
  const noPeersAtAll = list.length === 0 && !search && !anyFilter;

  // Distinct device owners for the user filter (built from the peers themselves, keyed by email).
  const ownerList = useMemo(() => {
    const m = new Map<string, { id: string; name: string; email: string }>();
    for (const p of kindList) {
      const email = (p.owner_email || '').toLowerCase();
      if (!email) continue;
      if (!m.has(email)) m.set(email, { id: email, name: p.owner_email || email, email: p.owner_email || email });
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [kindList]);

  const nonCompliantCount = useMemo(() => kindList.filter((p) => p.approval_required && !p.force_approved).length, [kindList]);
  const bypassedCount = useMemo(() => kindList.filter((p) => p.force_approved).length, [kindList]);

  // Stale = disconnected AND not seen for at least N days (candidates for cleanup).
  const isStale = (p: Peer, days: number) => {
    if (p.connected) return false;
    const t = p.last_seen ? new Date(p.last_seen).getTime() : 0;
    return !t || Date.now() - t > days * 86400_000;
  };

  const rows = useMemo(() => {
    const q = search.toLowerCase().trim();
    const macKey = macQueryKey(q);
    return kindList.filter((p) => {
      if (status === 'online' && !p.connected) return false;
      if (status === 'offline' && p.connected) return false;
      if (osKinds.length && !osKinds.includes(osKindOf(p.os))) return false;
      if (groupSel.length && !(p.groups || []).some((g) => groupSel.includes(g))) return false;
      if (compliance === 'non-compliant' && !(p.approval_required && !p.force_approved)) return false;
      if (compliance === 'bypassed' && !p.force_approved) return false;
      if (staleDays > 0 && !isStale(p, staleDays)) return false;
      if (tagSel.length && !(p.tags || []).some((t) => tagSel.includes(t))) return false;
      if (user && (p.owner_email || '').toLowerCase() !== user.toLowerCase()) return false;
      return !q ||
        (p.name || '').toLowerCase().includes(q) ||
        (p.ip || '').toLowerCase().includes(q) ||
        (p.dns_label || '').toLowerCase().includes(q) ||
        (p.owner_email || '').toLowerCase().includes(q) ||
        (p.groups || []).some((g) => g.toLowerCase().includes(q)) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(q)) ||
        (p.note || '').toLowerCase().includes(q) ||
        (!!macKey && (p.network_addresses || []).some((a) => macMatches(a.mac, macKey)));
    });
  }, [kindList, search, status, osKinds, groupSel, compliance, staleDays, tagSel, user]);

  const { sorted, state } = useTableSort(rows, {
    name: (p) => p.name || '',
    address: (p) => p.dns_label || p.ip || '',
    groups: (p) => p.group_count ?? (p.groups || []).length,
    last_seen: (p) => (p.connected ? Date.now().toString() : p.last_seen || ''),
    version: (p) => p.version || '',
  });

  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } =
    useClientPagination(sorted, 25, [kind, search, status, osKinds, groupSel, compliance, staleDays, user]);

  // ── Bulk selection (admin) - "select all" applies to the visible page ──
  const selectableIds = useMemo(() => pageRows.map((p) => p.id), [pageRows]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelected = selectableIds.some((id) => selected.has(id));
  useEffect(() => { setSelected(new Set()); }, [kind, search, status, osKinds, groupSel, compliance, staleDays, user]);
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allSelected) selectableIds.forEach((id) => next.delete(id)); else selectableIds.forEach((id) => next.add(id));
    return next;
  });
  const toggleOne = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const onBulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const ok = await confirm({
      title: `Delete ${ids.length} peer${ids.length === 1 ? '' : 's'}?`,
      message: `${ids.length} selected peer${ids.length === 1 ? '' : 's'} will be removed from NetBird. The device${ids.length === 1 ? '' : 's'} will lose access until re-enrolled. This can't be undone.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      const res = await bulkDel.mutateAsync(ids);
      setSelected(new Set());
      if (res?.failed?.length) await confirm({ title: `${res.failed.length} couldn’t be deleted`, message: res.failed.map((f) => `• ${f.error}`).join('\n'), confirmText: 'OK' });
    } catch (e) { await confirm({ title: 'Delete failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  const onDeleteOne = async (p: Peer) => {
    const ok = await confirm({
      title: 'Delete peer?',
      message: `"${p.name || p.id}" will be removed from NetBird. The device will lose access until re-enrolled. This can't be undone.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try { await del.mutateAsync(p.id); }
    catch (e) { await confirm({ title: 'Delete failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  // The server allows removing a bypass for admins and for the device's owner.
  const canRevokeBypass = (p: Peer) =>
    !!p.force_approved && (isAdmin || (!!viewer.email && (p.owner_email || '').toLowerCase() === viewer.email.toLowerCase()));
  const onRemoveBypass = async (p: Peer) => {
    const ok = await confirm({
      title: 'Revoke Bypass',
      message: `Remove the compliance bypass from "${p.name || p.dns_label || p.id}"? The device will be blocked again until it passes the compliance checks.`,
      confirmText: 'Revoke Bypass',
    });
    if (!ok) return;
    try { await revokeBypass.mutateAsync(p.id); }
    catch (e) { await confirm({ title: 'Failed to remove the bypass', message: (e as Error).message, confirmText: 'OK' }); }
  };

  const meta = KIND_META[kind];
  const heading = limited ? `${kindList.length} Device${kindList.length === 1 ? '' : 's'}` : `${kindList.length} ${meta.label}`;

  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm mb-3 text-nb-gray-400">
        <Monitor size={14} /> Peers
        {!limited && <><span className="text-nb-gray-300 dark:text-nb-gray-700">›</span> {meta.label}</>}
      </div>

      {/* Primary action sits beside the page title, as on the Users / Networks pages. Adding a
          peer works while managing an MSP tenant too - the API call carries the tenant context. */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-nb-gray-900 dark:text-nb-gray-50">{heading}</h1>
          <p className="mt-1 mb-5 text-sm text-nb-gray-500 dark:text-nb-gray-400 max-w-2xl">
            {limited ? 'Your devices connected to the network.' : meta.desc}
          </p>
        </div>
        <AddPeerButton />
      </div>

      {!limited && (
        <PillTabs
          className="mb-5"
          items={(Object.keys(KIND_META) as PeerKind[]).map((k) => ({ key: k, label: KIND_META[k].label }))}
          value={kind}
          // Switching kind also resets the per-kind filters, exactly as before.
          onChange={(k) => { setKind(k as PeerKind); setCompliance('none'); setStatus('all'); setOsKinds([]); setGroupSel([]); }}
        />
      )}

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, IP, MAC, owner or group…" />
        <PeersFilters
          status={status} setStatus={setStatus}
          osKinds={osKinds} setOsKinds={setOsKinds} osOptions={osOptions}
          groupSel={groupSel} setGroupSel={setGroupSel} groupOptions={groupOptions}
          staleDays={staleDays} setStaleDays={setStaleDays}
          tagSel={tagSel} setTagSel={setTagSel} tagOptions={tagOptions}
        />
        <CompBtn active={compliance === 'non-compliant'} onClick={() => setCompliance((c) => (c === 'non-compliant' ? 'none' : 'non-compliant'))}
          icon={<AlertTriangle size={15} />} label="Non-Compliant" count={nonCompliantCount} />
        {bypassedCount > 0 && (
          <CompBtn active={compliance === 'bypassed'} onClick={() => setCompliance((c) => (c === 'bypassed' ? 'none' : 'bypassed'))}
            icon={<ShieldCheck size={15} />} label="Bypassed" count={bypassedCount} />
        )}
        {ownerList.length > 0 && <UserSelect users={ownerList} value={user} onChange={setUser} />}
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton
          active={!!search || anyFilter}
          onClear={() => { setSearch(''); setStatus('all'); setOsKinds([]); setGroupSel([]); setCompliance('none'); setStaleDays(0); setUser(''); }}
        />
        <Button variant="secondary" className="ml-auto !px-0 w-[42px]" title="Refresh" onClick={async () => { await refresh.mutateAsync().catch(() => { }); pq.refetch(); }}>
          <RefreshCw size={16} className={(refresh.isPending || pq.isFetching) ? 'animate-spin' : undefined} />
        </Button>
      </div>

      {canBulk && selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-3 py-2 rounded-md border border-netbird/30 bg-netbird/5">
          <span className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">{selected.size} selected</span>
          <Button variant="secondary" size="sm" onClick={() => setBulkTagOpen(true)}>
            <TagIcon size={14} /> Add Tags
          </Button>
          <Button variant="danger" size="sm" onClick={onBulkDelete} disabled={bulkDel.isPending}>
            <Trash2 size={14} /> {bulkDel.isPending ? 'Deleting…' : `Delete ${selected.size}`}
          </Button>
          <button onClick={() => setSelected(new Set())} className="text-[0.8rem] text-nb-gray-500 hover:underline">Clear</button>
        </div>
      )}
      {bulkTagOpen && (
        <BulkTagModal
          ids={[...selected]}
          suggestions={tagOptions}
          onClose={() => setBulkTagOpen(false)}
          onDone={() => { setBulkTagOpen(false); setSelected(new Set()); }}
        />
      )}

      {pq.isLoading ? <LoadingState /> : noPeersAtAll ? (
        // Nothing enrolled yet (and nothing filtered away) - the official onboarding screen
        // replaces the table so the only thing to do is add the first machine.
        <PeersEmptyState />
      ) : !sorted.length ? (
        <EmptyState title="No Peers" hint={search || anyFilter ? 'No peers match your filters.' : 'Peers are loaded from the NetBird API.'} icon={<Monitor size={22} />} />
      ) : (
        <>
        <div className="hidden md:block">
        <Table>
          <THead>
            {canBulk && (
              <Th className="w-10 pl-2">
                <input type="checkbox" aria-label="Select all"
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  checked={allSelected} onChange={toggleAll}
                  className="h-4 w-4 align-middle rounded border-nb-gray-300 dark:border-nb-gray-700 accent-netbird focus:ring-netbird/40" />
              </Th>
            )}
            <SortTh label="Name" sortKey="name" state={state} />
            <Th className="w-8">{''}</Th>
            <SortTh label="Address" sortKey="address" state={state} />
            <SortTh label="Groups" sortKey="groups" state={state} />
            <SortTh label="Last Seen" sortKey="last_seen" state={state} />
            <SortTh label="Version" sortKey="version" state={state} />
            <Th className="w-10">{''}</Th>
          </THead>
          <TBody>
            {pageRows.map((p) => (
              <Tr key={p.id} onClick={() => navigate(`/peers/${encodeURIComponent(p.id)}`)} className={selected.has(p.id) ? '!bg-netbird/[0.06]' : undefined}>
                {canBulk && (
                  <Td className="pl-2" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} />
                  </Td>
                )}
                <Td>
                  <div className="flex items-center gap-2.5">
                    <span className={cn('h-2 w-2 rounded-full shrink-0', p.connected ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} title={p.connected ? 'Connected' : 'Disconnected'} />
                    <div className="min-w-0">
                      <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate">{p.name || '-'}</div>
                      {p.owner_email && <div className="text-[0.72rem] text-nb-gray-500 truncate">{p.owner_email}</div>}
                      <PeerTagChips tags={p.tags} note={p.note} />
                      {p.approval_required && !p.force_approved && p.disapproval_reason && (
                        <div className="text-[0.7rem] text-red-500 truncate" title={p.disapproval_reason}>Blocked: {p.disapproval_reason}</div>
                      )}
                    </div>
                  </div>
                </Td>
                <Td className="text-center"><ComplianceIcon peer={p} /></Td>
                <Td onClick={(e) => e.stopPropagation()}><PeerAddressCell peer={p} /></Td>
                <Td onClick={(e) => e.stopPropagation()}><PeerGroupsCell groups={p.groupRefs || []} /></Td>
                <Td>
                  <div className="flex flex-col items-start">
                    <span className="inline-flex items-center gap-1.5 text-[0.82rem] text-nb-gray-500">
                      <History size={13} className="shrink-0" /> {p.connected ? 'just now' : relativeTime(p.last_seen)}
                    </span>
                    <SessionTag p={p} />
                  </div>
                </Td>
                <Td>
                  <div className="text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">{p.version || '-'}</div>
                  {p.os && <div className="mt-0.5 flex items-center gap-1.5 text-[0.72rem] text-nb-gray-500 truncate"><OsIcon os={p.os} /> {p.os}</div>}
                </Td>
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <PeerMenu onView={() => navigate(`/peers/${encodeURIComponent(p.id)}`)} onRemoveBypass={canRevokeBypass(p) ? () => onRemoveBypass(p) : undefined} onDelete={canBulk ? () => onDeleteOne(p) : undefined} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        </div>

        {/* Mobile: cards instead of a wide table */}
        <div className="md:hidden flex flex-col gap-2.5">
          {pageRows.map((p) => (
            <div key={p.id} onClick={() => navigate(`/peers/${encodeURIComponent(p.id)}`)}
              className={cn('rounded-lg border bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors',
                selected.has(p.id) ? 'border-netbird/40 !bg-netbird/[0.06]' : 'border-nb-gray-200 dark:border-nb-gray-800')}>
              <div className="flex items-start gap-2.5">
                {canBulk && (
                  <span className="pt-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} />
                  </span>
                )}
                <span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', p.connected ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{p.name || '-'}</span>
                    <ComplianceIcon peer={p} />
                  </div>
                  {p.owner_email && <div className="text-[0.72rem] text-nb-gray-500 truncate">{p.owner_email}</div>}
                  <PeerTagChips tags={p.tags} note={p.note} />
                  {p.approval_required && !p.force_approved && p.disapproval_reason && (
                    <div className="text-[0.7rem] text-red-500 truncate">Blocked: {p.disapproval_reason}</div>
                  )}
                </div>
                <div className="shrink-0 -mt-1 -mr-1" onClick={(e) => e.stopPropagation()}>
                  <PeerMenu onView={() => navigate(`/peers/${encodeURIComponent(p.id)}`)} onRemoveBypass={canRevokeBypass(p) ? () => onRemoveBypass(p) : undefined} onDelete={canBulk ? () => onDeleteOne(p) : undefined} />
                </div>
              </div>
              <div className="mt-2.5" onClick={(e) => e.stopPropagation()}><PeerAddressCell peer={p} /></div>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.78rem] text-nb-gray-500" onClick={(e) => e.stopPropagation()}>
                <PeerGroupsCell groups={p.groupRefs || []} />
                <span className="inline-flex items-center gap-1.5"><History size={13} /> {p.connected ? 'just now' : relativeTime(p.last_seen)}</span>
                {p.version && <span className="inline-flex items-center gap-1.5"><OsIcon os={p.os || ''} /> {p.version}{p.os ? ` · ${p.os}` : ''}</span>}
                <SessionTag p={p} />
              </div>
            </div>
          ))}
        </div>
        <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label={kind === 'server' ? 'servers' : 'devices'} />
        </>
      )}
    </div>
  );
}

function PeerAddressCell({ peer }: { peer: Peer }) {
  const short = (peer.dns_label || '').split('.')[0] || peer.dns_label || '';
  return (
    <HoverCard
      width={320}
      className="flex flex-col gap-2.5"
      trigger={
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 flex items-center"><FlagIcon cc={peer.country_code} /></span>
          <div className="min-w-0">
            <div className="text-sm text-nb-gray-700 dark:text-nb-gray-300 truncate">{short || '-'}</div>
            <div className="text-[0.78rem] font-mono text-nb-gray-500 truncate">{peer.ip || '-'}</div>
          </div>
        </div>
      }
    >
      <AddrRow icon={<MapPin size={14} />} label="NetBird IP" value={peer.ip} mono />
      <AddrRow icon={<Network size={14} />} label="Public IP" value={peer.connection_ip} mono />
      <AddrRow icon={<Globe size={14} />} label="Domain" value={peer.dns_label} mono />
      <AddrRow icon={peer.country_code ? <FlagIcon cc={peer.country_code} /> : <Flag size={14} />} label="Region" value={peer.geo} />
    </HoverCard>
  );
}

function AddrRow({ icon, label, value, mono }: { icon: React.ReactNode; label: string; value?: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="inline-flex items-center gap-2 text-nb-gray-500 shrink-0">{icon} {label}</span>
      <span className="inline-flex items-center gap-1.5 min-w-0">
        <span className={cn('text-nb-gray-800 dark:text-nb-gray-200 truncate', mono ? 'font-mono text-[0.8rem]' : 'text-[0.82rem]')}>{value}</span>
        <CopyButton value={value} />
      </span>
    </div>
  );
}

function PeerGroupsCell({ groups }: { groups: { id: string; name: string; peers_count: number }[] }) {
  if (!groups.length) return <span className="text-nb-gray-500 text-sm">-</span>;
  return (
    <HoverCard
      width={340}
      trigger={<Badge tone="gray" icon={<Grid3x3 size={11} />} className="cursor-default">{groups.length} Group{groups.length === 1 ? '' : 's'}</Badge>}
    >
      <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-2.5">Assigned Groups</div>
      <div className="nb-scroll flex flex-col gap-2 max-h-72 overflow-y-auto overflow-x-hidden pr-1">
        {groups.map((g) => (
          <div key={g.id || g.name} className="flex items-center gap-2.5 min-w-0">
            {/* The group name opens the group; the peer count opens it straight on the Peers tab.
                Name takes the remaining width and truncates so a long name can't push the row past
                the popup's edge (which would otherwise force a horizontal scrollbar). */}
            <Link to={`/groups/${encodeURIComponent(g.id)}`} className="min-w-0 flex-1" title={`Open ${g.name}`}>
              <Badge tone="gray" icon={<Grid3x3 size={11} className="shrink-0" />} className="flex w-full min-w-0 hover:border-netbird/40 hover:text-netbird">
                <span className="truncate">{g.name}</span>
              </Badge>
            </Link>
            <ArrowRight size={14} className="text-nb-gray-400 shrink-0" />
            <Link to={`/groups/${encodeURIComponent(g.id)}?tab=peers`} className="shrink-0" title="View this group's peers">
              <Badge tone="gray" className="hover:border-netbird/40 hover:text-netbird" icon={<MonitorSmartphone size={11} />}>{g.peers_count} Peer{g.peers_count === 1 ? '' : 's'}</Badge>
            </Link>
          </div>
        ))}
      </div>
    </HoverCard>
  );
}

// SSO session-expiry tag for user devices: amber when less than a day is left, red when
// the session already expired (the user must log in again). Servers have no session.
function SessionTag({ p }: { p: Peer }) {
  if (p.kind !== 'user-device') return null;
  if (p.login_expired) {
    return (
      <span className="mt-1 inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[0.68rem] font-medium text-red-500">
        <Clock3 size={10} /> Session Expired
      </span>
    );
  }
  if (!p.session_expires_at) return null;
  const ms = new Date(p.session_expires_at).getTime() - Date.now();
  const label = ms <= 0 ? 'Due Now'
    : ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60000))}m Left`
      : ms < 86400_000 ? `${Math.round(ms / 3600_000)}h Left`
        : `${Math.round(ms / 86400_000)}d Left`;
  const soon = ms < 86400_000;
  return (
    <span title={`Session expires ${formatTimestamp(p.session_expires_at)}`}
      className={cn('mt-1 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.68rem] font-medium',
        soon ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
          : 'border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500')}>
      <Clock3 size={10} /> Session {label}
    </span>
  );
}

function OsIcon({ os }: { os: string }) {
  const o = os.toLowerCase();
  if (o.includes('android') || o.includes('ios') || o.includes('iphone') || o.includes('ipad')) return <Smartphone size={12} className="shrink-0" />;
  return <Monitor size={12} className="shrink-0" />;
}

function CompBtn({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number }) {
  return (
    <button onClick={onClick}
      className={cn('inline-flex items-center gap-2 h-[42px] px-3.5 rounded-md text-sm border shadow-sm transition-colors',
        active ? 'border-netbird/50 bg-netbird/10 text-netbird'
               : 'bg-white border-nb-gray-200 text-nb-gray-700 hover:bg-nb-gray-100 dark:bg-nb-gray-920 dark:border-nb-gray-700/40 dark:text-nb-gray-300 dark:hover:bg-nb-gray-910')}>
      {icon} {label}
      <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-netbird text-white text-[0.7rem] font-semibold">{count}</span>
    </button>
  );
}

// NetBird-style Filters dropdown: Status / OS / Groups / Inactive, each a hover flyout submenu.
const STALE_OPTS = [
  { v: 0, label: 'Any' },
  { v: 30, label: '30+ Days' },
  { v: 60, label: '60+ Days' },
  { v: 90, label: '90+ Days' },
];
function PeersFilters({ status, setStatus, osKinds, setOsKinds, osOptions, groupSel, setGroupSel, groupOptions, staleDays, setStaleDays, tagSel, setTagSel, tagOptions }: {
  status: StatusF; setStatus: (v: StatusF) => void;
  osKinds: string[]; setOsKinds: (v: string[]) => void; osOptions: string[];
  groupSel: string[]; setGroupSel: (v: string[]) => void; groupOptions: string[];
  staleDays: number; setStaleDays: (v: number) => void;
  tagSel: string[]; setTagSel: (v: string[]) => void; tagOptions: string[];
}) {
  const [open, setOpen] = useState(false);
  const active = (status !== 'all' ? 1 : 0) + (osKinds.length ? 1 : 0) + (groupSel.length ? 1 : 0) + (staleDays > 0 ? 1 : 0) + (tagSel.length ? 1 : 0);
  const toggleOs = (k: string) => setOsKinds(osKinds.includes(k) ? osKinds.filter((x) => x !== k) : [...osKinds, k]);
  const toggleGroup = (g: string) => setGroupSel(groupSel.includes(g) ? groupSel.filter((x) => x !== g) : [...groupSel, g]);
  const toggleTag = (t: string) => setTagSel(tagSel.includes(t) ? tagSel.filter((x) => x !== t) : [...tagSel, t]);

  return (
    <div className="relative">
      <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
        <Filter size={16} /> Filters
        {active > 0 && <span className="ml-0.5 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-netbird text-white text-[0.65rem] font-semibold">{active}</span>}
        <ChevronsUpDown size={14} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1.5 z-50 w-52 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
            <SubMenu label="Status" badge={status !== 'all' ? 1 : 0}>
              {STATUS_OPTS.map((o) => (
                <OptionRow key={o.v} radio selected={status === o.v} onClick={() => setStatus(o.v)}>
                  <span className={cn('h-2 w-2 rounded-full', o.dot)} /> {o.label}
                </OptionRow>
              ))}
            </SubMenu>
            <SubMenu label="OS" badge={osKinds.length} disabled={!osOptions.length}>
              {osOptions.map((k) => (
                <OptionRow key={k} selected={osKinds.includes(k)} onClick={() => toggleOs(k)}>{OS_LABEL[k] || k}</OptionRow>
              ))}
            </SubMenu>
            <SubMenu label="Groups" badge={groupSel.length} disabled={!groupOptions.length}>
              <div className="nb-scroll max-h-60 overflow-y-auto">
                {groupOptions.map((g) => (
                  <OptionRow key={g} selected={groupSel.includes(g)} onClick={() => toggleGroup(g)}><span className="truncate">{g}</span></OptionRow>
                ))}
              </div>
            </SubMenu>
            <SubMenu label="Tags" badge={tagSel.length} disabled={!tagOptions.length}>
              <div className="nb-scroll max-h-60 overflow-y-auto">
                {tagOptions.map((t) => (
                  <OptionRow key={t} selected={tagSel.includes(t)} onClick={() => toggleTag(t)}><span className="truncate">{t}</span></OptionRow>
                ))}
              </div>
            </SubMenu>
            {/* Stale devices: offline and not seen for N+ days - candidates for cleanup
                (select them all and bulk-delete after review). */}
            <SubMenu label="Inactive" badge={staleDays > 0 ? 1 : 0}>
              {STALE_OPTS.map((o) => (
                <OptionRow key={o.v} radio selected={staleDays === o.v} onClick={() => setStaleDays(o.v)}>{o.label}</OptionRow>
              ))}
            </SubMenu>
            {active > 0 && (
              <>
                <div className="my-1 border-t border-nb-gray-100 dark:border-nb-gray-900" />
                <button onClick={() => { setStatus('all'); setOsKinds([]); setGroupSel([]); setStaleDays(0); setTagSel([]); }}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded text-sm text-nb-gray-500 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
                  <X size={14} /> Clear all
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SubMenu({ label, badge, disabled, children }: { label: string; badge?: number; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('group/sub relative', disabled && 'opacity-40 pointer-events-none')}>
      <button className="flex items-center justify-between w-full px-2.5 py-1.5 rounded text-sm text-nb-gray-700 dark:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
        <span>{label}</span>
        <span className="flex items-center gap-1.5">
          {badge ? <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-netbird text-white text-[0.6rem] font-semibold">{badge}</span> : null}
          <ChevronRight size={14} className="text-nb-gray-400" />
        </span>
      </button>
      <div className="invisible opacity-0 group-hover/sub:visible group-hover/sub:opacity-100 transition-opacity absolute left-full top-0 z-50 w-48 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
        {children}
      </div>
    </div>
  );
}

function OptionRow({ radio, selected, onClick, children }: { radio?: boolean; selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn('flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded text-sm', selected ? 'bg-netbird/10 text-netbird' : 'text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900')}>
      {!radio && (
        <span className={cn('flex items-center justify-center h-4 w-4 rounded border shrink-0', selected ? 'bg-netbird border-netbird text-white' : 'border-nb-gray-300 dark:border-nb-gray-600')}>
          {selected && <Check size={11} />}
        </span>
      )}
      {children}
    </button>
  );
}

function PeerMenu({ onView, onRemoveBypass, onDelete }: { onView: () => void; onRemoveBypass?: () => void; onDelete?: () => void }) {
  return (
    <RowMenu width={176}>
      {(close) => (
        <>
          <MenuItem icon={<ExternalLink size={14} />} onClick={() => { close(); onView(); }}>View details</MenuItem>
          {onRemoveBypass && <MenuItem icon={<ShieldOff size={14} />} onClick={() => { close(); onRemoveBypass(); }}>Revoke Bypass</MenuItem>}
          {onDelete && <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { close(); onDelete(); }}>Delete peer</MenuItem>}
        </>
      )}
    </RowMenu>
  );
}
