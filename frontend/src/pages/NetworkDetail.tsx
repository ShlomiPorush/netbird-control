import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  GitFork, ChevronRight, Server, ShieldCheck, ExternalLink, Layers, Monitor,
  Plus, Pencil, Copy as CopyIcon, Trash2, Settings as Gear, Grid3x3, Filter, ChevronsUpDown, Check, X, Share2,
  Power, VenetianMask, Settings2, ArrowDownNarrowWide, Eye, Ban, Combine, AlertTriangle, ArrowRight, HelpCircle,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/str';
import { useNetworks, useNetworkDetail, usePeers, useGroups, useBlocklist, useResourceConflicts } from '@/lib/queries';
import { useDeleteResource, useBulkDeleteResources, useMergeResources, useMoveResources, useCreateRouter, useDeleteRouter, useToggleResource } from '@/lib/mutations';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { Rows3 } from 'lucide-react';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useViewer } from '@/contexts/ViewerContext';
import { useTableSort } from '@/lib/useTableSort';
import { ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { useUrlTab } from '@/lib/useUrlTab';
import type { Resource, Router, Policy } from '@/lib/types';
import { SearchInput, Badge, EmptyState, LoadingState, Button, IconButton, Copyable, Modal, Input, GroupMultiSelect, Tabs, PillTabs, Label, FieldHint, Pagination, ClearFiltersButton, SortTh, SelectMenu } from '@/components/ui';
import { ResourceModal } from '@/components/networks/ResourceModal';
import { AddFromNetworkModal } from '@/components/settings/Blocklist';
import { NetworkModal } from '@/components/networks/NetworkModal';
import { PolicyTable, type PolicyRow } from '@/components/networks/PolicyTable';

type Tab = 'resources' | 'routers' | 'policies';
type StatusF = 'all' | 'active' | 'inactive';
type PolicyF = 'all' | 'with' | 'without';

export default function NetworkDetail() {
  const { id = '' } = useParams();
  const confirm = useConfirm();

  const net = (useNetworks().data || []).find((n) => n.id === id);
  const canEdit = !!net?.canEdit;
  // Network-level management (rename/delete, bulk ops): admins or 'Manage All Networks' holders.
  // Regular per-network editors still get per-row edit/delete via canEdit.
  const { isAdmin, can } = useViewer();
  const canManage = isAdmin || can('networks.manage');
  const canBulk = canManage;
  const [editNet, setEditNet] = useState(false);
  const { data: detail, isLoading } = useNetworkDetail(id);
  const del = useDeleteResource(id);
  const bulkDel = useBulkDeleteResources(id);
  const toggleRes = useToggleResource(id);

  const onToggleEnabled = async (r: Resource) => {
    try { await toggleRes.mutateAsync({ rid: r.id, enabled: r.enabled === false }); }
    catch (e) { await confirm({ title: 'Update failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  const [searchParams] = useSearchParams();
  // Deep-linkable tab (?tab=routers) that also UPDATES the URL on switch, like Settings.
  const [tab, setTab] = useUrlTab<Tab>(['resources', 'routers', 'policies'], 'resources');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusF>('all');
  const [policyFilter, setPolicyFilter] = useState<PolicyF>('all');
  const [groupFilter, setGroupFilter] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // duplicate: true = `resource` is the SOURCE to copy; the modal opens prefilled and saving creates a NEW resource.
  const [modal, setModal] = useState<{ resource: Resource | null; tab: 'resource' | 'access'; duplicate?: boolean } | null>(null);
  // "Add To Blocklist" for the selected rows - same modal as Operations → Blocklist, prefilled.
  const [blockOpen, setBlockOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // Merge launched straight from a conflict banner row: preselected rows (may span networks).
  const [mergeRows, setMergeRows] = useState<MergeRow[] | null>(null);
  const conflicts = (useResourceConflicts(canManage).data?.conflicts || [])
    .filter((c) => (c.networks || [{ id: c.networkId }]).some((n) => n.id === id));
  const blocklistEntries = useBlocklist(isAdmin).data || [];
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);

  const resources = detail?.resources || [];
  const routers = detail?.routers || [];
  const policies = detail?.policies || [];
  const name = detail?.name || net?.name || '';
  // Routing-PEER count (a router entry with a peer group can hold several peers) - the same
  // `routing_peers_count` the official dashboard reads; router rows are only a fallback.
  const routingPeers = net?.routingPeers ?? routers.length;
  const isHighlyAvailable = routingPeers >= 2;

  // Deep-link: `?resource=<id>` (e.g. from a group's Resources tab) opens that resource once.
  const resourceParam = searchParams.get('resource');
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!resourceParam || !resources.length || openedRef.current === resourceParam) return;
    const r = resources.find((x) => x.id === resourceParam);
    if (r) { setModal({ resource: r, tab: 'resource' }); openedRef.current = resourceParam; }
  }, [resourceParam, resources]);

  // Distinct groups present across the network's resources (drives the Groups filter).
  const availableGroups = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of resources) for (const g of (r.groups || [])) m.set(g.id, g.name || g.id);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [resources]);
  const groupName = (id: string) => availableGroups.find((g) => g.id === id)?.name || id;

  const filteredResources = useMemo(() => {
    const q = search.toLowerCase().trim();
    const gset = new Set(groupFilter);
    return resources.filter((r) => {
      if (statusFilter === 'active' && r.enabled === false) return false;
      if (statusFilter === 'inactive' && r.enabled !== false) return false;
      const pc = r.policies?.length || 0;
      if (policyFilter === 'with' && pc === 0) return false;
      if (policyFilter === 'without' && pc > 0) return false;
      if (gset.size && !(r.groups || []).some((g) => gset.has(g.id))) return false;
      if (!q) return true;
      return (r.name || '').toLowerCase().includes(q) ||
        (r.address || '').toLowerCase().includes(q) ||
        (r.groups || []).some((g) => (g.name || '').toLowerCase().includes(q));
    });
  }, [resources, search, statusFilter, policyFilter, groupFilter]);

  const anyFilter = statusFilter !== 'all' || policyFilter !== 'all' || groupFilter.length > 0;

  // Column sorting (default A-Z by name) - resources come back from the API in creation order.
  const { sorted: sortedResources, state: sortState } = useTableSort(filteredResources, {
    name: (r) => r.name || '',
    address: (r) => r.address || '',
    groups: (r) => r.groups?.length || 0,
    policies: (r) => r.policies?.length || 0,
  }, { key: 'name', dir: 'asc' });

  // Client-side pagination - networks can hold hundreds of resources; rendering them all at once
  // is what makes the page feel slow, so only the current page's rows are rendered.
  const totalPages = Math.max(1, Math.ceil(sortedResources.length / perPage));
  const clampedPage = Math.min(page, totalPages);
  const pageResources = useMemo(
    () => sortedResources.slice((clampedPage - 1) * perPage, clampedPage * perPage),
    [sortedResources, clampedPage, perPage],
  );
  // Back to page 1 whenever the result set changes (search / filters / page size).
  useEffect(() => { setPage(1); }, [search, statusFilter, policyFilter, groupFilter, perPage]);

  const onDelete = async (r: Resource) => {
    const ok = await confirm({ title: 'Delete resource', message: `Delete resource "${r.name}"? This also removes its access policy and group.`, confirmText: 'Delete' });
    if (ok) await del.mutateAsync(r.id);
  };

  // ── Multi-select / bulk delete ──
  const toggleSelect = (rid: string) => setSelected((p) => {
    const n = new Set(p);
    if (n.has(rid)) n.delete(rid); else n.add(rid);
    return n;
  });
  const visibleIds = pageResources.map((r) => r.id); // "select all" applies to the current page
  const allSelected = visibleIds.length > 0 && visibleIds.every((vid) => selected.has(vid));
  const someSelected = visibleIds.some((vid) => selected.has(vid));
  const toggleAll = () => setSelected((p) => {
    const n = new Set(p);
    if (allSelected) visibleIds.forEach((vid) => n.delete(vid));
    else visibleIds.forEach((vid) => n.add(vid));
    return n;
  });
  const onBulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const ok = await confirm({
      title: `Delete ${ids.length} resource${ids.length > 1 ? 's' : ''}?`,
      message: `This permanently deletes ${ids.length} resource${ids.length > 1 ? 's' : ''} and their access policies. This cannot be undone.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    await bulkDel.mutateAsync(ids);
    setSelected(new Set());
  };

  const tabs: { key: Tab; label: string; icon: typeof Layers }[] = [
    { key: 'resources', label: `${resources.length} Resources`, icon: Layers },
    { key: 'routers', label: `${routers.length} Routing Peers`, icon: Monitor },
    { key: 'policies', label: 'Policies', icon: ShieldCheck },
  ];

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm mb-5">
        <GitFork size={15} className="text-nb-gray-400" />
        <Link to="/networks" className="text-netbird hover:underline">Networks</Link>
        <ChevronRight size={14} className="text-nb-gray-400" />
        <span className="text-nb-gray-700 dark:text-nb-gray-200">{name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-4 mb-5">
        <div className="relative flex items-center justify-center h-12 w-12 rounded-md bg-nb-gray-100 dark:bg-nb-gray-800 text-nb-gray-700 dark:text-nb-gray-100 text-lg font-medium uppercase">
          {initials(name)}
          {/* Official-dashboard semantics: green = the network HAS routing peers, gray = none. */}
          <span className={cn('absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-white dark:border-nb-gray-960',
            routingPeers > 0 ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-700')} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-nb-gray-900 dark:text-nb-gray-50 truncate">{name}</h1>
            {canManage && (
              <IconButton onClick={() => setEditNet(true)} title="Edit network"><Pencil size={15} /></IconButton>
            )}
            {!canEdit && !canBulk && (
              <span title="You have view-only access to this network" className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-700 bg-nb-gray-100 dark:bg-nb-gray-900 px-2.5 py-1 text-[0.72rem] font-medium text-nb-gray-500 dark:text-nb-gray-400">
                <Eye size={12} /> Read-only
              </span>
            )}
          </div>
          {(detail?.description || net?.description) && (
            <p className="mt-0.5 text-sm text-nb-gray-500 dark:text-nb-gray-400 truncate">{detail?.description || net?.description}</p>
          )}
        </div>
      </div>

      {/* Summary card */}
      <div className="max-w-md rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-940 mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b border-nb-gray-100 dark:border-nb-gray-900/70">
          <span className="inline-flex items-center gap-2.5 text-[0.85rem] font-semibold text-nb-gray-800 dark:text-nb-gray-100">
            <Server size={16} className="text-nb-gray-400" /> High Availability
          </span>
          {/* Official-dashboard semantics: HA is active only with 2+ routing peers; a single
              router keeps the network up but is NOT highly available (yellow, like upstream). */}
          <span
            className="inline-flex items-center gap-2 text-sm text-nb-gray-700 dark:text-nb-gray-300 cursor-help"
            title={isHighlyAvailable
              ? 'High availability is active for this network. You can add more routing peers to increase the availability of this network.'
              : 'High availability is currently inactive for this network. Add more routing peers or groups with routing peers to enable high availability.'}
          >
            <span className={cn('h-2 w-2 rounded-full', isHighlyAvailable ? 'bg-green-500' : 'bg-yellow-400')} />
            {isHighlyAvailable ? 'Active' : 'Inactive'}
            <HelpCircle size={12} className="text-nb-gray-400" />
          </span>
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <span className="inline-flex items-center gap-2.5 text-[0.85rem] font-semibold text-nb-gray-800 dark:text-nb-gray-100">
            <ShieldCheck size={16} className="text-green-500" /> {policies.length} Active Polic{policies.length === 1 ? 'y' : 'ies'}
          </span>
          <button onClick={() => setTab('policies')} className="inline-flex items-center gap-1 text-[0.82rem] text-netbird hover:underline">
            Go to Policies <ExternalLink size={13} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-end gap-1 border-b border-nb-gray-200 dark:border-nb-gray-900 mb-5">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={cn('relative inline-flex items-center gap-2 px-3 pt-1.5 pb-3 text-sm transition-colors',
                active ? 'text-netbird' : 'text-nb-gray-600 hover:text-nb-gray-900 dark:text-nb-gray-400 dark:hover:text-nb-gray-200')}>
              <t.icon size={15} /> {t.label}
              <span className={cn('absolute left-0 right-0 bottom-0 h-[1.5px]', active ? 'bg-netbird' : 'bg-transparent')} />
            </button>
          );
        })}
      </div>

      {isLoading ? <LoadingState label="Loading network…" /> : (
        <>
          {tab === 'resources' && (
            <div>
              <p className="text-[0.95rem] text-nb-gray-500 dark:text-nb-gray-400 mb-5">
                Add resources to this network to control what peers can access.
              </p>

              {canManage && conflicts.map((c, i) => {
                const rowsOf = () => c.resources.map((r) => ({
                  id: r.id, name: r.name, address: c.address,
                  networkId: r.networkId || c.networkId, networkName: r.networkName || c.networkName,
                }));
                return (
                <div key={i} className="mb-5 rounded-md border border-red-500/40 bg-red-500/5 overflow-hidden">
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-red-500/20 bg-red-500/10">
                    <AlertTriangle size={16} className="shrink-0 text-red-500" />
                    <span className="text-sm font-semibold text-red-600 dark:text-red-400">
                      {(() => {
                        const names = c.resources.map((r) => `"${r.name}"`);
                        const shown = names.slice(0, 3).join(' + ') + (names.length > 3 ? ` +${names.length - 3} more` : '');
                        return c.crossNetwork
                          ? <>Cross-Network Address Conflict: {shown} all point at <span className="font-mono">{c.address}</span></>
                          : <>Address Conflict: {shown} all point at <span className="font-mono">{c.address}</span></>;
                      })()}
                    </span>
                    <Button variant="primary" size="sm" className="ml-auto"
                      title={c.crossNetwork ? 'Merges across the networks - after it, all traffic to this address routes via the surviving network' : undefined}
                      onClick={() => setMergeRows(rowsOf())}>
                      <Combine size={13} /> Merge Into One
                    </Button>
                  </div>
                  <div className="px-4 py-3 flex flex-col gap-3 text-[0.84rem]">
                    <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                      <span className="w-28 shrink-0 pt-0.5 text-[0.72rem] font-medium uppercase tracking-wide text-nb-gray-500">Fighting Over It</span>
                      <span className="flex flex-wrap gap-1.5 min-w-0 flex-1">
                        {c.resources.map((r) => (
                          <Link key={r.id} to={`/networks/${encodeURIComponent(r.networkId || c.networkId)}?resource=${encodeURIComponent(r.id)}`}
                            title="Open this resource to edit or delete it"
                            className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-900 px-2 py-0.5 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-200 hover:border-netbird/50 hover:text-netbird transition-colors">
                            <Share2 size={11} className="text-nb-gray-400" /> {r.name}
                            {c.crossNetwork && r.networkName && <span className="text-nb-gray-400">· {r.networkName}</span>}
                          </Link>
                        ))}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                      <span className="w-28 shrink-0 pt-0.5 text-[0.72rem] font-medium uppercase tracking-wide text-nb-gray-500">Affected Users</span>
                      <span className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                        {c.overlapCount === -1 ? (
                          <span className="text-red-600 dark:text-red-400 font-medium">Everyone on the network</span>
                        ) : (
                          <>
                            {c.overlapUsers.map((u) => (
                              <span key={u} dir="auto" className="inline-flex items-center rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[0.78rem] text-red-600 dark:text-red-300">{u}</span>
                            ))}
                            {c.overlapCount > c.overlapUsers.length && (
                              <span className="text-[0.78rem] text-red-500">+{c.overlapCount - c.overlapUsers.length} more</span>
                            )}
                          </>
                        )}
                        {c.sharedGroups.length > 0 && (
                          <span dir="auto" className="text-[0.78rem] text-nb-gray-500">via shared group{c.sharedGroups.length === 1 ? '' : 's'}: {c.sharedGroups.join(', ')}</span>
                        )}
                        {c.note && <span className="text-[0.78rem] text-nb-gray-500">({c.note})</span>}
                      </span>
                    </div>
                    <p className="text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-400 border-t border-red-500/15 pt-2.5">
                      {c.crossNetwork
                        ? <>These users can reach <span className="font-mono">{c.address}</span> through resources in more than one network. Their device picks ONE network's route - only that network's rules apply, and the winner can change. Merging keeps one resource with ALL the access rules; note that afterwards all traffic to this address routes through the surviving resource's network. Click a resource above to open it directly.</>
                        : <>These users can reach <span className="font-mono">{c.address}</span> through more than one of the resources above, so NetBird picks one at random for them - their access may randomly fail. Merging keeps one resource with all the access rules, which fixes it without changing who has access.</>}
                    </p>
                  </div>
                </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-4 mb-4">
                <SearchInput value={search} onChange={setSearch} placeholder="Search by name, address or group…" />
                <ResourceFilters
                  status={statusFilter} setStatus={setStatusFilter}
                  policy={policyFilter} setPolicy={setPolicyFilter}
                  groups={availableGroups} groupSel={groupFilter} setGroupSel={setGroupFilter}
                />
                <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))}
                  options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
                <ClearFiltersButton
                  active={!!search || anyFilter}
                  onClear={() => { setSearch(''); setStatusFilter('all'); setPolicyFilter('all'); setGroupFilter([]); }}
                />
                {canEdit && (
                  <Button variant="primary" className="ml-auto" onClick={() => setModal({ resource: null, tab: 'resource' })}>
                    <Plus size={15} /> Add
                  </Button>
                )}
              </div>

              {anyFilter && (
                <div className="flex flex-wrap items-center gap-2 mb-5">
                  {statusFilter !== 'all' && <FilterChip onClear={() => setStatusFilter('all')}>Status: {statusFilter === 'active' ? 'Active' : 'Inactive'}</FilterChip>}
                  {policyFilter !== 'all' && <FilterChip onClear={() => setPolicyFilter('all')}>{policyFilter === 'with' ? 'With policies' : 'Without policies'}</FilterChip>}
                  {groupFilter.map((gid) => <FilterChip key={gid} onClear={() => setGroupFilter((p) => p.filter((x) => x !== gid))}>Group: {groupName(gid)}</FilterChip>)}
                  <button onClick={() => { setStatusFilter('all'); setPolicyFilter('all'); setGroupFilter([]); }} className="ml-1 text-[0.8rem] text-netbird hover:underline">Reset</button>
                </div>
              )}

              {canBulk && selected.size > 0 && (
                <div className="flex items-center gap-3 mb-4 px-3.5 py-2.5 rounded-md border border-netbird/30 bg-netbird/5">
                  <span className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">{selected.size} selected</span>
                  <Button variant="danger" size="sm" onClick={onBulkDelete} disabled={bulkDel.isPending}>
                    <Trash2 size={14} /> {bulkDel.isPending ? 'Deleting…' : `Delete ${selected.size}`}
                  </Button>
                  {isAdmin && (
                    <Button variant="secondary" size="sm" onClick={() => setBlockOpen(true)} title="Add the selected addresses to the blocklist">
                      <Ban size={14} /> Add To Blocklist
                    </Button>
                  )}
                  {selected.size >= 2 && (
                    <Button variant="secondary" size="sm" onClick={() => setMergeOpen(true)}
                      title="Merge duplicates sharing one address into a single resource (policies move with them)">
                      <Combine size={14} /> Merge Into One
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => setMoveOpen(true)}
                    title="Move the selected resources to another network - access policies follow them">
                    <ArrowRight size={14} /> Move To Network
                  </Button>
                  <button onClick={() => setSelected(new Set())} className="ml-auto text-sm text-nb-gray-500 hover:text-nb-gray-800 dark:hover:text-nb-gray-200">Clear</button>
                </div>
              )}

              <div className="hidden md:block w-full overflow-x-auto">
                <table className="w-full border-collapse border-y border-nb-gray-200 dark:border-nb-gray-900 min-w-[760px]">
                  <thead>
                    <tr className="border-b border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-100/60 dark:bg-nb-gray-930/40 text-left">
                      {canBulk && (
                        <th className="h-12 pl-6 pr-1 w-px">
                          <input
                            type="checkbox"
                            aria-label="Select all"
                            className="h-4 w-4 align-middle accent-netbird cursor-pointer"
                            checked={allSelected}
                            ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                            onChange={toggleAll}
                          />
                        </th>
                      )}
                      <SortTh label="Resource" sortKey="name" state={sortState} className={canBulk ? 'pl-2 pr-6' : 'px-6'} />
                      <SortTh label="Address" sortKey="address" state={sortState} className="px-6" />
                      <SortTh label="Groups" sortKey="groups" state={sortState} className="px-6" />
                      <SortTh label="Policies" sortKey="policies" state={sortState} className="px-6" />
                      <th className="h-12 px-6" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedResources.length === 0 ? (
                      <tr><td colSpan={canBulk ? 6 : 5} className="px-6 py-8"><EmptyState title={search || anyFilter ? 'No Resources Match' : 'No Resources Yet'} /></td></tr>
                    ) : pageResources.map((r) => (
                      <ResourceRow key={r.id} r={r} canEdit={canEdit} canSelect={canBulk}
                        selected={selected.has(r.id)} onToggle={toggleSelect}
                        onEdit={(t) => setModal({ resource: r, tab: t })}
                        onDuplicate={() => setModal({ resource: r, tab: 'resource', duplicate: true })}
                        onToggleEnabled={() => onToggleEnabled(r)}
                        onDelete={() => onDelete(r)} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: cards instead of the wide table */}
              <div className="md:hidden">
                {filteredResources.length === 0 ? (
                  <EmptyState title={search || anyFilter ? 'No Resources Match' : 'No Resources Yet'} />
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {pageResources.map((r) => (
                      <ResourceCard key={r.id} r={r} canEdit={canEdit} canSelect={canBulk}
                        selected={selected.has(r.id)} onToggle={toggleSelect}
                        onEdit={(t) => setModal({ resource: r, tab: t })}
                        onDuplicate={() => setModal({ resource: r, tab: 'resource', duplicate: true })}
                        onToggleEnabled={() => onToggleEnabled(r)}
                        onDelete={() => onDelete(r)} />
                    ))}
                  </div>
                )}
              </div>

              {/* Pagination - the page-size selector lives up in the filters toolbar. */}
              {filteredResources.length > perPage && (
                <Pagination page={clampedPage} totalPages={totalPages} onPage={setPage} total={filteredResources.length} label="resources" />
              )}
            </div>
          )}

          {tab === 'routers' && <RoutersTable routers={routers} networkId={id} canEdit={canEdit} name={name} />}
          {tab === 'policies' && <PoliciesPanel policies={policies} />}
        </>
      )}

      {modal && (
        <ResourceModal
          networkId={id}
          resource={modal.resource}
          duplicate={modal.duplicate}
          initialTab={modal.tab}
          existingNames={resources.filter((r) => modal.duplicate || r.id !== modal.resource?.id).map((r) => r.name || '')}
          existingResources={resources.filter((r) => modal.duplicate || r.id !== modal.resource?.id).map((r) => ({ name: r.name || '', address: r.address || '' }))}
          allowDuplicates={detail?.allowDuplicates}
          onClose={() => setModal(null)}
        />
      )}
      {blockOpen && (
        <AddFromNetworkModal
          entries={blocklistEntries}
          initialNetworkId={id}
          initialAddresses={resources.filter((r) => selected.has(r.id)).map((r) => (r.address || '').trim()).filter(Boolean)}
          onClose={() => setBlockOpen(false)}
        />
      )}
      {editNet && (
        <NetworkModal
          network={{ id, name: detail?.name || net?.name, description: detail?.description || net?.description, allowDuplicates: detail?.allowDuplicates }}
          onClose={() => setEditNet(false)}
        />
      )}
      {mergeOpen && (
        <MergeResourcesModal
          networkId={id}
          resources={resources.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, name: r.name || r.id, address: r.address || '' }))}
          onDone={() => setSelected(new Set())}
          onClose={() => setMergeOpen(false)}
        />
      )}
      {moveOpen && (
        <MoveResourcesModal
          networkId={id}
          resources={resources.filter((r) => selected.has(r.id))}
          onDone={() => setSelected(new Set())}
          onClose={() => setMoveOpen(false)}
        />
      )}
      {mergeRows && (
        <MergeResourcesModal
          networkId={id}
          resources={mergeRows}
          onDone={() => setSelected(new Set())}
          onClose={() => setMergeRows(null)}
        />
      )}
    </div>
  );
}

// ── Move resources to another network - recreated there, policies re-pointed, originals deleted ──
function MoveResourcesModal({ networkId, resources, onDone, onClose }: {
  networkId: string;
  resources: Resource[];
  onDone: () => void;
  onClose: () => void;
}) {
  const move = useMoveResources(networkId);
  const confirm = useConfirm();
  const networks = (useNetworks().data || []).filter((n) => n.id !== networkId);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (!target) { setError('Pick the network to move the resources to.'); return; }
    try {
      const out = await move.mutateAsync({ ids: resources.map((r) => r.id), targetNetworkId: target });
      onDone();
      onClose();
      await confirm({
        title: out.failed.length ? 'Move Finished With Issues' : 'Resources Moved',
        message: [
          out.moved.length ? `Moved to ${out.targetNetworkName}: ${out.moved.join(', ')}.` : '',
          out.failed.length ? `Not moved: ${out.failed.map((f) => `${f.name} - ${f.error}`).join(' · ')}` : '',
        ].filter(Boolean).join('\n'),
        confirmText: 'OK',
      });
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} size="md" icon={<ArrowRight size={18} />}
      title="Move To Another Network"
      subtitle="Each resource is recreated in the target network with its groups and settings, every access policy follows it, and the original is removed. Nothing changes about who has access."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!target || move.isPending}>
            <ArrowRight size={15} /> {move.isPending ? 'Moving…' : `Move ${resources.length} Resource${resources.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Moving</Label>
          <div className="flex flex-wrap gap-1.5">
            {resources.map((r) => (
              <span key={r.id} className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900 px-2 py-0.5 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-200">
                <Share2 size={11} className="text-nb-gray-400" /> {r.name || r.id}
                <span className="text-nb-gray-400">· {r.address}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Target Network</Label>
          <FieldHint>The resources will be routed by this network's routing peers from now on - make sure they can reach the addresses.</FieldHint>
          <SelectMenu value={target} onChange={setTarget} placeholder="Select a network…"
            options={networks.map((n) => ({ value: n.id, label: n.name || n.id }))} />
        </div>
        <FieldHint>Resources attached to an active temporary grant are skipped (end or revoke the grant first). A resource whose address already exists in the target network is skipped too.</FieldHint>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

// ── Merge duplicate resources (same address) into one - policies move to the survivor.
//    Works across networks too; the modal then warns that routing follows the survivor. ──
export interface MergeRow { id: string; name: string; address: string; networkId?: string; networkName?: string }
function MergeResourcesModal({ networkId, resources, onDone, onClose }: {
  networkId: string;
  resources: MergeRow[];
  onDone: () => void;
  onClose: () => void;
}) {
  const merge = useMergeResources(networkId);
  const confirm = useConfirm();
  const [keepId, setKeepId] = useState(resources[0]?.id || '');
  const [error, setError] = useState('');
  const addr = (r: MergeRow) => (r.address || '').trim().toLowerCase();
  const sameAddress = resources.length >= 2 && resources.every((r) => addr(r) === addr(resources[0]));
  const crossNetwork = new Set(resources.map((r) => r.networkId || networkId)).size > 1;
  const keptRow = resources.find((r) => r.id === keepId);

  const submit = async () => {
    setError('');
    try {
      const out = await merge.mutateAsync({ ids: resources.map((r) => r.id), keepId });
      onDone();
      onClose();
      await confirm({
        title: 'Resources Merged',
        message: `Kept "${out.keptName}". ${out.movedPolicies} polic${out.movedPolicies === 1 ? 'y' : 'ies'} moved to it; deleted: ${out.deleted.join(', ')}.`,
        confirmText: 'OK',
      });
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} size="md" icon={<Combine size={18} />}
      title="Merge Into One Resource"
      subtitle="Several resources sharing one address make NetBird apply their policies unpredictably - merging keeps one resource with ALL the policies."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!sameAddress || !keepId || merge.isPending}>
            <Combine size={15} /> {merge.isPending ? 'Merging…' : `Merge ${resources.length} Resources`}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        {!sameAddress && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[0.82rem] text-red-500">
            The selected resources do not share the same address - only exact duplicates can be merged.
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label>Keep This Resource</Label>
          <FieldHint>Every access policy of the others is re-pointed at it, group memberships are combined, and the rest are deleted.</FieldHint>
          <div className="mt-1 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 divide-y divide-nb-gray-100 dark:divide-nb-gray-900">
            {resources.map((r) => (
              <label key={r.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40">
                <input type="radio" name="keep" className="accent-netbird" checked={keepId === r.id} onChange={() => setKeepId(r.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-nb-gray-800 dark:text-nb-gray-100">{r.name || r.id}</span>
                  <span className="block truncate text-[0.76rem] text-nb-gray-500">{r.address}{r.networkName ? ` · ${r.networkName}` : ''}</span>
                </span>
                {keepId === r.id
                  ? <span className="text-[0.68rem] uppercase tracking-wide text-green-500 shrink-0">Kept</span>
                  : <span className="text-[0.68rem] uppercase tracking-wide text-red-400 shrink-0">Deleted</span>}
              </label>
            ))}
          </div>
        </div>
        {crossNetwork && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-300">
            <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
            <span>
              These resources live in <b>different networks</b>. After the merge, ALL traffic to this address flows through
              the routing peers of {keptRow?.networkName ? <b>{keptRow.networkName}</b> : "the surviving resource's network"} -
              make sure they can reach the address and handle the load.
            </span>
          </div>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

// Resources toolbar filter - a Filters button with Status / Groups / Policies submenus.
function ResourceFilters({ status, setStatus, policy, setPolicy, groups, groupSel, setGroupSel }: {
  status: StatusF; setStatus: (v: StatusF) => void;
  policy: PolicyF; setPolicy: (v: PolicyF) => void;
  groups: { id: string; name: string }[];
  groupSel: string[]; setGroupSel: (updater: (prev: string[]) => string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<'status' | 'groups' | 'policies' | null>(null);
  const activeCount = (status !== 'all' ? 1 : 0) + (policy !== 'all' ? 1 : 0) + (groupSel.length ? 1 : 0);
  const close = () => { setOpen(false); setSub(null); };

  const statusOpts: { v: StatusF; label: string; dot: string }[] = [
    { v: 'all', label: 'All', dot: 'bg-nb-gray-400' },
    { v: 'active', label: 'Active', dot: 'bg-green-500' },
    { v: 'inactive', label: 'Inactive', dot: 'bg-nb-gray-500 dark:bg-nb-gray-600' },
  ];
  const policyOpts: { v: PolicyF; label: string }[] = [
    { v: 'all', label: 'All resources' },
    { v: 'with', label: 'With policies' },
    { v: 'without', label: 'Without policies' },
  ];

  return (
    <div className="relative">
      <Button variant="secondary" onClick={() => (open ? close() : setOpen(true))}>
        <Filter size={16} /> Filters
        {activeCount > 0 && <span className="ml-0.5 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-netbird text-white text-[0.65rem] font-semibold">{activeCount}</span>}
        <ChevronsUpDown size={14} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute left-0 top-full mt-1.5 z-50 w-52 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
            <FilterCat label="Status" valueLabel={status === 'all' ? '' : statusOpts.find((o) => o.v === status)?.label} onEnter={() => setSub('status')} active={sub === 'status'}>
              {sub === 'status' && (
                <Flyout>
                  {statusOpts.map((o) => (
                    <OptRow key={o.v} selected={status === o.v} onClick={() => setStatus(o.v)}>
                      <span className={cn('h-2 w-2 rounded-full', o.dot)} /> {o.label}
                    </OptRow>
                  ))}
                </Flyout>
              )}
            </FilterCat>
            <FilterCat label="Groups" valueLabel={groupSel.length ? String(groupSel.length) : ''} onEnter={() => setSub('groups')} active={sub === 'groups'}>
              {sub === 'groups' && (
                <Flyout wide>
                  {groups.length ? groups.map((g) => {
                    const on = groupSel.includes(g.id);
                    return (
                      <OptRow key={g.id} selected={on} onClick={() => setGroupSel((p) => on ? p.filter((x) => x !== g.id) : [...p, g.id])}>
                        <span className={cn('flex items-center justify-center h-3.5 w-3.5 rounded-[3px] border shrink-0', on ? 'bg-netbird border-netbird text-white' : 'border-nb-gray-300 dark:border-nb-gray-600')}>{on && <Check size={11} />}</span>
                        <span className="truncate">{g.name}</span>
                      </OptRow>
                    );
                  }) : <div className="px-2.5 py-1.5 text-[0.78rem] text-nb-gray-500">No groups</div>}
                </Flyout>
              )}
            </FilterCat>
            <FilterCat label="Policies" valueLabel={policy === 'all' ? '' : policyOpts.find((o) => o.v === policy)?.label} onEnter={() => setSub('policies')} active={sub === 'policies'}>
              {sub === 'policies' && (
                <Flyout wide>
                  {policyOpts.map((o) => <OptRow key={o.v} selected={policy === o.v} onClick={() => setPolicy(o.v)}>{o.label}</OptRow>)}
                </Flyout>
              )}
            </FilterCat>
          </div>
        </>
      )}
    </div>
  );
}

function FilterCat({ label, valueLabel, onEnter, active, children }: {
  label: string; valueLabel?: string; onEnter: () => void; active: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="relative" onMouseEnter={onEnter}>
      <button className={cn('flex items-center justify-between w-full px-2.5 py-1.5 rounded text-sm transition-colors',
        active ? 'bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-900 dark:text-nb-gray-100' : 'text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900')}>
        <span>{label}</span>
        <span className="flex items-center gap-1.5">
          {valueLabel && <span className="text-[0.7rem] text-netbird font-medium max-w-[80px] truncate">{valueLabel}</span>}
          <ChevronRight size={14} className="text-nb-gray-400" />
        </span>
      </button>
      {children}
    </div>
  );
}

function Flyout({ wide, children }: { wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('absolute left-full top-0 ml-1 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5 max-h-64 overflow-auto', wide ? 'w-52' : 'w-40')}>
      {children}
    </div>
  );
}

function OptRow({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn('flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded text-sm',
      selected ? 'bg-netbird/10 text-netbird' : 'text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900')}>
      {children}
    </button>
  );
}

function FilterChip({ onClear, children }: { onClear: () => void; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-md text-[0.78rem] border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100/60 dark:bg-nb-gray-920/60 text-nb-gray-600 dark:text-nb-gray-300">
      {children}
      <button onClick={onClear} className="inline-flex items-center justify-center h-4 w-4 rounded hover:bg-nb-gray-200 dark:hover:bg-nb-gray-800 text-nb-gray-400 hover:text-nb-gray-700 dark:hover:text-nb-gray-100"><X size={12} /></button>
    </span>
  );
}

function ResourceRow({ r, canEdit, canSelect, selected, onToggle, onEdit, onDuplicate, onToggleEnabled, onDelete }: {
  r: Resource; canEdit: boolean; canSelect?: boolean; selected?: boolean; onToggle?: (id: string) => void;
  onEdit: (tab: 'resource' | 'access') => void; onDuplicate: () => void; onToggleEnabled: () => void; onDelete: () => void;
}) {
  const pc = r.policies?.length || 0;
  return (
    <tr
      className={cn('border-b border-nb-gray-100 dark:border-nb-gray-900 last:border-0 hover:bg-nb-gray-100/50 dark:hover:bg-nb-gray-910/[0.15]', canEdit && 'cursor-pointer', r.enabled === false && 'opacity-50', selected && '!bg-netbird/[0.06]')}
      onClick={canEdit ? () => onEdit('resource') : undefined}
    >
      {canSelect && (
        <td className="pl-6 pr-1 py-3 w-px align-middle" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Select ${r.name}`}
            className="h-4 w-4 align-middle accent-netbird cursor-pointer"
            checked={!!selected}
            onChange={() => onToggle?.(r.id)}
          />
        </td>
      )}
      <td className={cn('py-3', canSelect ? 'pl-2 pr-6' : 'px-6')}>
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center h-9 w-9 rounded-md shrink-0 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500 dark:text-nb-gray-400"><Share2 size={15} /></div>
          <span className={cn('h-2 w-2 rounded-full shrink-0', r.enabled === false ? 'bg-nb-gray-400 dark:bg-nb-gray-600' : 'bg-green-500')} title={r.enabled === false ? 'Inactive' : 'Active'} />
          <span className="text-sm text-nb-gray-700 dark:text-nb-gray-300">{r.name}</span>
          {r.enabled === false && <Badge tone="gray">Inactive</Badge>}
        </div>
      </td>
      <td className="px-6 py-3">
        <Copyable value={r.address || ''}>
          <span className="font-mono text-[.82rem] text-nb-gray-600 dark:text-nb-gray-300 whitespace-nowrap">{r.address}</span>
        </Copyable>
      </td>
      <td className="px-6 py-3" onClick={(e) => e.stopPropagation()}>
        {r.groups?.length ? (
          <div className="flex flex-wrap gap-1.5">{r.groups.map((g) => <Badge key={g.id} icon={<Grid3x3 size={11} />}>{g.name}</Badge>)}</div>
        ) : canEdit ? (
          <button onClick={() => onEdit('resource')} className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-md text-[0.75rem] border border-nb-gray-200 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800">
            <Plus size={12} /> Add
          </button>
        ) : <span className="text-nb-gray-500 text-sm">-</span>}
      </td>
      <td className="px-6 py-3" onClick={(e) => e.stopPropagation()}>
        <div className="inline-flex items-stretch">
          <span className={cn('inline-flex items-center gap-1.5 h-[34px] min-w-[50px] justify-center px-2.5 text-[0.75rem] border rounded-l-md border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100/60 dark:bg-nb-gray-930/60', canEdit && 'cursor-pointer')}
            onClick={canEdit ? () => onEdit('access') : undefined}>
            <ShieldCheck size={13} className={pc > 0 ? 'text-green-500' : 'text-red-500'} /> {pc}
          </span>
          {canEdit && (
            <button onClick={() => onEdit('access')} title="Configure policies"
              className="inline-flex items-center justify-center h-[34px] w-8 rounded-r-md border border-l-0 border-nb-gray-200 dark:border-nb-gray-800 text-nb-gray-500 hover:text-nb-gray-900 dark:hover:text-nb-gray-100 bg-nb-gray-100/60 dark:bg-nb-gray-930/60">
              <Gear size={13} />
            </button>
          )}
        </div>
      </td>
      <td className="px-6 py-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
        {canEdit && (
          <div className="inline-flex items-center gap-1.5">
            <IconButton onClick={() => onEdit('resource')} title="Edit"><Pencil size={15} /></IconButton>
            <IconButton onClick={onDuplicate} title="Duplicate"><CopyIcon size={15} /></IconButton>
            <IconButton onClick={onToggleEnabled} title={r.enabled === false ? 'Enable' : 'Disable'}
              className={r.enabled === false ? 'hover:text-green-500 hover:border-green-500/30 hover:bg-green-500/10' : 'hover:text-amber-500 hover:border-amber-500/30 hover:bg-amber-500/10'}>
              <Power size={15} />
            </IconButton>
            <IconButton onClick={onDelete} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
          </div>
        )}
      </td>
    </tr>
  );
}

// Mobile (md:hidden) card equivalent of ResourceRow.
function ResourceCard({ r, canEdit, canSelect, selected, onToggle, onEdit, onDuplicate, onToggleEnabled, onDelete }: {
  r: Resource; canEdit: boolean; canSelect?: boolean; selected?: boolean; onToggle?: (id: string) => void;
  onEdit: (tab: 'resource' | 'access') => void; onDuplicate: () => void; onToggleEnabled: () => void; onDelete: () => void;
}) {
  const pc = r.policies?.length || 0;
  return (
    <div
      className={cn('rounded-lg border bg-white dark:bg-nb-gray-950 p-3.5',
        canEdit && 'cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors',
        r.enabled === false && 'opacity-60',
        selected ? 'border-netbird/40 !bg-netbird/[0.06]' : 'border-nb-gray-200 dark:border-nb-gray-800')}
      onClick={canEdit ? () => onEdit('resource') : undefined}
    >
      <div className="flex items-center gap-2.5">
        {canSelect && (
          <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" aria-label={`Select ${r.name}`} className="h-4 w-4 align-middle accent-netbird cursor-pointer" checked={!!selected} onChange={() => onToggle?.(r.id)} />
          </span>
        )}
        <div className="flex items-center justify-center h-9 w-9 rounded-md shrink-0 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500 dark:text-nb-gray-400"><Share2 size={15} /></div>
        <span className={cn('h-2 w-2 rounded-full shrink-0', r.enabled === false ? 'bg-nb-gray-400 dark:bg-nb-gray-600' : 'bg-green-500')} />
        <span className="flex-1 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{r.name}</span>
        {r.enabled === false && <Badge tone="gray" className="shrink-0">Inactive</Badge>}
        {canEdit && (
          <div className="shrink-0 -mr-1 inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <IconButton onClick={() => onEdit('resource')} title="Edit"><Pencil size={15} /></IconButton>
            <IconButton onClick={onDuplicate} title="Duplicate"><CopyIcon size={15} /></IconButton>
            <IconButton onClick={onToggleEnabled} title={r.enabled === false ? 'Enable' : 'Disable'}
              className={r.enabled === false ? 'hover:text-green-500 hover:border-green-500/30 hover:bg-green-500/10' : 'hover:text-amber-500 hover:border-amber-500/30 hover:bg-amber-500/10'}>
              <Power size={15} />
            </IconButton>
            <IconButton onClick={onDelete} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
          </div>
        )}
      </div>

      <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
        <Copyable value={r.address || ''}>
          <span className="font-mono text-[.82rem] text-nb-gray-600 dark:text-nb-gray-300 break-all">{r.address}</span>
        </Copyable>
      </div>

      {(r.groups?.length || canEdit) ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {r.groups?.length ? (
            r.groups.map((g) => <Badge key={g.id} icon={<Grid3x3 size={11} />}>{g.name}</Badge>)
          ) : (
            <button onClick={() => onEdit('resource')} className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-md text-[0.75rem] border border-nb-gray-200 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800">
              <Plus size={12} /> Add group
            </button>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3" onClick={(e) => e.stopPropagation()}>
        <span className="text-[0.6rem] font-medium uppercase tracking-wide text-nb-gray-400 dark:text-nb-gray-500">Policies</span>
        <div className="inline-flex items-stretch">
          <span className={cn('inline-flex items-center gap-1.5 h-[34px] min-w-[50px] justify-center px-2.5 text-[0.75rem] border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100/60 dark:bg-nb-gray-930/60', canEdit ? 'cursor-pointer rounded-l-md' : 'rounded-md')}
            onClick={canEdit ? () => onEdit('access') : undefined}>
            <ShieldCheck size={13} className={pc > 0 ? 'text-green-500' : 'text-red-500'} /> {pc}
          </span>
          {canEdit && (
            <button onClick={() => onEdit('access')} title="Configure policies"
              className="inline-flex items-center justify-center h-[34px] w-8 rounded-r-md border border-l-0 border-nb-gray-200 dark:border-nb-gray-800 text-nb-gray-500 hover:text-nb-gray-900 dark:hover:text-nb-gray-100 bg-nb-gray-100/60 dark:bg-nb-gray-930/60">
              <Gear size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// The router target as CLICKABLE names: a single peer links to its peer page, group routers
// link to each group's page. Falls back to plain text when the viewer can't open the target
// (group pages are admin-only) or when no id came back (deleted objects).
function RouterTargetLinks({ r }: { r: Router }) {
  const { isAdmin, can } = useViewer();
  const canOpenPeer = isAdmin || can('networks.manage') || can('peers.all');
  const cls = 'text-sm text-nb-gray-700 dark:text-nb-gray-200';
  const linkCls = cn(cls, 'hover:text-netbird hover:underline');
  if (r.peer) {
    return r.peerId && canOpenPeer
      ? <Link to={`/peers/${encodeURIComponent(r.peerId)}`} className={linkCls}>{r.peer}</Link>
      : <span className={cls}>{r.peer}</span>;
  }
  const refs = r.peerGroupRefs?.length ? r.peerGroupRefs : (r.peerGroups || []).map((n) => ({ id: '', name: n }));
  if (!refs.length) return <span className={cls}>-</span>;
  return (
    <span className={cls}>
      {refs.map((g, i) => (
        <Fragment key={g.id || g.name}>
          {i > 0 && ', '}
          {g.id && isAdmin
            ? <Link to={`/groups/${encodeURIComponent(g.id)}`} className={linkCls}>{g.name}</Link>
            : g.name}
        </Fragment>
      ))}
    </span>
  );
}

function RoutersTable({ routers, networkId, canEdit, name }: { routers: Router[]; networkId: string; canEdit: boolean; name: string }) {
  const confirm = useConfirm();
  const delRouter = useDeleteRouter(networkId);
  const [adding, setAdding] = useState(false);
  // Standard table chrome, same as every other list in the app.
  const targetOf = (r: Router) => r.peer || (r.peerGroups || []).join(', ') || '-';
  const { sorted, state } = useTableSort(routers, {
    peer: (r) => targetOf(r),
    metric: (r) => (typeof r.metric === 'number' ? r.metric : Number.MAX_SAFE_INTEGER),
    masquerade: (r) => (r.masquerade ? 0 : 1),
    status: (r) => (r.enabled === false ? 1 : 0),
  });
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((Math.min(page, totalPages) - 1) * perPage, Math.min(page, totalPages) * perPage);

  const onDelete = async (r: Router) => {
    if (!r.id) return;
    const ok = await confirm({ title: 'Remove routing peer', message: 'Remove this routing peer from the network? Traffic will no longer route through it.', confirmText: 'Remove' });
    if (ok) await delRouter.mutateAsync(r.id);
  };

  return (
    <div>
      <div className="flex items-center justify-end gap-3 mb-4">
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)}
          onChange={(v) => { setPerPage(Number(v)); setPage(1); }} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        {canEdit && <Button variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> Add Routing Peer</Button>}
      </div>
      {!routers.length ? (
        <EmptyState title="No Routing Peers" hint={canEdit ? 'Add a peer or peer group so this network can route traffic.' : undefined} />
      ) : (
        <><div className="hidden md:block w-full overflow-x-auto">
          <table className="w-full border-collapse border-y border-nb-gray-200 dark:border-nb-gray-900 min-w-[500px]">
            <thead>
              <tr className="border-b border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-100/60 dark:bg-nb-gray-930/40 text-left">
                <SortTh label="Routing Peer" sortKey="peer" state={state} className="px-6" />
                <SortTh label="Metric" sortKey="metric" state={state} className="px-6" />
                <SortTh label="Masquerade" sortKey="masquerade" state={state} className="px-6" />
                <th className="h-12 px-6" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r, i) => {
                return (
                  <tr key={r.id || i} className="border-b border-nb-gray-100 dark:border-nb-gray-900 last:border-0">
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className={cn('h-2 w-2 rounded-full', r.enabled === false ? 'bg-nb-gray-400 dark:bg-nb-gray-600' : 'bg-green-500')} />
                        <RouterTargetLinks r={r} />
                      </div>
                    </td>
                    <td className="px-6 py-3"><span className="font-mono text-[.82rem] text-nb-gray-600 dark:text-nb-gray-300">{typeof r.metric === 'number' ? r.metric : '-'}</span></td>
                    <td className="px-6 py-3">{r.masquerade ? <Badge tone="green">On</Badge> : <Badge tone="gray">Off</Badge>}</td>
                    <td className="px-6 py-3 text-right">
                      {canEdit && r.id && (
                        <IconButton onClick={() => onDelete(r)} title="Remove" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination page={Math.min(page, totalPages)} totalPages={totalPages} onPage={setPage} total={sorted.length} label="routing peers" />
        </div>

        {/* Mobile: cards instead of the wide table */}
        <div className="md:hidden flex flex-col gap-2.5">
          {pageRows.map((r, i) => {
            return (
              <div key={r.id || i} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                <div className="flex items-center gap-2.5">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', r.enabled === false ? 'bg-nb-gray-400 dark:bg-nb-gray-600' : 'bg-green-500')} />
                  <span className="flex-1 min-w-0 break-all"><RouterTargetLinks r={r} /></span>
                  {canEdit && r.id && (
                    <IconButton onClick={() => onDelete(r)} title="Remove" className="shrink-0 -mr-1 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                  )}
                </div>
                <div className="mt-2.5 flex items-center gap-x-2 gap-y-1 flex-wrap text-[0.8rem]">
                  <span className="text-nb-gray-400">Metric:</span>
                  <span className="font-mono text-nb-gray-600 dark:text-nb-gray-300">{typeof r.metric === 'number' ? r.metric : '-'}</span>
                  <span className="ml-2 text-nb-gray-400">Masquerade:</span>
                  {r.masquerade ? <Badge tone="green">On</Badge> : <Badge tone="gray">Off</Badge>}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {adding && <AddRoutingPeerModal networkId={networkId} name={name} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddRoutingPeerModal({ networkId, name, onClose }: { networkId: string; name: string; onClose: () => void }) {
  const { isAdmin, can } = useViewer();
  const canManage = isAdmin || can('networks.manage');
  const create = useCreateRouter(networkId);
  const peers = usePeers().data || [];
  const groups = useGroups(canManage).data || [];
  const [tab, setTab] = useState<'peers' | 'advanced'>('peers');
  const [mode, setMode] = useState<'peer' | 'group'>('peer');
  const [selPeers, setSelPeers] = useState<string[]>([]);
  const [selGroups, setSelGroups] = useState<string[]>([]);
  const [metric, setMetric] = useState(9999);
  const [masquerade, setMasquerade] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');

  const peerOptions = useMemo(() => peers.map((p) => ({ id: p.id, name: p.name || p.dns_label || p.ip || p.id })), [peers]);
  const groupOptions = useMemo(() => groups.map((g) => ({ id: g.id, name: g.name })), [groups]);
  const hasSelection = mode === 'peer' ? selPeers.length > 0 : selGroups.length > 0;

  const submit = async () => {
    setError('');
    if (!hasSelection) { setError(mode === 'peer' ? 'Select at least one peer.' : 'Select at least one peer group.'); setTab('peers'); return; }
    try {
      if (mode === 'peer') {
        for (const p of selPeers) await create.mutateAsync({ peer: p, metric, masquerade, enabled });
      } else {
        await create.mutateAsync({ peerGroups: selGroups, metric, masquerade, enabled });
      }
      onClose();
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<Share2 size={18} />}
      title="Add Routing Peer"
      subtitle={`Route traffic to '${name}'`}
      size="md"
      tabs={
        <Tabs bordered={false} value={tab} onChange={(k) => setTab(k as 'peers' | 'advanced')} items={[
          { key: 'peers', label: <span className="inline-flex items-center gap-2"><Share2 size={15} /> Routing Peers</span> },
          { key: 'advanced', label: <span className="inline-flex items-center gap-2"><Settings2 size={15} /> Advanced Settings</span> },
        ]} />
      }
      footer={
        <>
          {tab === 'peers'
            ? <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            : <Button variant="secondary" size="sm" onClick={() => setTab('peers')}>Back</Button>}
          {tab === 'peers'
            ? <Button variant="primary" size="sm" onClick={() => setTab('advanced')} disabled={!hasSelection}>Continue</Button>
            : <Button variant="primary" size="sm" onClick={submit} disabled={create.isPending || !hasSelection}>{create.isPending ? 'Adding…' : 'Add Routing Peer'}</Button>}
        </>
      }
    >
      {tab === 'peers' ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-3 flex flex-col gap-3">
            {canManage && (
              <PillTabs
                items={[
                  { key: 'peer', icon: <Share2 size={14} />, label: 'Routing Peers' },
                  { key: 'group', icon: <Grid3x3 size={14} />, label: 'Peer Group' },
                ]}
                value={mode}
                onChange={(k) => setMode(k as 'peer' | 'group')}
              />
            )}
            <div>
              <p className="text-[0.85rem] text-nb-gray-500 dark:text-nb-gray-400 mb-2">
                {mode === 'peer' ? 'Assign a single or multiple peers as routing peers for the network.' : 'All peers in the selected group(s) act as routing peers for the network.'}
              </p>
              {mode === 'peer'
                ? <GroupMultiSelect groups={peerOptions} value={selPeers} onChange={setSelPeers} placeholder="Select a peer…" />
                : <GroupMultiSelect groups={groupOptions} value={selGroups} onChange={setSelGroups} placeholder="Select a peer group…" />}
            </div>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <SettingCard icon={<Power size={16} />} title="Enable Routing Peer" desc="Use this switch to enable or disable the routing peer.">
            <Switch checked={enabled} onChange={setEnabled} />
          </SettingCard>
          <SettingCard icon={<VenetianMask size={16} />} title="Masquerade" desc="Allow access to your private networks without configuring routes on your local routers or other devices.">
            <Switch checked={masquerade} onChange={setMasquerade} />
          </SettingCard>
          <div className="flex items-start justify-between gap-6 pt-1">
            <div>
              <Label>Metric</Label>
              <FieldHint>A lower metric indicates higher priority routing peers.</FieldHint>
            </div>
            <div className="inline-flex items-stretch shrink-0">
              <span className="inline-flex items-center justify-center px-2.5 rounded-l-md border border-r-0 border-nb-gray-200 dark:border-nb-gray-700 text-nb-gray-400 bg-nb-gray-100/60 dark:bg-nb-gray-930/60"><ArrowDownNarrowWide size={14} /></span>
              <Input type="number" min={1} max={9999} value={metric} onChange={(e) => setMetric(parseInt(e.target.value, 10) || 9999)} className="w-24 !rounded-l-none" />
            </div>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700')}>
      <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

function SettingCard({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-3.5">
      <div className="flex items-start gap-3 min-w-0">
        <span className="text-nb-gray-400 mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">{title}</div>
          <div className="text-[0.8rem] text-nb-gray-500 dark:text-nb-gray-400">{desc}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function PoliciesPanel({ policies }: { policies: Policy[] }) {
  // Standard client pagination (default 25), same chrome as the admin Policies page.
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  useEffect(() => { setPage(1); }, [perPage]);

  const rows: PolicyRow[] = policies.map((p, i) => {
    const r = (p.rules && p.rules[0]) || {};
    return {
      id: p.name || String(i),
      name: p.name || '',
      enabled: p.enabled !== false,
      sources: r.sources || [],
      destinations: r.destinations || [],
      bidirectional: !!r.bidirectional,
      protocol: r.protocol || 'all',
      ports: r.ports || [],
    };
  });
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
      </div>
      <PolicyTable policies={rows} emptyHint="This network has no access-control policies." pagination={{ page, perPage, onPage: setPage, label: 'policies' }} />
    </div>
  );
}
