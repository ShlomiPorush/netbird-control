import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Ban, ShieldAlert, CheckCircle2, AlertTriangle, Rows3, Network as NetworkIcon, Play, Pause, Building2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useBlocklist, useNetworks, useNetworkDetail, useMspStatus } from '@/lib/queries';
import { useSaveBlocklist, useBulkAddBlocklist, useDeleteBlocklist, useScanBlockedResources, useEnforceBlocklist, usePropagateBlocklist } from '@/lib/mutations';
import { getTenantMode } from '@/lib/api';
import { useConfirm } from '@/contexts/ConfirmContext';
import { addressBlockedForNetwork } from '@/lib/blocklist';
import type { BlocklistEntry, BlocklistInput, BlocklistEnforce, BlockedMatchesResult, BlockedResourceMatch, EnforceBlocklistResult } from '@/lib/types';
import {
  Badge, Button, IconButton, EmptyState, LoadingState, Spinner, Table, THead, Th, SortTh, TBody, Tr, Td,
  Modal, Field, FieldHint, Input, SelectMenu, GroupMultiSelect, SearchInput, Pagination, ClearFiltersButton, Checkbox,
} from '@/components/ui';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { ToolbarMenu } from '@/components/logs/toolbar';

const ENFORCE_META: Record<BlocklistEnforce, { label: string; chip: string; tone: 'gray' | 'orange' | 'red' }> = {
  none: { label: 'Block new only', chip: '', tone: 'gray' },
  disable: { label: 'Disable existing', chip: 'Disables Existing', tone: 'orange' },
  delete: { label: 'Delete existing', chip: 'Deletes Existing', tone: 'red' },
};

export function Blocklist() {
  const { data, isLoading } = useBlocklist();
  const networks = useNetworks().data || [];
  const del = useDeleteBlocklist();
  const confirm = useConfirm();
  const [modal, setModal] = useState<{ entry: BlocklistEntry | null } | null>(null);
  const [fromNetworkOpen, setFromNetworkOpen] = useState(false);
  const [enforceOpen, setEnforceOpen] = useState(false);
  const [search, setSearch] = useState('');
  const entries = data || [];
  // Disabled entries can't enforce anything.
  const hasEnforcers = entries.some((e) => e.enabled !== false && e.enforce && e.enforce !== 'none');

  // Pause/resume an entry without losing its configuration.
  const save = useSaveBlocklist();
  const onToggleEnabled = (e: BlocklistEntry) =>
    save.mutate({ id: e.id, payload: { value: e.value, note: e.note, scope: e.scope, networks: e.networks, enforce: e.enforce, enabled: e.enabled === false } });

  const netName = useMemo(() => {
    const m = new Map(networks.map((n) => [n.id, n.name || n.id]));
    return (id: string) => m.get(id) || id;
  }, [networks]);

  const scopeLabel = (e: BlocklistEntry) =>
    e.scope === 'all' ? 'All networks'
      : e.scope === 'only' ? `Only ${e.networks.length} Network${e.networks.length === 1 ? '' : 's'}`
        : `All Except ${e.networks.length}`;

  // Standard table chrome (same as every list page): search + sort + client pagination.
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return entries;
    return entries.filter((e) =>
      (e.value || '').toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q));
  }, [entries, search]);
  const { sorted, state } = useTableSort(filtered, {
    value: (e) => e.value || '',
    appliesTo: (e) => scopeLabel(e),
    existing: (e) => (e.enforce && e.enforce !== 'none' ? ENFORCE_META[e.enforce].chip : ''),
    note: (e) => e.note || '',
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25, [search]);

  const onDelete = async (e: BlocklistEntry) => {
    const ok = await confirm({ title: 'Remove from blocklist', message: `Allow “${e.value}” again? New resources with this address will be permitted.`, confirmText: 'Remove' });
    if (ok) await del.mutateAsync(e.id);
  };

  // MSP admin only, and never while managing a tenant: push this main blocklist to every tenant.
  const propagate = usePropagateBlocklist();
  const canPropagate = useMspStatus().data?.available === true && !getTenantMode();
  const onPropagate = async () => {
    const ok = await confirm({
      title: 'Apply To All Tenants',
      message: "This REPLACES every tenant's blocklist with this main account's current entries. Entries limited to specific networks are NOT copied - network ids are account-specific. Continue?",
      confirmText: 'Apply To All Tenants',
    });
    if (!ok) return;
    try {
      const r = await propagate.mutateAsync();
      await confirm({ title: 'Applied', message: `Applied to ${r.tenants} tenant(s) - ${r.copied} entr${r.copied === 1 ? 'y' : 'ies'} copied, ${r.skipped} skipped.${r.errors ? ` ${r.errors} tenant(s) failed.` : ''}`, confirmText: 'OK', danger: false });
    } catch (err) { await confirm({ title: 'Failed to Save', message: (err as Error).message, confirmText: 'OK' }); }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between mb-5 gap-3">
        <div>
          <p className="text-nb-gray-500 text-sm max-w-2xl">
            Addresses that may <b>not</b> be added as resources - by anyone (admins and editors) or by automations.
            Scope each entry to specific networks (or all but some). Set an entry to <b>Disable</b> or <b>Delete existing</b> to
            also act on resources that already exist, then run <b>Enforce on existing</b> to apply it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {canPropagate && (
            <Button variant="secondary" onClick={onPropagate} disabled={propagate.isPending} title="Replace every tenant's blocklist with this one">
              <Building2 size={15} /> Apply To All Tenants
            </Button>
          )}
          <Button variant="secondary" onClick={() => setEnforceOpen(true)} disabled={!hasEnforcers} title={hasEnforcers ? 'Scan existing resources and apply the blocklist' : 'Set an entry to Disable/Delete existing first'}>
            <ShieldAlert size={15} /> Enforce on existing
          </Button>
          <Button variant="secondary" onClick={() => setFromNetworkOpen(true)} title="Pick addresses from a network's existing resources">
            <NetworkIcon size={15} /> Add From Network
          </Button>
          <Button variant="primary" onClick={() => setModal({ entry: null })}><Plus size={15} /> Add</Button>
        </div>
      </div>

      {isLoading ? <LoadingState /> : !entries.length ? (
        <EmptyState title="Nothing Blocked" hint="Add an address or range to prevent it from being used as a resource." icon={<Ban size={22} />} />
      ) : (
        <>
          {/* Standard table chrome: search + rows-per-page, sortable columns, pagination. */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search address or note…" />
            <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
            <ClearFiltersButton active={!!search} onClear={() => setSearch('')} />
          </div>

          {!sorted.length ? (
            <EmptyState title="No Matching Entries" hint="Try a different search." icon={<Ban size={22} />} />
          ) : (
            <>
        <Table>
          <THead>
            <SortTh label="Blocked Address / Range" sortKey="value" state={state} />
            <SortTh label="Applies To" sortKey="appliesTo" state={state} />
            <SortTh label="Existing Resources" sortKey="existing" state={state} />
            <SortTh label="Note" sortKey="note" state={state} />
            <Th className="text-right">{''}</Th>
          </THead>
          <TBody>
            {pageRows.map((e) => (
              <Tr key={e.id} onClick={() => setModal({ entry: e })} className={cn(e.enabled === false && 'opacity-55')}>
                <Td>
                  <span className="inline-flex items-center gap-2">
                    <span className="font-mono text-[0.85rem] text-nb-gray-800 dark:text-nb-gray-200">{e.value}</span>
                    {e.mode === 'limit' && <Badge tone="cyan">Max /{e.maxPrefix}</Badge>}
                    {e.enabled === false && <Badge tone="gray">Disabled</Badge>}
                  </span>
                </Td>
                <Td>
                  {e.scope === 'all'
                    ? <Badge tone="gray">All Networks</Badge>
                    : (
                      <div className="flex items-center gap-1.5">
                        <Badge tone={e.scope === 'except' ? 'orange' : 'cyan'}>{scopeLabel(e)}</Badge>
                        {e.networks.length > 0 && <span className="text-[0.78rem] text-nb-gray-500 truncate max-w-[260px]">{e.networks.map(netName).join(', ')}</span>}
                      </div>
                    )}
                </Td>
                <Td>
                  {e.enforce && e.enforce !== 'none'
                    ? <Badge tone={ENFORCE_META[e.enforce].tone}>{ENFORCE_META[e.enforce].chip}</Badge>
                    : <span className="text-sm text-nb-gray-400">Not touched</span>}
                </Td>
                <Td><span className="text-sm text-nb-gray-500">{e.note || '-'}</span></Td>
                <Td className="text-right" onClick={(ev) => ev.stopPropagation()}>
                  <div className="inline-flex items-center gap-1.5">
                    <IconButton onClick={() => onToggleEnabled(e)}
                      title={e.enabled === false ? 'Enable - the entry starts blocking again' : 'Disable - keeps the entry configured but it stops blocking'}>
                      {e.enabled === false ? <Play size={15} /> : <Pause size={15} />}
                    </IconButton>
                    <IconButton onClick={() => setModal({ entry: e })} title="Edit"><Pencil size={15} /></IconButton>
                    <IconButton onClick={() => onDelete(e)} title="Remove" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
              <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="entries" />
            </>
          )}
        </>
      )}

      {modal && <BlocklistModal entry={modal.entry} onClose={() => setModal(null)} />}
      {fromNetworkOpen && <AddFromNetworkModal entries={entries} onClose={() => setFromNetworkOpen(false)} />}
      {enforceOpen && <EnforceModal onClose={() => setEnforceOpen(false)} />}
    </div>
  );
}

function BlocklistModal({ entry, onClose }: { entry: BlocklistEntry | null; onClose: () => void }) {
  const save = useSaveBlocklist();
  const networks = useNetworks().data || [];
  const netOptions = useMemo(() => networks.map((n) => ({ id: n.id, name: n.name || n.id })), [networks]);
  const [value, setValue] = useState(entry?.value || '');
  const [note, setNote] = useState(entry?.note || '');
  const [scope, setScope] = useState<string>(entry?.scope || 'all');
  const [nets, setNets] = useState<string[]>(entry?.networks || []);
  const [enforce, setEnforce] = useState<BlocklistEnforce>(entry?.enforce || 'none');
  const [mode, setMode] = useState<'block' | 'limit'>(entry?.mode || 'block');
  const [maxPrefix, setMaxPrefix] = useState<number>(entry?.maxPrefix || 24);
  const [error, setError] = useState('');

  const isIpv4OrCidr = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/.test(value.trim());

  const submit = async () => {
    if (!value.trim()) { setError('Enter an IP, CIDR or domain.'); return; }
    if (mode === 'limit' && !isIpv4OrCidr) { setError('Limit mode requires an IPv4 address or CIDR range (domains can only be blocked).'); return; }
    if (scope !== 'all' && !nets.length) { setError('Select at least one network for this scope.'); return; }
    setError('');
    // Preserve the enabled state - editing a paused entry must not silently re-arm it.
    const payload: BlocklistInput = {
      value: value.trim(), note: note.trim(), scope, networks: scope === 'all' ? [] : nets, enforce,
      enabled: entry ? entry.enabled !== false : true,
      mode, maxPrefix: mode === 'limit' ? maxPrefix : undefined,
    };
    try { await save.mutateAsync({ id: entry?.id, payload }); onClose(); }
    catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<Ban size={18} />}
      title={entry ? 'Edit Blocked Address' : 'Block An Address'}
      subtitle="Prevent this address/range from being added as a resource."
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending}>{save.isPending ? '…' : 'Save'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Address / Range" hint="An exact IP/domain, or a CIDR to block a whole range (e.g. 10.0.0.0/8 also blocks 10.1.2.3). Domains also block subdomains.">
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 10.0.0.0/8 or bad.example.com" />
        </Field>
        <Field label="Mode">
          <SelectMenu value={mode} onChange={(v) => setMode(v as 'block' | 'limit')} searchable={false}
            options={[
              { value: 'block', label: 'Block - nothing matching may be added' },
              { value: 'limit', label: 'Limit width - only small-enough ranges allowed' },
            ]} />
        </Field>
        {mode === 'limit' && (
          <Field label="Max Allowed Prefix"
            hint={`Inside ${isIpv4OrCidr ? value.trim() : 'this range'}, resources broader than /${maxPrefix} are rejected - single hosts and subnets up to /${maxPrefix} pass. Stops someone from adding the whole range as one resource.`}>
            <SelectMenu value={String(maxPrefix)} onChange={(v) => setMaxPrefix(Number(v))} searchable={false}
              options={[8, 12, 16, 20, 22, 24, 26, 28, 30, 32].map((n) => ({
                value: String(n), label: `/${n}${n === 32 ? ' - single hosts only' : ''}`,
              }))} />
          </Field>
        )}
        <Field label="Apply To">
          <SelectMenu value={scope} onChange={(v) => setScope(v)} searchable={false}
            options={[
              { value: 'all', label: 'All networks' },
              { value: 'only', label: 'Only selected networks' },
              { value: 'except', label: 'All networks except selected' },
            ]} />
        </Field>
        {scope !== 'all' && (
          <Field label={scope === 'except' ? 'Allowed Networks (Exceptions)' : 'Networks'} hint={scope === 'except' ? 'The block applies everywhere except these networks.' : 'The block applies only to these networks.'}>
            <GroupMultiSelect groups={netOptions} value={nets} onChange={setNets} placeholder="Select network(s)…" />
          </Field>
        )}
        <Field label="Existing Resources" hint="What to do with resources that already exist and match this block. Applied only when you run “Enforce on existing”.">
          <SelectMenu value={enforce} onChange={(v) => setEnforce(v as BlocklistEnforce)} searchable={false}
            options={[
              { value: 'none', label: 'Block new only - don’t touch existing' },
              { value: 'disable', label: 'Disable existing (reversible)' },
              { value: 'delete', label: 'Delete existing (permanent)' },
            ]} />
        </Field>
        <Field label="Note (Optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why is this blocked?" /></Field>
        {error && <p className="text-sm text-red-500">{error}</p>}
        {enforce === 'delete' && <FieldHint><span className="text-red-500">Deleting removes matching resources from NetBird permanently.</span></FieldHint>}
        {scope === 'all' && enforce === 'none' && <FieldHint>This address will be blocked on every network.</FieldHint>}
      </div>
    </Modal>
  );
}

/** Pick addresses from a network's existing resources (multi-select) and block them all at once.
 *  Also opened from a network's own page (NetworkDetail) with the network + rows preselected. */
export function AddFromNetworkModal({ entries, onClose, initialNetworkId, initialAddresses }: {
  entries: BlocklistEntry[];
  onClose: () => void;
  initialNetworkId?: string;
  initialAddresses?: string[];
}) {
  const bulk = useBulkAddBlocklist();
  const networks = useNetworks().data || [];
  const [netId, setNetId] = useState(initialNetworkId || '');
  const detail = useNetworkDetail(netId || undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set((initialAddresses || []).map((a) => a.trim()).filter(Boolean)));
  const [resQ, setResQ] = useState('');
  // Opened from NetworkDetail with rows already picked: show ONLY those rows by default -
  // in a network with hundreds of resources the picked ones drowned in the full list.
  // "Show All Resources" reveals the rest for adding more.
  const initialSet = useMemo(() => new Set((initialAddresses || []).map((a) => a.trim()).filter(Boolean)), [initialAddresses]);
  const [onlyPicked, setOnlyPicked] = useState(initialSet.size > 0);
  const [scope, setScope] = useState<string>('all');
  const [nets, setNets] = useState<string[]>([]);
  const [enforce, setEnforce] = useState<BlocklistEnforce>('none');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const netOptions = useMemo(() => networks.map((n) => ({ id: n.id, name: n.name || n.id })), [networks]);
  const resources = useMemo(() => (detail.data?.resources || []).filter((r) => (r.address || '').trim()), [detail.data]);

  // A resource whose address is already covered by the blocklist can't be picked again.
  const blockedBy = useMemo(() => {
    const m = new Map<string, string>();
    if (netId) for (const r of resources) {
      const hit = addressBlockedForNetwork(r.address!, netId, entries);
      if (hit) m.set(r.id, hit);
    }
    return m;
  }, [resources, netId, entries]);

  // Search within the network's resources (address or name). Selection survives the filter,
  // and Select All only touches the rows currently shown.
  const visible = useMemo(() => {
    const base = onlyPicked ? resources.filter((r) => initialSet.has((r.address || '').trim())) : resources;
    const s = resQ.toLowerCase().trim();
    if (!s) return base;
    return base.filter((r) => (r.address || '').toLowerCase().includes(s) || (r.name || '').toLowerCase().includes(s));
  }, [resources, resQ, onlyPicked, initialSet]);
  const visSelectable = visible.filter((r) => !blockedBy.has(r.id));
  const allOn = visSelectable.length > 0 && visSelectable.every((r) => selected.has(r.address!.trim()));
  // Preselected rows (from NetworkDetail) may turn out to be already covered - never submit those.
  const blockedAddrs = useMemo(() => new Set([...blockedBy.keys()].map((rid) => resources.find((r) => r.id === rid)?.address?.trim() || '')), [blockedBy, resources]);
  const chosen = [...selected].filter((a) => !blockedAddrs.has(a));

  const pickNetwork = (id: string) => {
    setNetId(id);
    setSelected(new Set());
    setResQ('');
    setOnlyPicked(false); // the preselected rows belong to the original network
    // Scoping to the picked network is the common intent - prefill it (still editable).
    setNets((prev) => (scope === 'all' ? prev : [id]));
  };

  const toggle = (address: string) =>
    setSelected((s) => { const n = new Set(s); n.has(address) ? n.delete(address) : n.add(address); return n; });

  const submit = async () => {
    if (!chosen.length) { setError('Select at least one address.'); return; }
    if (scope !== 'all' && !nets.length) { setError('Select at least one network for this scope.'); return; }
    setError('');
    try {
      await bulk.mutateAsync({ values: chosen, note: note.trim(), scope, networks: scope === 'all' ? [] : nets, enforce });
      onClose();
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<NetworkIcon size={18} />}
      title="Block Addresses From A Network"
      subtitle="Pick existing resource addresses and add them all to the blocklist."
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={bulk.isPending || !chosen.length}>
            {bulk.isPending ? '…' : `Block ${chosen.length || ''} Address${chosen.length === 1 ? '' : 'es'}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Network" hint="Choose the network whose resources you want to pick from.">
          <SelectMenu value={netId} onChange={pickNetwork} placeholder="Select a network…"
            options={netOptions.map((n) => ({ value: n.id, label: n.name }))} />
        </Field>

        {netId && (detail.isLoading ? (
          <div className="flex items-center justify-center gap-2.5 py-8 text-nb-gray-500 text-sm"><Spinner /> Loading resources…</div>
        ) : !resources.length ? (
          <div className="rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 px-4 py-6 text-center text-sm text-nb-gray-500">
            This network has no resources with an address.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <Field label="Resources" hint="Already-blocked addresses are shown but can't be selected again.">{null}</Field>
              <div className="flex items-center gap-3 shrink-0">
                {initialSet.size > 0 && netId === initialNetworkId && (
                  <button type="button" className="text-[0.78rem] text-nb-gray-500 hover:text-nb-gray-700 dark:hover:text-nb-gray-300 hover:underline"
                    onClick={() => setOnlyPicked((v) => !v)}>
                    {onlyPicked ? `Show All Resources (${resources.length})` : `Show Picked Only (${initialSet.size})`}
                  </button>
                )}
                <button type="button" className="text-[0.78rem] text-netbird hover:underline"
                  onClick={() => setSelected((prev) => {
                    const n = new Set(prev);
                    for (const r of visSelectable) { const a = r.address!.trim(); if (allOn) n.delete(a); else n.add(a); }
                    return n;
                  })}>
                  {allOn ? `Clear ${resQ.trim() || onlyPicked ? 'Shown' : 'Selection'}` : `Select All (${visSelectable.length})`}
                </button>
              </div>
            </div>
            <SearchInput value={resQ} onChange={setResQ} placeholder="Search by address or name…" className="w-full max-w-none" kbd={false} />
            {!visible.length ? (
              <div className="rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 px-4 py-5 text-center text-sm text-nb-gray-500">
                No resources match "{resQ.trim()}".
              </div>
            ) : (
            <div className="nb-scroll rounded-md border border-nb-gray-200 dark:border-nb-gray-800 divide-y divide-nb-gray-100 dark:divide-nb-gray-900 max-h-[36vh] overflow-y-auto">
              {visible.map((r) => {
                const addr = r.address!.trim();
                const already = blockedBy.get(r.id);
                const on = selected.has(addr) && !already;
                return (
                  <label key={r.id} className={cnRow(!!already, on)}>
                    <Checkbox checked={on} onChange={() => !already && toggle(addr)} disabled={!!already} />
                    <span className="font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-200 min-w-0 truncate">{addr}</span>
                    <span className="text-[0.8rem] text-nb-gray-500 min-w-0 truncate flex-1">{r.name || '-'}</span>
                    {r.enabled === false && <Badge tone="gray">Disabled</Badge>}
                    {already && <span title={`Matches "${already}"`}><Badge tone="orange">Already Blocked</Badge></span>}
                  </label>
                );
              })}
            </div>
            )}
          </div>
        ))}

        <Field label="Apply To" hint="Where the new blocklist entries apply. Default is every network, not just the one you picked from.">
          <SelectMenu value={scope} searchable={false}
            onChange={(v) => { setScope(v); if (v !== 'all' && !nets.length && netId) setNets([netId]); }}
            options={[
              { value: 'all', label: 'All networks' },
              { value: 'only', label: 'Only selected networks' },
              { value: 'except', label: 'All networks except selected' },
            ]} />
        </Field>
        {scope !== 'all' && (
          <Field label={scope === 'except' ? 'Allowed Networks (Exceptions)' : 'Networks'} hint={scope === 'except' ? 'The block applies everywhere except these networks.' : 'The block applies only to these networks.'}>
            <GroupMultiSelect groups={netOptions} value={nets} onChange={setNets} placeholder="Select network(s)…" />
          </Field>
        )}
        <Field label="Existing Resources" hint="What to do with resources that already exist and match. Applied only when you run “Enforce on existing”.">
          <SelectMenu value={enforce} onChange={(v) => setEnforce(v as BlocklistEnforce)} searchable={false}
            options={[
              { value: 'none', label: 'Block new only - don’t touch existing' },
              { value: 'disable', label: 'Disable existing (reversible)' },
              { value: 'delete', label: 'Delete existing (permanent)' },
            ]} />
        </Field>
        <Field label="Note (Optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why are these blocked? (shared by all entries)" /></Field>
        {enforce !== 'none' && (
          <FieldHint>
            <span className={enforce === 'delete' ? 'text-red-500' : 'text-amber-500'}>
              {enforce === 'delete' ? 'Deleting removes matching resources from NetBird permanently - including the ones you just picked.' : 'Disabling will also affect the resources you just picked, once you run Enforce on existing.'}
            </span>
          </FieldHint>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

// Row classes for the resource picker (kept out of JSX for readability).
function cnRow(disabled: boolean, on: boolean) {
  return [
    'flex items-center gap-3 px-3 py-2',
    disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40',
    on ? 'bg-netbird/5' : '',
  ].join(' ');
}

/** Scan existing resources for blocklist matches, let the admin pick, then disable/delete them. */
function EnforceModal({ onClose }: { onClose: () => void }) {
  const scan = useScanBlockedResources();
  const enforce = useEnforceBlocklist();
  const confirm = useConfirm();
  const networks = useNetworks().data || [];
  const [data, setData] = useState<BlockedMatchesResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<EnforceBlocklistResult | null>(null);
  const [error, setError] = useState('');

  const runScan = async () => {
    setError(''); setResult(null);
    try {
      const r = await scan.mutateAsync();
      setData(r);
      setSelected(new Set(r.matches.map((m) => m.resourceId)));
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { runScan(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const netName = useMemo(() => {
    const m = new Map(networks.map((n) => [n.id, n.name || n.id]));
    return (id: string) => m.get(id) || id;
  }, [networks]);

  const matches = data?.matches || [];
  const grouped = useMemo(() => {
    const g = new Map<string, BlockedResourceMatch[]>();
    for (const m of matches) { const k = m.networkId; if (!g.has(k)) g.set(k, []); g.get(k)!.push(m); }
    return [...g.entries()];
  }, [matches]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const chosen = matches.filter((m) => selected.has(m.resourceId));
  const delCount = chosen.filter((m) => m.action === 'delete').length;
  const disCount = chosen.filter((m) => m.action === 'disable' && m.enabled).length;

  const apply = async () => {
    if (!chosen.length) return;
    const ok = await confirm({
      title: 'Enforce blocklist on existing resources?',
      message: `${disCount} resource(s) will be disabled and ${delCount} permanently deleted from NetBird.${delCount ? ' Deletion cannot be undone.' : ''}`,
      confirmText: delCount ? 'Disable & delete' : 'Disable',
    });
    if (!ok) return;
    setError('');
    try { setResult(await enforce.mutateAsync(chosen.map((m) => m.resourceId))); }
    catch (e) { setError((e as Error).message); }
  };

  const scanning = scan.isPending && !data;

  return (
    <Modal
      open
      onClose={onClose}
      icon={<ShieldAlert size={18} />}
      title="Enforce Blocklist On Existing Resources"
      subtitle="Find resources that already match a blocked address and disable or delete them."
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
          {!result && !!matches.length && (
            <Button variant="danger" size="sm" onClick={apply} disabled={!chosen.length || enforce.isPending}>
              {enforce.isPending ? 'Applying…' : `Apply to ${chosen.length}`}
            </Button>
          )}
        </>
      }
    >
      {scanning ? (
        <div className="flex items-center justify-center gap-2.5 py-12 text-nb-gray-500 text-sm"><Spinner /> Scanning existing resources…</div>
      ) : error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</div>
      ) : result ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3">
            <CheckCircle2 size={20} className="text-green-500 shrink-0" />
            <div className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
              <div className="font-semibold text-nb-gray-800 dark:text-nb-gray-100">Done</div>
              {result.deleted} deleted · {result.disabled} disabled
              {result.skipped ? ` · ${result.skipped} already disabled` : ''}
              {result.failed ? <span className="text-red-500"> · {result.failed} failed</span> : ''}
            </div>
          </div>
          {!!result.errors?.length && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-[0.8rem] text-red-500">
              {result.errors.map((e, i) => <div key={i} className="font-mono">{e.resourceId}: {e.error}</div>)}
            </div>
          )}
        </div>
      ) : !matches.length ? (
        <EmptyState
          title={data && data.entries === 0 ? 'No enforcing entries' : 'Nothing to enforce'}
          hint={data && data.entries === 0
            ? 'No blocklist entry is set to Disable/Delete existing. Edit an entry and set “Existing resources” first.'
            : 'No existing resources match a blocklist entry set to disable or delete.'}
          icon={<CheckCircle2 size={22} />}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-300">
            <AlertTriangle size={15} className="text-amber-500 shrink-0" />
            <span><b>{matches.length}</b> existing resource(s) match a blocked address across <b>{grouped.length}</b> network(s). Review and uncheck any you want to keep.</span>
          </div>
          <div className="nb-scroll rounded-md border border-nb-gray-200 dark:border-nb-gray-800 divide-y divide-nb-gray-100 dark:divide-nb-gray-900 max-h-[46vh] overflow-y-auto">
            {grouped.map(([nid, rows]) => (
              <div key={nid}>
                <div className="px-3 py-1.5 text-[0.72rem] uppercase tracking-wide text-nb-gray-400 bg-nb-gray-50 dark:bg-nb-gray-930 sticky top-0">{netName(nid)}</div>
                {rows.map((m) => (
                  <label key={m.resourceId} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40">
                    <input type="checkbox" checked={selected.has(m.resourceId)} onChange={() => toggle(m.resourceId)} className="accent-netbird" />
                    <span className="font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-200 min-w-0 truncate">{m.address}</span>
                    <span className="text-[0.8rem] text-nb-gray-500 min-w-0 truncate flex-1">{m.resourceName}</span>
                    {m.action === 'disable' && !m.enabled && <Badge tone="gray">Already Off</Badge>}
                    <Badge tone={m.action === 'delete' ? 'red' : 'orange'}>{m.action === 'delete' ? 'Delete' : 'Disable'}</Badge>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <div className="text-[0.8rem] text-nb-gray-500">
            Selected: <b>{disCount}</b> to disable · <b className={delCount ? 'text-red-500' : ''}>{delCount}</b> to delete.
          </div>
        </div>
      )}
    </Modal>
  );
}
