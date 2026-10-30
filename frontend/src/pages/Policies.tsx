import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, RefreshCw, Rows3, Filter, ChevronsUpDown, Plus, Pencil, Copy, Trash2, Wand2, ArrowRight, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePolicies } from '@/lib/queries';
import { useDeletePolicy, useNetbirdRefresh, useTidyNamesPlan, useApplyTidyNames } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useViewer } from '@/contexts/ViewerContext';
import { ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { PolicyTable, type PolicyRow } from '@/components/networks/PolicyTable';
import { PolicyModal } from '@/components/networks/PolicyModal';
import type { Policy, TidyNamesPlan, TidyNamesResult } from '@/lib/types';
import { SearchInput, Button, PageHeader, LoadingState, EmptyState, ClearFiltersButton, RowMenu, MenuItem, Modal, Spinner, Badge, Checkbox, FieldHint } from '@/components/ui';
import { ToolbarMenu } from '@/components/logs/toolbar';

type StatusF = 'all' | 'enabled' | 'disabled';

export default function Policies() {
  const pq = usePolicies();
  const refresh = useNetbirdRefresh();
  const del = useDeletePolicy();
  const confirm = useConfirm();
  // tenantAdmin = admin, or a Tenant Support holder managing a tenant (the server elevates them
  // to admin inside that tenant), so the write actions show wherever the server allows them.
  const { tenantAdmin: canWrite } = useViewer();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusF>('all');
  const [editing, setEditing] = useState<Policy | null>(null);
  const [duplicating, setDuplicating] = useState<Policy | null>(null);
  const [adding, setAdding] = useState(false);
  const [tidyOpen, setTidyOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  useEffect(() => { setPage(1); }, [search, status, perPage]);

  const all = pq.data || [];
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return all.filter((p) => {
      const enabled = p.enabled !== false;
      if (status === 'enabled' && !enabled) return false;
      if (status === 'disabled' && enabled) return false;
      return !q || (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q);
    });
  }, [all, search, status]);

  // The page mirrors NetBird's Policies table - each policy is summarised by its first rule.
  const rows: PolicyRow[] = filtered.map((p, i) => {
    const rules = p.rules || [];
    const r0 = rules[0] || {};
    // A policy can have several rules; aggregate them so the table shows ALL destinations
    // (groups and resources), not just the first rule's.
    const dedup = <T extends { id: string }>(items: T[]) => {
      const m = new Map<string, T>(); items.forEach((x) => x && x.id && m.set(x.id, x)); return [...m.values()];
    };
    return {
      id: p.id || p.name || String(i),
      name: p.name || '',
      profileName: p.profileName,
      enabled: p.enabled !== false,
      sources: dedup(rules.flatMap((r) => r.sources || [])),
      destinations: dedup(rules.flatMap((r) => r.destinations || [])),
      destinationResources: rules.map((r) => r.destinationResource).filter(Boolean) as NonNullable<typeof r0.destinationResource>[],
      bidirectional: !!r0.bidirectional,
      protocol: r0.protocol || 'all',
      ports: r0.ports || [],
    };
  });

  const policyOf = (row: PolicyRow) => all.find((p) => (p.id || p.name) === row.id) || null;

  const onDelete = async (row: PolicyRow) => {
    const ok = await confirm({
      title: 'Delete policy?',
      message: `"${row.name || row.id}" will be permanently removed from NetBird. Peers relying on it will lose the access it granted. This can't be undone.`,
      confirmText: 'Delete',
    });
    if (ok) {
      try { await del.mutateAsync(row.id); }
      catch (e) { await confirm({ title: 'Delete failed', message: (e as Error).message, confirmText: 'OK' }); }
    }
  };

  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm mb-4 text-nb-gray-400">
        <ShieldCheck size={14} /> Access Control
      </div>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <PageHeader
          title={`${all.length} Polic${all.length === 1 ? 'y' : 'ies'}`}
          description="Access control policies allow connections between groups of peers and resources by specific protocol and ports."
        />
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 mb-4 sm:mb-0">
            <Button variant="secondary" onClick={() => setTidyOpen(true)} title="Rename resource policies to match the naming template (Settings → General)">
              <Wand2 size={15} /> Tidy Names
            </Button>
            <Button variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> Add Policy</Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or description…" />
        <StatusFilter value={status} onChange={setStatus} />
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton active={!!search || status !== 'all'} onClear={() => { setSearch(''); setStatus('all'); }} />
        <Button variant="secondary" className="ml-auto px-0! w-[42px]" title="Refresh" onClick={async () => { await refresh.mutateAsync(); pq.refetch(); }}>
          <RefreshCw size={16} className={(refresh.isPending || pq.isFetching) ? 'animate-spin' : undefined} />
        </Button>
      </div>

      {pq.isLoading ? (
        <LoadingState />
      ) : pq.isError ? (
        <EmptyState title="Couldn’t Load Policies" hint="The NetBird connection may be unavailable. Try refreshing." icon={<ShieldCheck size={22} />} />
      ) : (
        <PolicyTable
          policies={rows}
          emptyHint={search || status !== 'all' ? 'No policies match your filters.' : 'There are no access-control policies yet.'}
          onRowClick={canWrite ? (row) => setEditing(policyOf(row)) : undefined}
          rowActions={canWrite ? (row) => (
            <PolicyRowMenu onEdit={() => setEditing(policyOf(row))} onDuplicate={() => setDuplicating(structuredClone(policyOf(row)))} onDelete={() => onDelete(row)} />
          ) : undefined}
          pagination={{ page, perPage, onPage: setPage, label: 'policies' }}
        />
      )}

      {(adding || editing || duplicating) && (
        <PolicyModal policy={editing} duplicateOf={duplicating} onClose={() => { setAdding(false); setEditing(null); setDuplicating(null); }} />
      )}
      {tidyOpen && <TidyNamesModal onClose={() => { setTidyOpen(false); pq.refetch(); }} />}
    </div>
  );
}

/** Preview + apply renaming resource policies to the naming template (Settings → General). */
function TidyNamesModal({ onClose }: { onClose: () => void }) {
  const plan = useTidyNamesPlan();
  const apply = useApplyTidyNames();
  const [data, setData] = useState<TidyNamesPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<TidyNamesResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    plan.mutateAsync()
      .then((r) => { setData(r); setSelected(new Set(r.items.filter((x) => x.changed).map((x) => x.id))); })
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = data?.items || [];
  const changed = items.filter((x) => x.changed);
  const alreadyOk = items.length - changed.length;
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = changed.length > 0 && changed.every((x) => selected.has(x.id));

  const run = async () => {
    setError('');
    try { setResult(await apply.mutateAsync([...selected])); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<Wand2 size={18} />}
      title="Tidy Policy Names"
      subtitle={data ? `Template: ${data.template} · Shared resources: ${data.sharedTemplate || '{service}'} (change under Settings → General)` : 'Align resource-policy names with the naming template.'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
          {!result && changed.length > 0 && (
            <Button variant="primary" size="sm" onClick={run} disabled={!selected.size || apply.isPending}>
              {apply.isPending ? 'Renaming…' : `Rename ${selected.size}`}
            </Button>
          )}
        </>
      }
    >
      {!data && !error ? (
        <div className="flex items-center justify-center gap-2.5 py-12 text-nb-gray-500 text-sm"><Spinner /> Scanning policies…</div>
      ) : error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</div>
      ) : result ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3">
            <CheckCircle2 size={20} className="text-green-500 shrink-0" />
            <div className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
              <div className="font-semibold text-nb-gray-800 dark:text-nb-gray-100">Done</div>
              {result.renamed} renamed{result.failed ? <span className="text-red-500"> · {result.failed} failed</span> : ''}
            </div>
          </div>
          {!!result.errors?.length && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-[0.8rem] text-red-500">
              {result.errors.map((e, i) => <div key={i}>{e.name || e.id}: {e.error}</div>)}
            </div>
          )}
        </div>
      ) : !changed.length ? (
        <EmptyState title="Everything Already Matches" hint={`All ${items.length} eligible resource policies already follow the template.`} icon={<CheckCircle2 size={22} />} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <FieldHint>
              <b>{changed.length}</b> of {items.length} eligible policies would be renamed.
              {alreadyOk > 0 && <> {alreadyOk} already match.</>}
              {(data?.excluded || 0) > 0 && <> {data!.excluded} excluded (Access Profile / temporary / group-based policies).</>}
              {(data?.excludedCollisions || 0) > 0 && <> <span className="text-amber-600 dark:text-amber-400">{data!.excludedCollisions} excluded - they would get identical names on one resource (their current names distinguish the services).</span></>}
            </FieldHint>
            <button type="button" className="text-[0.78rem] text-netbird hover:underline shrink-0"
              onClick={() => setSelected(allOn ? new Set() : new Set(changed.map((x) => x.id)))}>
              {allOn ? 'Clear Selection' : `Select All (${changed.length})`}
            </button>
          </div>
          <div className="nb-scroll rounded-md border border-nb-gray-200 dark:border-nb-gray-800 divide-y divide-nb-gray-100 dark:divide-nb-gray-900 max-h-[48vh] overflow-y-auto">
            {changed.map((it) => (
              <label key={it.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40">
                <Checkbox checked={selected.has(it.id)} onChange={() => toggle(it.id)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-nb-gray-500 line-through truncate">{it.currentName || '(unnamed)'}</span>
                    <ArrowRight size={13} className="text-nb-gray-400 shrink-0" />
                    <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{it.proposedName}</span>
                  </span>
                  <span className="block text-[0.74rem] text-nb-gray-500 truncate">{it.resourceName}</span>
                </span>
                {it.shared && <Badge tone="cyan">Shared</Badge>}
                <Badge tone="gray">{it.protocol}</Badge>
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function PolicyRowMenu({ onEdit, onDuplicate, onDelete }: { onEdit: () => void; onDuplicate: () => void; onDelete: () => void }) {
  return (
    <RowMenu width={160}>
      {(close) => (
        <>
          <MenuItem icon={<Pencil size={14} />} onClick={() => { close(); onEdit(); }}>Edit policy</MenuItem>
          <MenuItem icon={<Copy size={14} />} onClick={() => { close(); onDuplicate(); }}>Duplicate</MenuItem>
          <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { close(); onDelete(); }}>Delete</MenuItem>
        </>
      )}
    </RowMenu>
  );
}

function StatusFilter({ value, onChange }: { value: StatusF; onChange: (v: StatusF) => void }) {
  const [open, setOpen] = useState(false);
  const opts: { v: StatusF; label: string; dot: string }[] = [
    { v: 'all', label: 'All', dot: 'bg-nb-gray-400' },
    { v: 'enabled', label: 'Enabled', dot: 'bg-green-500' },
    { v: 'disabled', label: 'Disabled', dot: 'bg-nb-gray-500 dark:bg-nb-gray-600' },
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
