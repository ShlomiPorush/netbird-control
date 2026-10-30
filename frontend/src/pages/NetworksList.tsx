import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, ShieldCheck, Plus, GitFork, Filter, ChevronsUpDown, RefreshCw, Settings as Gear, ExternalLink, Edit2, Trash2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useNetworks, useResourceConflicts } from '@/lib/queries';
import { useDeleteNetwork, useNetbirdRefresh } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useViewer } from '@/contexts/ViewerContext';
import { useTableSort } from '@/lib/useTableSort';
import type { Network } from '@/lib/types';
import {
  SearchInput, Badge, Button, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td, PageHeader, Pagination, RowMenu, MenuItem,
} from '@/components/ui';
import { NetworkModal } from '@/components/networks/NetworkModal';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { Rows3 } from 'lucide-react';

type StatusF = 'all' | 'active' | 'inactive';

function initials(name?: string): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export default function NetworksList() {
  const nq = useNetworks();
  const refresh = useNetbirdRefresh();
  const { isAdmin, can } = useViewer();
  // Network-level management (create/edit/delete): admins or 'Manage All Networks' holders.
  const canManage = isAdmin || can('networks.manage');
  const conflictsData = useResourceConflicts(canManage).data?.conflicts || [];
  const navigate = useNavigate();
  const del = useDeleteNetwork();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusF>('all');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [creating, setCreating] = useState(false);
  const [editingNet, setEditingNet] = useState<Network | null>(null);

  // Networks with same-address resource conflicts get a prominent warning marker.
  const conflictsByNet = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of conflictsData) {
      for (const n of (c.networks || [{ id: c.networkId, name: c.networkName }])) {
        m.set(n.id, (m.get(n.id) || 0) + 1);
      }
    }
    return m;
  }, [conflictsData]);

  const onDelete = async (n: Network) => {
    const parts: string[] = [];
    if (n.resources) parts.push(`${n.resources} resource${n.resources === 1 ? '' : 's'}`);
    if (n.routingPeers) parts.push(`${n.routingPeers} routing peer${n.routingPeers === 1 ? '' : 's'}`);
    const extra = parts.length ? ` This also removes ${parts.join(' and ')} and the access policies created for them.` : '';
    const ok = await confirm({
      title: 'Delete network?',
      message: `"${n.name || n.id}" will be permanently deleted.${extra} This can't be undone.`,
      confirmText: 'Delete network',
    });
    if (ok) {
      try { await del.mutateAsync(n.id); }
      catch (e) { await confirm({ title: 'Delete failed', message: (e as Error).message, confirmText: 'OK' }); }
    }
  };

  const all = nq.data || [];
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return all.filter((n: Network) => {
      const active = (n.routingPeers || 0) > 0;
      if (status === 'active' && !active) return false;
      if (status === 'inactive' && active) return false;
      return !q || (n.name || '').toLowerCase().includes(q) || (n.description || '').toLowerCase().includes(q);
    });
  }, [all, search, status]);

  const { sorted, state } = useTableSort(filtered, {
    name: (n) => n.name || n.id,
    resources: (n) => n.resources || 0,
    policies: (n) => n.policies || 0,
    routingPeers: (n) => n.routingPeers || 0,
  });

  useEffect(() => { setPage(1); }, [search, status, perPage]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * perPage, safePage * perPage);
  const goEdit = (n: Network) => navigate(`/networks/${encodeURIComponent(n.id)}`);
  const goTab = (n: Network, tab: string, e: React.MouseEvent) => { e.stopPropagation(); navigate(`/networks/${encodeURIComponent(n.id)}?tab=${tab}`); };

  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm mb-4 text-nb-gray-400">
        <GitFork size={14} /> Network Routing
      </div>
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title={`${all.length} Network${all.length === 1 ? '' : 's'}`}
          description="Access internal resources in LANs and VPCs without installing NetBird on every machine."
        />
        {canManage && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={15} /> Add Network</Button>}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by network name or description…" />
        <StatusFilter value={status} onChange={setStatus} />
        {status !== 'all' && <button onClick={() => setStatus('all')} className="text-[0.8rem] text-netbird hover:underline">Clear</button>}
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <Button variant="secondary" className="ml-auto px-0! w-[42px]" title="Refresh" onClick={async () => { await refresh.mutateAsync(); nq.refetch(); }}>
          <RefreshCw size={16} className={(refresh.isPending || nq.isFetching) ? 'animate-spin' : undefined} />
        </Button>
      </div>

      {nq.isLoading ? <LoadingState /> : !sorted.length ? (
        <EmptyState title="No Networks" hint={search || status !== 'all' ? 'No networks match your filters.' : canManage ? 'Create a network to get started.' : 'There are no networks to show.'} />
      ) : (
        <>
          <div className="hidden md:block">
          <Table>
            <THead>
              <SortTh label="Network" sortKey="name" state={state} />
              <SortTh label="Resources" sortKey="resources" state={state} />
              <SortTh label="Policies" sortKey="policies" state={state} />
              <SortTh label="Routing Peers" sortKey="routingPeers" state={state} />
              <Th className="text-right">{''}</Th>
            </THead>
            <TBody>
              {pageRows.map((n) => {
                const active = (n.routingPeers || 0) > 0;
                return (
                  <Tr key={n.id} onClick={() => goEdit(n)}>
                    <Td>
                      <div className="flex items-center gap-3.5">
                        <div className="relative flex items-center justify-center h-9 w-9 rounded-md shrink-0 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-700 dark:text-nb-gray-200 text-xs font-semibold">
                          {initials(n.name)}
                          <span className={cn('absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-nb-gray-960', active ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} title={active ? 'Active' : 'Inactive'} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate">{n.name || n.id}</span>
                            {(conflictsByNet.get(n.id) || 0) > 0 && (
                              <span title={`${conflictsByNet.get(n.id)} address conflict${conflictsByNet.get(n.id) === 1 ? '' : 's'} - duplicate resources with overlapping users. Open the network to fix.`}
                                className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400 shrink-0">
                                <AlertTriangle size={11} /> Conflict{(conflictsByNet.get(n.id) || 0) > 1 ? `s ${conflictsByNet.get(n.id)}` : ''}
                              </span>
                            )}
                          </div>
                          {n.description && <div className="text-[0.8rem] text-nb-gray-500 truncate">{n.description}</div>}
                        </div>
                      </div>
                    </Td>
                    <Td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        {n.resources ? <Badge tone="gray" icon={<Layers size={12} />}>{n.resources}</Badge> : null}
                        {n.canEdit && <AddChip onClick={(e) => goTab(n, 'resources', e)} />}
                        {!n.resources && !n.canEdit && <span className="text-nb-gray-500 text-sm">-</span>}
                      </div>
                    </Td>
                    <Td>
                      {n.policies ? <Badge tone="gray" icon={<ShieldCheck size={12} />}>{n.policies}</Badge> : <span className="text-nb-gray-500 text-sm">-</span>}
                    </Td>
                    <Td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        {active && (
                          <span className="inline-flex items-center gap-1.5 rounded-md text-[0.75rem] py-1 pl-2.5 pr-1 border border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-500">
                            <span className="h-2 w-2 rounded-full bg-green-500" /> {n.routingPeers} Peer{n.routingPeers === 1 ? '' : 's'}
                            {n.canEdit && <button onClick={(e) => goTab(n, 'routers', e)} title="Manage routing peers" className="ml-0.5 inline-flex items-center justify-center h-5 w-5 rounded-sm text-green-600/80 dark:text-green-500/80 hover:bg-green-500/15"><Gear size={12} /></button>}
                          </span>
                        )}
                        {n.canEdit && <AddChip onClick={(e) => goTab(n, 'routers', e)} />}
                        {!active && !n.canEdit && <span className="text-nb-gray-500 text-sm">-</span>}
                      </div>
                    </Td>
                    <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <NetMenu onOpen={() => goEdit(n)} onEdit={canManage ? () => setEditingNet(n) : undefined} onDelete={canManage ? () => onDelete(n) : undefined} />
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
          </div>

          {/* Mobile: cards instead of a horizontally-scrolling table */}
          <div className="md:hidden flex flex-col gap-2.5">
            {pageRows.map((n) => {
              const active = (n.routingPeers || 0) > 0;
              return (
                <div key={n.id} onClick={() => goEdit(n)}
                  className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors">
                  <div className="flex items-start gap-3">
                    <div className="relative flex items-center justify-center h-9 w-9 rounded-md shrink-0 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-700 dark:text-nb-gray-200 text-xs font-semibold">
                      {initials(n.name)}
                      <span className={cn('absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-nb-gray-960', active ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{n.name || n.id}</div>
                      {n.description && <div className="text-[0.8rem] text-nb-gray-500 line-clamp-2">{n.description}</div>}
                    </div>
                    <div className="shrink-0 -mt-1 -mr-1" onClick={(e) => e.stopPropagation()}>
                      <NetMenu onOpen={() => goEdit(n)} onEdit={canManage ? () => setEditingNet(n) : undefined} onDelete={canManage ? () => onDelete(n) : undefined} />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    {(conflictsByNet.get(n.id) || 0) > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                        <AlertTriangle size={11} /> Address Conflict
                      </span>
                    )}
                    {n.resources ? <Badge tone="gray" icon={<Layers size={12} />}>{n.resources} Resource{n.resources === 1 ? '' : 's'}</Badge> : null}
                    {n.policies ? <Badge tone="gray" icon={<ShieldCheck size={12} />}>{n.policies} Polic{n.policies === 1 ? 'y' : 'ies'}</Badge> : null}
                    {active && (
                      <span className="inline-flex items-center gap-1.5 rounded-md text-[0.75rem] py-1 pl-2.5 pr-1 border border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-500">
                        <span className="h-2 w-2 rounded-full bg-green-500" /> {n.routingPeers} Peer{n.routingPeers === 1 ? '' : 's'}
                        {n.canEdit && <button onClick={(e) => goTab(n, 'routers', e)} title="Manage routing peers" className="ml-0.5 inline-flex items-center justify-center h-5 w-5 rounded-sm text-green-600/80 dark:text-green-500/80 hover:bg-green-500/15"><Gear size={12} /></button>}
                      </span>
                    )}
                    {n.canEdit && <AddChip onClick={(e) => goTab(n, 'resources', e)} />}
                    {!n.resources && !n.policies && !active && !n.canEdit && <span className="text-nb-gray-500 text-sm">-</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination page={safePage} totalPages={totalPages} onPage={setPage} total={sorted.length} label="Networks" />
        </>
      )}

      {creating && (
        <NetworkModal
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); navigate(`/networks/${encodeURIComponent(id)}`); }}
        />
      )}
      {editingNet && <NetworkModal network={editingNet} onClose={() => setEditingNet(null)} />}
    </div>
  );
}

function AddChip({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1.5 h-[30px] px-2.5 rounded-md text-[0.75rem] border border-nb-gray-200 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800">
      <Plus size={12} /> Add
    </button>
  );
}

function StatusFilter({ value, onChange }: { value: StatusF; onChange: (v: StatusF) => void }) {
  const [open, setOpen] = useState(false);
  const opts: { v: StatusF; label: string; dot: string }[] = [
    { v: 'all', label: 'All', dot: 'bg-nb-gray-400' },
    { v: 'active', label: 'Active', dot: 'bg-green-500' },
    { v: 'inactive', label: 'Inactive', dot: 'bg-nb-gray-500 dark:bg-nb-gray-600' },
  ];
  return (
    <div className="relative">
      <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
        <Filter size={16} /> Filters
        {value !== 'all' && <span className="ml-0.5 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-netbird text-white text-[0.65rem] font-semibold">1</span>}
        <ChevronsUpDown size={14} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1.5 z-50 w-44 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
            <div className="px-2.5 pt-1 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-nb-gray-400">Status</div>
            {opts.map((o) => (
              <button key={o.v} onClick={() => { onChange(o.v); setOpen(false); }}
                className={cn('flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-sm text-sm', value === o.v ? 'bg-netbird/10 text-netbird' : 'text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900')}>
                <span className={cn('h-2 w-2 rounded-full', o.dot)} /> {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NetMenu({ onOpen, onEdit, onDelete }: { onOpen: () => void; onEdit?: () => void; onDelete?: () => void }) {
  return (
    <RowMenu width={192}>
      {(close) => (
        <>
          <MenuItem icon={<ExternalLink size={14} />} onClick={() => { close(); onOpen(); }}>Open network</MenuItem>
          {onEdit && <MenuItem icon={<Edit2 size={14} />} onClick={() => { close(); onEdit(); }}>Edit network</MenuItem>}
          {onDelete && <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { close(); onDelete(); }}>Delete network</MenuItem>}
        </>
      )}
    </RowMenu>
  );
}

