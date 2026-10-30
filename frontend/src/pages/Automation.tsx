import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Pencil, Trash2, Workflow, RefreshCw, FlaskConical, Stethoscope, Wrench,
  CheckCircle2, XCircle, AlertTriangle, CircleDashed, Lightbulb, Boxes, ScrollText, PlugZap, Ban, Download, Rows3,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAutomations, useNetworks, useAccessProfiles, useAutomationRuns, useAutomationManaged } from '@/lib/queries';
import { useSaveAutomation, useDeleteAutomation, useRunAutomation, useTestAutomation, useRepairAutomation, useForgetAutomation, useDryRunAutomation } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import type { Automation, AutomationInput, AutomationTestResult, AutomationRun, DryRunResult } from '@/lib/types';
import {
  Badge, Button, IconButton, EmptyState, LoadingState, Spinner, Table, THead, Th, SortTh, TBody, Tr, Td,
  Modal, Tabs, Field, FieldHint, Input, SelectMenu, Checkbox, GroupMultiSelect, Copyable, HoverCard, SearchInput, Pagination, ClearFiltersButton,
} from '@/components/ui';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { ucLabel } from '@/lib/str';

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '-';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function scheduleLabel(min: number): string {
  if (!min) return 'Manual';
  if (min % 1440 === 0) return `Every ${min / 1440}d`;
  if (min % 60 === 0) return `Every ${min / 60}h`;
  return `Every ${min}m`;
}

function statusTone(s: string): 'gray' | 'green' | 'red' | 'orange' {
  return s === 'ok' ? 'green' : s === 'error' ? 'red' : (s === 'running' || s === 'warning') ? 'orange' : 'gray';
}

export default function Automation() {
  const { data, isLoading } = useAutomations();
  const networks = useNetworks().data || [];
  const del = useDeleteAutomation();
  const run = useRunAutomation();
  const confirm = useConfirm();
  const [modal, setModal] = useState<{ automation: Automation | null } | null>(null);
  const [runMsg, setRunMsg] = useState<{ id: number; text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
  const [diag, setDiag] = useState<Automation | null>(null);
  const dry = useDryRunAutomation();
  const [dryRun, setDryRun] = useState<{ a: Automation; result: DryRunResult } | null>(null);
  const [search, setSearch] = useState('');
  const list = data || [];

  const netName = useMemo(() => {
    const m = new Map(networks.map((n) => [n.id, n.name || n.id]));
    return (id: string) => m.get(id) || id || '-';
  }, [networks]);

  // Standard table chrome (same as every list page): search + sort + client pagination.
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return list;
    return list.filter((a) =>
      (a.name || '').toLowerCase().includes(q) || netName(a.networkId).toLowerCase().includes(q));
  }, [list, search, netName]);
  const { sorted, state } = useTableSort(filtered, {
    name: (a) => a.name || '',
    network: (a) => netName(a.networkId),
    schedule: (a) => a.intervalMinutes || 0,
    lastRun: (a) => a.lastRunAt || '',
    status: (a) => `${a.enabled ? 'a' : 'b'}:${a.lastStatus || ''}`,
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25, [search]);

  const onDelete = async (a: Automation) => {
    const ok = await confirm({
      title: 'Delete automation',
      message: `Delete “${a.name}”? Resources it already created stay in NetBird, but will no longer be synced.`,
      confirmText: 'Delete',
    });
    if (ok) await del.mutateAsync(a.id);
  };

  const onRun = async (a: Automation) => {
    setRunMsg(null);
    try {
      const r = await run.mutateAsync(a.id);
      if (r.status === 'error') {
        setRunMsg({ id: a.id, text: `Error: ${r.error}`, tone: 'err' });
        return;
      }
      const counts = `Created ${r.created ?? 0}, adopted ${r.adopted ?? 0}, updated ${r.updated ?? 0}, disabled ${r.disabled ?? 0}, conflicts ${r.conflicts ?? 0}, blocked ${r.blocked ?? 0}, failed ${r.failed ?? 0}`
        + ((r.profiled ?? 0) > 0 ? `, profiled ${r.profiled}` : '');
      const warn = r.status === 'warning' && r.error;
      setRunMsg({ id: a.id, text: warn ? `${counts} - ${r.error}` : counts, tone: warn || r.failed ? 'warn' : 'ok' });
    } catch (e) {
      setRunMsg({ id: a.id, text: (e as Error).message, tone: 'err' });
    }
  };

  const onDryRun = async (a: Automation) => {
    setRunMsg(null);
    try {
      const result = await dry.mutateAsync(a.id);
      setDryRun({ a, result });
    } catch (e) {
      setRunMsg({ id: a.id, text: `Dry run failed: ${(e as Error).message}`, tone: 'err' });
    }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
        <p className="text-nb-gray-500 text-sm max-w-2xl">
          Connect an external HTTP API that returns IP addresses and auto-provision NetBird resources from it - on
          a schedule or on demand.
        </p>
        <Button variant="primary" onClick={() => setModal({ automation: null })} className="self-start sm:shrink-0" title="Add integration">
          <Plus size={15} /> Add integration
        </Button>
      </div>

      {isLoading ? <LoadingState /> : !list.length ? (
        <EmptyState title="No Integrations" hint="Add an integration to start auto-provisioning resources from an external source." icon={<Workflow size={22} />} />
      ) : (
        <>
          {/* Standard table chrome: search + rows-per-page, sortable columns, pagination. */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search name or network…" />
            <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
            <ClearFiltersButton active={!!search} onClear={() => setSearch('')} />
          </div>

          {!sorted.length ? (
            <EmptyState title="No Matching Integrations" hint="Try a different search." icon={<Workflow size={22} />} />
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <THead>
                    <SortTh label="Name" sortKey="name" state={state} />
                    <SortTh label="Target Network" sortKey="network" state={state} />
                    <SortTh label="Schedule" sortKey="schedule" state={state} />
                    <SortTh label="Last Run" sortKey="lastRun" state={state} />
                    <SortTh label="Status" sortKey="status" state={state} />
                    <Th className="text-right">{''}</Th>
                  </THead>
                  <TBody>
                    {pageRows.map((a) => (
                      <Tr key={a.id} onClick={() => setModal({ automation: a })}>
                        <Td>
                          <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{a.name}</div>
                          {runMsg?.id === a.id && <div className={cn('text-[0.75rem]', runMsg.tone === 'err' ? 'text-red-500' : runMsg.tone === 'warn' ? 'text-amber-500' : 'text-green-600 dark:text-green-500')}>{runMsg.text}</div>}
                          {(a.lastStatus === 'error' || a.lastStatus === 'warning') && a.lastError && runMsg?.id !== a.id && (
                            <HoverCard width={380}
                              trigger={<div className={cn('text-[0.75rem] truncate max-w-[340px] cursor-help', a.lastStatus === 'error' ? 'text-red-500' : 'text-amber-500')}>{a.lastError}</div>}>
                              <p className="text-[0.82rem] leading-relaxed text-nb-gray-700 dark:text-nb-gray-200 wrap-break-word">{a.lastError}</p>
                            </HoverCard>
                          )}
                        </Td>
                        <Td><span className="text-sm text-nb-gray-600 dark:text-nb-gray-300">{netName(a.networkId)}</span></Td>
                        <Td><Badge tone="gray">{scheduleLabel(a.intervalMinutes)}</Badge></Td>
                        <Td><span className="text-sm text-nb-gray-500" title={a.lastRunAt || ''}>{relTime(a.lastRunAt)}</span></Td>
                        <Td>
                          <div className="flex items-center gap-1.5">
                            <Badge tone={a.enabled ? 'green' : 'gray'}>{a.enabled ? 'Enabled' : 'Disabled'}</Badge>
                            {a.lastStatus && <Badge tone={statusTone(a.lastStatus)}>{ucLabel(a.lastStatus)}</Badge>}
                          </div>
                        </Td>
                        <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex items-center gap-1.5">
                            <IconButton onClick={() => onDryRun(a)} title="Dry run - preview what a sync would do, without changing anything" disabled={dry.isPending}>
                              <FlaskConical size={15} className={dry.isPending && dry.variables === a.id ? 'animate-pulse' : undefined} />
                            </IconButton>
                            <IconButton onClick={() => onRun(a)} title="Sync now" disabled={run.isPending}><RefreshCw size={15} className={run.isPending && run.variables === a.id ? 'animate-spin' : undefined} /></IconButton>
                            <IconButton onClick={() => setDiag(a)} title="Diagnostics & repair"><Stethoscope size={15} /></IconButton>
                            <IconButton onClick={() => setModal({ automation: a })} title="Edit"><Pencil size={15} /></IconButton>
                            <IconButton onClick={() => onDelete(a)} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                          </div>
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>

              {/* Mobile: cards instead of the wide table */}
              <div className="md:hidden flex flex-col gap-2.5">
                {pageRows.map((a) => (
                  <div key={`m-${a.id}`} onClick={() => setModal({ automation: a })}
                    className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{a.name}</div>
                        <div className="text-[0.76rem] text-nb-gray-500 truncate">{netName(a.networkId)}</div>
                      </div>
                      <span className="shrink-0 inline-flex items-center gap-1.5">
                        <Badge tone={a.enabled ? 'green' : 'gray'}>{a.enabled ? 'Enabled' : 'Disabled'}</Badge>
                        {a.lastStatus && <Badge tone={statusTone(a.lastStatus)}>{ucLabel(a.lastStatus)}</Badge>}
                      </span>
                    </div>
                    {(a.lastStatus === 'error' || a.lastStatus === 'warning') && a.lastError && (
                      <div className={cn('mt-1.5 text-[0.75rem] wrap-break-word', a.lastStatus === 'error' ? 'text-red-500' : 'text-amber-500')}>{a.lastError}</div>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-[0.76rem] text-nb-gray-500">
                        <Badge tone="gray">{scheduleLabel(a.intervalMinutes)}</Badge> {relTime(a.lastRunAt)}
                      </span>
                      <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <IconButton onClick={() => onDryRun(a)} title="Dry run"><FlaskConical size={15} /></IconButton>
                        <IconButton onClick={() => onRun(a)} title="Sync now"><RefreshCw size={15} /></IconButton>
                        <IconButton onClick={() => onDelete(a)} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="integrations" />
            </>
          )}
        </>
      )}

      {modal && <IntegrationModal automation={modal.automation} onClose={() => setModal(null)} />}
      {diag && <DiagnosticsModal automation={diag} onClose={() => setDiag(null)} />}
      {dryRun && <DryRunModal automation={dryRun.a} result={dryRun.result} onClose={() => setDryRun(null)} />}
    </div>
  );
}

// ─── Dry-run results: what a sync would do right now - every item, filterable ───
const DRY_ACTION_META: Record<string, { label: string; tone: 'green' | 'red' | 'orange' | 'gray' | 'cyan' }> = {
  create: { label: 'Create', tone: 'green' },
  adopt: { label: 'Adopt', tone: 'cyan' },
  're-enable': { label: 'Re-Enable', tone: 'green' },
  profile: { label: 'Attach Profile', tone: 'cyan' },
  delete: { label: 'Delete', tone: 'red' },
  disable: { label: 'Disable', tone: 'orange' },
  conflict: { label: 'Conflict', tone: 'red' },
  overlap: { label: 'Would Fail', tone: 'red' },
  blocked: { label: 'Blocked', tone: 'orange' },
  skip: { label: 'Skip', tone: 'gray' },
  keep: { label: 'Keep', tone: 'gray' },
  unchanged: { label: 'Unchanged', tone: 'gray' },
};
const DRY_ACTION_ORDER = ['create', 'adopt', 're-enable', 'profile', 'delete', 'disable', 'conflict', 'overlap', 'blocked', 'skip', 'keep', 'unchanged'];

// Export the FULL plan (all columns, all rows - unfiltered) for offline review.
function dryRunCsv(automation: Automation, result: DryRunResult) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Action,Source Key,Name,Address,Description,Current Name,Current Address,Current State,Note'];
  for (const a of result.actions) {
    lines.push([
      DRY_ACTION_META[a.action]?.label || a.action, a.key, a.name, a.address, a.description || '',
      a.current?.name || '', a.current?.address || '',
      a.current ? (a.current.enabled === false ? 'disabled' : 'enabled') : '',
      a.note,
    ].map(esc).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const el = document.createElement('a');
  el.href = URL.createObjectURL(blob);
  el.download = `dry-run-${automation.name.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`;
  el.click();
  URL.revokeObjectURL(el.href);
}

function DryRunModal({ automation, result, onClose }: { automation: Automation; result: DryRunResult; onClose: () => void }) {
  const noChanges = !result.belowFloor && result.actions.every((a) => a.action === 'skip' || a.action === 'keep' || a.action === 'unchanged');
  // Click a summary badge to filter to that action; click again to clear.
  const [filter, setFilter] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const PER_PAGE = 100;
  const rows = useMemo(() => {
    const query = q.toLowerCase().trim();
    const ordered = DRY_ACTION_ORDER.flatMap((k) => result.actions.filter((a) => a.action === k));
    return ordered.filter((a) =>
      (!filter || a.action === filter) &&
      (!query
        || (a.name || '').toLowerCase().includes(query)
        || (a.address || '').toLowerCase().includes(query)
        || (a.key || '').toLowerCase().includes(query)
        || (a.description || '').toLowerCase().includes(query)
        || (a.current?.name || '').toLowerCase().includes(query)
        || (a.note || '').toLowerCase().includes(query)));
  }, [result, filter, q]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  return (
    <Modal open onClose={onClose} size="lg" icon={<FlaskConical size={18} />}
      title="Dry Run"
      subtitle={`${automation.name} - nothing was changed; this is the FULL report of what a sync would do right now.`}
      footer={<>
        <Button variant="secondary" size="sm" onClick={() => dryRunCsv(automation, result)}><Download size={14} /> Export CSV</Button>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      </>}>
      <div className="flex flex-col gap-3">
        <div className="text-sm text-nb-gray-500">
          Source returned <b className="text-nb-gray-700 dark:text-nb-gray-200">{result.itemsFound}</b> item(s),{' '}
          <b className="text-nb-gray-700 dark:text-nb-gray-200">{result.validCount}</b> valid · {result.managed} currently managed
          {result.floor > 0 && <> · safety minimum {result.floor}</>}
        </div>

        {result.belowFloor ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            <AlertTriangle size={14} className="inline mr-1.5 -mt-0.5" />{result.warn}</p>
        ) : (
          <>
            {noChanges && (
              <p className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-sm text-green-600 dark:text-green-500">
                <CheckCircle2 size={14} className="inline mr-1.5 -mt-0.5" />In sync - a run right now would change nothing.
              </p>
            )}
            {/* Summary badges double as filters - click one to see only that action. */}
            <div className="flex flex-wrap items-center gap-1.5">
              {DRY_ACTION_ORDER.filter((k) => result.summary[k]).map((k) => (
                <button key={k} onClick={() => { setFilter(filter === k ? null : k); setPage(1); }}
                  className={cn('rounded-md transition-all', filter === k ? 'ring-2 ring-netbird' : filter ? 'opacity-50' : '')}>
                  <Badge tone={DRY_ACTION_META[k].tone}>{DRY_ACTION_META[k].label}: {result.summary[k]}</Badge>
                </button>
              ))}
              {filter && <button onClick={() => setFilter(null)} className="text-[0.78rem] text-nb-gray-500 hover:underline ml-1">Show all</button>}
            </div>
            <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search name, address, key, description or note…" />
            <div className="nb-scroll max-h-[420px] overflow-y-auto rounded-md border border-nb-gray-200 dark:border-nb-gray-800">
              {pageRows.length === 0 ? (
                <p className="px-3 py-4 text-sm text-nb-gray-500">Nothing matches the current filter.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white dark:bg-nb-gray-950">
                    <tr className="text-left text-[0.7rem] uppercase tracking-wide text-nb-gray-400 border-b border-nb-gray-200 dark:border-nb-gray-800">
                      <th className="py-1.5 px-3 font-medium">Action</th>
                      <th className="py-1.5 px-3 font-medium">Source Item</th>
                      <th className="py-1.5 px-3 font-medium">Current Resource</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((a, i) => (
                      <tr key={`${a.action}-${a.key}-${i}`} className="border-b border-nb-gray-100 dark:border-nb-gray-900/70 last:border-0 align-top">
                        <td className="py-1.5 px-3 w-28"><Badge tone={DRY_ACTION_META[a.action]?.tone || 'gray'}>{DRY_ACTION_META[a.action]?.label || a.action}</Badge></td>
                        <td className="py-1.5 px-3">
                          <span className="text-nb-gray-800 dark:text-nb-gray-100">{a.name || a.key || '-'}</span>
                          {a.address && <span className="ml-2 font-mono text-[0.78rem] text-nb-gray-500">{a.address}</span>}
                          {/* The key is noise when the name already contains it (e.g. "13808 (2523)"). */}
                          {a.key && a.key !== a.name && !(a.name || '').includes(a.key) && <span className="block text-[0.7rem] text-nb-gray-400">key: {a.key}</span>}
                          {a.description && <span className="block text-[0.74rem] text-nb-gray-500 truncate max-w-[300px]" title={a.description}>{a.description}</span>}
                          {a.note && <span className="block text-[0.74rem] text-amber-600/90 dark:text-amber-400/90">{a.note}</span>}
                        </td>
                        <td className="py-1.5 px-3">
                          {a.current ? (
                            <>
                              <span className="inline-flex items-center gap-1.5">
                                {a.current.enabled !== undefined && (
                                  <span className={cn('h-2 w-2 rounded-full shrink-0', a.current.enabled ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')}
                                    title={a.current.enabled ? 'Enabled' : 'Disabled'} />
                                )}
                                <span className="text-nb-gray-700 dark:text-nb-gray-200">{a.current.name || '-'}</span>
                              </span>
                              {a.current.address && a.current.address !== a.address && (
                                <span className="block font-mono text-[0.74rem] text-nb-gray-500 ml-3.5">{a.current.address}</span>
                              )}
                            </>
                          ) : (
                            <span className="text-[0.78rem] italic text-nb-gray-400">{a.action === 'create' ? 'none - will be created' : '-'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[0.78rem] text-nb-gray-500">
                {rows.length} item(s){filter || q ? ` (of ${result.actions.length})` : ''}{result.truncated ? ' · plan capped at 20,000 rows' : ''}
              </p>
              {totalPages > 1 && (
                <span className="inline-flex items-center gap-2 text-[0.78rem] text-nb-gray-500">
                  <button onClick={() => setPage(Math.max(1, safePage - 1))} disabled={safePage <= 1} className="disabled:opacity-40 hover:underline">Prev</button>
                  page {safePage}/{totalPages}
                  <button onClick={() => setPage(Math.min(totalPages, safePage + 1))} disabled={safePage >= totalPages} className="disabled:opacity-40 hover:underline">Next</button>
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

const EMPTY: AutomationInput = {
  name: '', enabled: true, endpointUrl: '', authType: 'none', authHeader: '', secret: '', sourceFormat: 'json', namePrefix: '',
  itemsPath: '', addressField: '', nameField: '', descriptionField: '', keyField: '',
  networkId: '', profileIds: [], intervalMinutes: 60, removalMode: 'disable', minItems: 0,
};

// An Automation → editable input (secret blank: kept on save, falls back to saved for Test).
function toInput(a: Automation): AutomationInput {
  return {
    name: a.name, enabled: a.enabled, endpointUrl: a.endpointUrl, authType: a.authType, authHeader: a.authHeader, secret: '', sourceFormat: a.sourceFormat, namePrefix: a.namePrefix,
    itemsPath: a.itemsPath, addressField: a.addressField, nameField: a.nameField, descriptionField: a.descriptionField, keyField: a.keyField,
    networkId: a.networkId, profileIds: a.profileIds, intervalMinutes: a.intervalMinutes, removalMode: a.removalMode, minItems: a.minItems,
  };
}

// Split an interval-in-minutes into a {value, unit} for the form.
function splitInterval(min: number): { value: number; unit: 'm' | 'h' | 'd' } {
  if (min && min % 1440 === 0) return { value: min / 1440, unit: 'd' };
  if (min && min % 60 === 0) return { value: min / 60, unit: 'h' };
  return { value: min, unit: 'm' };
}
const UNIT_MIN = { m: 1, h: 60, d: 1440 };

function IntegrationModal({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const save = useSaveAutomation();
  const test = useTestAutomation();
  const networks = useNetworks().data || [];
  const sharedProfiles = (useAccessProfiles().data || []).filter((p) => p.shared);

  const init: AutomationInput = automation ? toInput(automation) : EMPTY;
  const [f, setF] = useState<AutomationInput>(init);
  const initInterval = splitInterval(automation?.intervalMinutes ?? 60);
  const [ivValue, setIvValue] = useState(initInterval.value);
  const [ivUnit, setIvUnit] = useState<'m' | 'h' | 'd'>(initInterval.unit);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<AutomationTestResult | null>(null);
  const set = <K extends keyof AutomationInput>(k: K, v: AutomationInput[K]) => setF((p) => ({ ...p, [k]: v }));

  const payload = (): AutomationInput => ({ ...f, intervalMinutes: Math.max(0, Math.round(ivValue)) * UNIT_MIN[ivUnit] });

  const runTest = async () => {
    setError(''); setPreview(null);
    try { setPreview(await test.mutateAsync({ id: automation?.id, payload: payload() })); }
    catch (e) { setError('Test failed: ' + (e as Error).message); }
  };

  const submit = async () => {
    if (!f.name.trim()) { setError('Name is required.'); return; }
    if (!f.endpointUrl.trim()) { setError('Endpoint URL is required.'); return; }
    if (!f.networkId) { setError('Choose a target network.'); return; }
    if (f.sourceFormat !== 'text' && !f.addressField.trim()) { setError('Set the address field.'); return; }
    setError('');
    try { await save.mutateAsync({ id: automation?.id, payload: payload() }); onClose(); }
    catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<Workflow size={18} />}
      title={automation ? 'Edit Integration' : 'Add Integration'}
      subtitle="Poll an external JSON API and provision resources into a network."
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending}>{save.isPending ? '…' : 'Save'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* Connection */}
        <Section title="Connection">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name"><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. CMDB hosts" maxLength={60} /></Field>
            <label className="flex items-center gap-2.5 self-end pb-2.5 cursor-pointer">
              <Checkbox checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200">Enabled (allow scheduled runs)</span>
            </label>
          </div>
          <Field label="Endpoint URL" hint="A GET endpoint returning JSON."><Input value={f.endpointUrl} onChange={(e) => set('endpointUrl', e.target.value)} placeholder="https://api.example.com/hosts" /></Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Auth">
              <SelectMenu value={f.authType} onChange={(v) => set('authType', v)} searchable={false}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'bearer', label: 'Bearer token' },
                  { value: 'header', label: 'Custom header' },
                ]} />
            </Field>
            {f.authType === 'header' && (
              <Field label="Header Name"><Input value={f.authHeader} onChange={(e) => set('authHeader', e.target.value)} placeholder="X-API-Key" /></Field>
            )}
            {f.authType !== 'none' && (
              <Field label="Secret" hint={automation?.hasSecret ? 'Leave blank to keep current.' : undefined}>
                <Input type="password" autoComplete="new-password" value={f.secret || ''} onChange={(e) => set('secret', e.target.value)}
                  placeholder={automation?.hasSecret ? '•••••••• (configured)' : 'token / key'} />
              </Field>
            )}
          </div>
        </Section>

        {/* Response mapping */}
        <Section title="Response Mapping">
          <Field label="Source Format" hint="How the endpoint returns the addresses.">
            <SelectMenu value={f.sourceFormat} onChange={(v) => set('sourceFormat', v)} searchable={false}
              options={[
                { value: 'json', label: 'JSON (array of objects)' },
                { value: 'text', label: 'Text file (one IP per line)' },
              ]} />
          </Field>
          {f.sourceFormat === 'text' ? (
            <>
              <FieldHint>
                Each non-empty line is one address (IP, CIDR or domain). Lines starting with <code className="px-1 rounded-sm bg-nb-gray-100 dark:bg-nb-gray-900">#</code> are ignored.
                Optionally add a name after a space or comma, e.g. <code className="px-1 rounded-sm bg-nb-gray-100 dark:bg-nb-gray-900">10.0.0.5 db1</code>.
              </FieldHint>
              <Field label="Name Prefix (Optional)" hint={`The resource name becomes prefix + address${f.namePrefix ? `, e.g. "${f.namePrefix}10.0.0.5"` : ' (e.g. "Client-10.0.0.5")'}.`}>
                <Input value={f.namePrefix} onChange={(e) => set('namePrefix', e.target.value)} placeholder="e.g. Client-" maxLength={40} />
              </Field>
            </>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Items Path" hint="Dot-path to the array; blank = response is the array."><Input value={f.itemsPath} onChange={(e) => set('itemsPath', e.target.value)} placeholder="e.g. data.results" /></Field>
              <Field label="Address Field *" hint="IP / CIDR / domain."><Input value={f.addressField} onChange={(e) => set('addressField', e.target.value)} placeholder="e.g. ip" /></Field>
              <Field label="Name Field" hint="Falls back to the address."><Input value={f.nameField} onChange={(e) => set('nameField', e.target.value)} placeholder="e.g. hostname" /></Field>
              <Field label="Description Field"><Input value={f.descriptionField} onChange={(e) => set('descriptionField', e.target.value)} placeholder="optional" /></Field>
              <Field label="Key Field" hint="Stable id for dedupe; falls back to the address."><Input value={f.keyField} onChange={(e) => set('keyField', e.target.value)} placeholder="e.g. id" /></Field>
            </div>
          )}
          <div>
            <Button variant="secondary" size="sm" onClick={runTest} disabled={test.isPending}><FlaskConical size={14} /> {test.isPending ? 'Testing…' : 'Test'}</Button>
          </div>
          {preview && <TestReport result={preview} />}
        </Section>

        {/* Target */}
        <Section title="Target">
          <Field label="Network">
            <SelectMenu value={f.networkId} onChange={(v) => set('networkId', v)} placeholder="Select network…"
              options={networks.map((n) => ({ value: n.id, label: n.name || n.id }))} />
          </Field>
          <Field label="Access Profiles" hint="Resources this integration creates or adopts join these shared profiles' groups and inherit their policy - reconciled on every sync.">
            {sharedProfiles.length ? (
              <GroupMultiSelect
                groups={sharedProfiles.map((p) => ({ id: String(p.id), name: p.name }))}
                value={f.profileIds.map(String)}
                onChange={(ids) => set('profileIds', ids.map(Number))}
                placeholder="Select profile(s)…"
              />
            ) : <FieldHint>No shared Access Profiles yet - create one in Operations → Access Profiles.</FieldHint>}
          </Field>
        </Section>

        {/* Schedule & removal */}
        <Section title="Schedule & Removal">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Run Every" hint="Set 0 for manual-only.">
              <div className="flex gap-2">
                <Input type="number" min={0} value={ivValue} onChange={(e) => setIvValue(parseInt(e.target.value, 10) || 0)} className="w-24" />
                <SelectMenu value={ivUnit} onChange={(v) => setIvUnit(v as 'm' | 'h' | 'd')} searchable={false}
                  options={[
                    { value: 'm', label: 'Minutes' },
                    { value: 'h', label: 'Hours' },
                    { value: 'd', label: 'Days' },
                  ]} />
              </div>
            </Field>
            <Field label="When A Source Entry Disappears" hint="Applies to managed resources (created or adopted by this integration).">
              <SelectMenu value={f.removalMode} onChange={(v) => set('removalMode', v)} searchable={false}
                options={[
                  { value: 'disable', label: 'Disable the resource' },
                  { value: 'none', label: 'Add & update only (leave it)' },
                  { value: 'delete', label: 'Delete the resource' },
                ]} />
            </Field>
          </div>
          <Field label="Safety: Minimum Items" hint="If the source returns fewer than this many items, skip removing/disabling resources - protects against a broken or empty API wiping the inventory. 0 = only skip when the source returns nothing.">
            <Input type="number" min={0} value={f.minItems} onChange={(e) => set('minItems', parseInt(e.target.value, 10) || 0)} className="w-32" />
          </Field>
        </Section>

        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

// Recent runs for one integration - the friendly "log" for diagnosing failures.
function RunHistory({ id }: { id: number }) {
  const { data, isLoading } = useAutomationRuns(id);
  if (isLoading) return <div className="flex justify-center py-6"><Spinner /></div>;
  const runs = data || [];
  if (!runs.length) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-6 text-center">
        <ScrollText size={22} className="text-nb-gray-400" />
        <div className="text-sm text-nb-gray-500">No runs yet - hit <b>Sync now</b> to make the first one.</div>
      </div>
    );
  }
  return <div className="flex flex-col gap-2">{runs.map((r) => <RunCard key={r.id} r={r} />)}</div>;
}

function RunCard({ r }: { r: AutomationRun }) {
  const dot = r.status === 'ok' ? 'bg-green-500' : r.status === 'error' ? 'bg-red-500' : r.status === 'warning' ? 'bg-amber-500' : 'bg-nb-gray-400';
  const verb = r.trigger === 'manual' ? 'Manual sync' : 'Scheduled sync';
  const chips: { label: string; tone: 'gray' | 'green' | 'red' | 'orange' | 'cyan' }[] = [];
  if (r.created) chips.push({ label: `${r.created} Created`, tone: 'green' });
  if (r.adopted) chips.push({ label: `${r.adopted} Adopted`, tone: 'cyan' });
  if (r.updated) chips.push({ label: `${r.updated} Re-Enabled`, tone: 'green' });
  if (r.disabled) chips.push({ label: `${r.disabled} Disabled`, tone: 'gray' });
  if (r.conflicts) chips.push({ label: `${r.conflicts} Conflicts`, tone: 'orange' });
  if (r.blocked) chips.push({ label: `${r.blocked} Blocked`, tone: 'orange' });
  if (r.skipped) chips.push({ label: `${r.skipped} Skipped`, tone: 'gray' });
  if (r.failed) chips.push({ label: `${r.failed} Failed`, tone: 'red' });
  const noChange = !chips.length;
  return (
    <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3">
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full shrink-0', dot)} />
        <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">{verb}</span>
        {r.status && r.status !== 'ok' && <Badge tone={statusTone(r.status)}>{ucLabel(r.status)}</Badge>}
        <span className="text-xs text-nb-gray-500 ml-auto" title={r.startedAt}>{relTime(r.startedAt)}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {noChange ? <span className="text-[0.78rem] text-nb-gray-500">No changes.</span> : chips.map((c) => <Badge key={c.label} tone={c.tone}>{c.label}</Badge>)}
      </div>
      {(r.errors?.length || r.error) && (
        <div className="mt-2 rounded-sm bg-red-500/5 border border-red-500/20 p-2 text-[0.78rem] text-red-600 dark:text-red-400">
          {r.errors?.length
            ? <ul className="list-disc ml-4 space-y-0.5">{r.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            : <span>{r.error}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Friendly connection/mapping report (shared by the config modal + Diagnostics) ───
const STAGE_ORDER = ['request', 'parse', 'items', 'map'];

function buildSteps(r: AutomationTestResult): { label: string; status: 'ok' | 'fail' | 'warn' | 'skip'; detail?: string }[] {
  const failIdx = r.error ? Math.max(0, STAGE_ORDER.indexOf(r.stage || 'request')) : -1;
  const stat = (i: number): 'ok' | 'fail' | 'skip' => (failIdx === -1 || i < failIdx) ? 'ok' : i === failIdx ? 'fail' : 'skip';
  return [
    { label: 'Reach the endpoint', status: stat(0), detail: typeof r.httpStatus === 'number' ? `HTTP ${r.httpStatus}` : (stat(0) === 'fail' ? r.error : undefined) },
    { label: 'Read the response', status: stat(1), detail: stat(1) === 'fail' ? r.error : undefined },
    { label: 'Find the list of items', status: stat(2), detail: r.itemsFound != null ? `${r.itemsFound} found` : (stat(2) === 'fail' ? r.error : undefined) },
    { label: 'Map IP addresses', status: failIdx === -1 ? ((r.invalid || r.blocked) ? 'warn' : 'ok') : stat(3), detail: failIdx === -1 ? `${r.valid} valid${r.invalid ? `, ${r.invalid} invalid` : ''}${r.blocked ? `, ${r.blocked} blocked` : ''}` : (stat(3) === 'fail' ? r.error : undefined) },
  ];
}

const STEP_ICON = {
  ok: <CheckCircle2 size={16} className="text-green-500" />,
  fail: <XCircle size={16} className="text-red-500" />,
  warn: <AlertTriangle size={16} className="text-amber-500" />,
  skip: <CircleDashed size={16} className="text-nb-gray-400" />,
};

function TestReport({ result }: { result: AutomationTestResult }) {
  const steps = buildSteps(result);
  const syncable = (result.valid ?? 0) - (result.blocked ?? 0);
  const readySub = `${syncable} address(es) ready to sync${result.blocked ? ` · ${result.blocked} blocked` : ''}`;
  const banner = result.error
    ? { tone: 'red' as const, title: "Couldn't read the source", sub: result.error }
    : (result.invalid || result.blocked || result.duplicates?.keys)
      ? { tone: 'amber' as const, title: 'Connected - a few things need attention', sub: readySub }
      : { tone: 'green' as const, title: 'All good!', sub: readySub };
  const bannerCls = banner.tone === 'red' ? 'border-red-500/30 bg-red-500/5' : banner.tone === 'amber' ? 'border-amber-500/30 bg-amber-500/5' : 'border-green-500/30 bg-green-500/5';
  const bannerIcon = banner.tone === 'red' ? <XCircle size={20} className="text-red-500" /> : banner.tone === 'amber' ? <AlertTriangle size={20} className="text-amber-500" /> : <CheckCircle2 size={20} className="text-green-500" />;
  // Suggest likely address fields when the mapping is off.
  const needsHelp = !!result.error || result.valid === 0 || !!result.invalid;
  const suggestions = needsHelp ? (result.availableFields || []).filter((f) => /ip|addr|host/i.test(f)).slice(0, 4) : [];

  return (
    <div className="flex flex-col gap-3">
      <div className={cn('flex items-start gap-3 rounded-lg border p-3', bannerCls)}>
        {bannerIcon}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">{banner.title}</div>
          <div className="text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-400 wrap-break-word">{banner.sub}</div>
        </div>
      </div>

      <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 divide-y divide-nb-gray-100 dark:divide-nb-gray-900">
        {steps.map((s) => (
          <div key={s.label} className="flex items-center gap-2.5 px-3 py-2">
            {STEP_ICON[s.status]}
            <span className={cn('text-sm', s.status === 'fail' ? 'text-nb-gray-800 dark:text-nb-gray-100 font-medium' : s.status === 'skip' ? 'text-nb-gray-400' : 'text-nb-gray-700 dark:text-nb-gray-200')}>{s.label}</span>
            {s.detail && <span className="text-[0.78rem] text-nb-gray-500 ml-auto text-right">{s.detail}</span>}
          </div>
        ))}
      </div>

      {!!result.availableFields?.length && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[0.72rem] text-nb-gray-500">Fields in the source:</span>
          {result.availableFields.map((f) => <code key={f} className="text-[0.72rem] px-1.5 py-0.5 rounded-sm bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-600 dark:text-nb-gray-300">{f}</code>)}
        </div>
      )}

      {!!suggestions.length && (
        <Tip tone="amber"><b>Tip:</b> the Address field looks off. Try mapping it to {suggestions.map((f, i) => <span key={f}><code className="px-1 rounded-sm bg-amber-500/10 text-amber-700 dark:text-amber-400">{f}</code>{i < suggestions.length - 1 ? ' or ' : ''}</span>)}.</Tip>
      )}

      {!!result.preview?.length && (
        <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 overflow-hidden">
          <div className="px-3 py-1.5 text-[0.72rem] uppercase tracking-wide text-nb-gray-400 bg-nb-gray-50 dark:bg-nb-gray-930 border-b border-nb-gray-100 dark:border-nb-gray-900">Preview - first {result.preview.length}</div>
          <table className="w-full text-[0.78rem]">
            <tbody>
              {result.preview.map((p, i) => (
                <tr key={i} className={cn('border-t border-nb-gray-100 dark:border-nb-gray-900', !p.valid ? 'bg-red-500/4' : p.blocked && 'bg-amber-500/5')}>
                  <td className="px-3 py-1.5 w-5">{!p.valid ? <AlertTriangle size={13} className="text-red-500" /> : p.blocked ? <Ban size={13} className="text-amber-500" /> : <CheckCircle2 size={13} className="text-green-500" />}</td>
                  <td className="px-2 py-1.5 font-mono">
                    {!p.valid
                      ? <span className="text-red-500" title={p.reason}>{p.address || '(empty)'} <span className="text-[0.7rem]">({p.reason})</span></span>
                      : p.blocked
                        ? <span className="text-amber-600 dark:text-amber-400" title={`On the blocklist${p.blockedBy ? `: ${p.blockedBy}` : ''} - the sync will skip it`}>{p.address} <span className="text-[0.7rem]">(blocked{p.blockedBy ? `: ${p.blockedBy}` : ''})</span></span>
                        : <Copyable value={p.address}><span className="text-nb-gray-700 dark:text-nb-gray-200">{p.address || '-'}</span></Copyable>}
                  </td>
                  <td className="px-2 py-1.5 text-nb-gray-600 dark:text-nb-gray-300 truncate max-w-[160px]">{p.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!!result.blocked && <Tip tone="amber"><b>{result.blocked} address(es) are on the blocklist</b> for this network - the sync will skip them (they won't be created). Remove them from <b>Operations → Blocklist</b> if they should sync.</Tip>}
      {!!result.duplicates?.keys && <Tip tone="amber"><b>Heads up:</b> {result.duplicates.keys} duplicate key value(s). Pick a Key field that's unique per item, or resources may churn (disable + recreate) each sync.</Tip>}
      {result.rawSnippet && result.error && (
        <details className="text-[0.78rem]">
          <summary className="cursor-pointer text-nb-gray-500 hover:text-nb-gray-700 dark:hover:text-nb-gray-300">Show raw response</summary>
          <pre className="mt-1.5 max-h-32 overflow-auto rounded-sm bg-nb-gray-100 dark:bg-nb-gray-920 p-2 text-[0.72rem] font-mono whitespace-pre-wrap">{result.rawSnippet}</pre>
        </details>
      )}
    </div>
  );
}

function Tip({ tone = 'blue', children }: { tone?: 'amber' | 'blue'; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-md border p-2.5 text-[0.8rem]', tone === 'amber' ? 'border-amber-500/30 bg-amber-500/5 text-nb-gray-700 dark:text-nb-gray-300' : 'border-nb-blue-400/30 bg-nb-blue-400/5 text-nb-gray-700 dark:text-nb-gray-300')}>
      <Lightbulb size={15} className={tone === 'amber' ? 'text-amber-500 mt-0.5 shrink-0' : 'text-nb-blue-500 mt-0.5 shrink-0'} />
      <div>{children}</div>
    </div>
  );
}

// ─── Diagnostics & repair hub for one integration (tabbed) ───
type DiagTab = 'connection' | 'resources' | 'runs';

function DiagnosticsModal({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const test = useTestAutomation();
  const managed = useAutomationManaged(automation.id);
  const repair = useRepairAutomation();
  const forget = useForgetAutomation();
  const confirm = useConfirm();
  const [tab, setTab] = useState<DiagTab>('connection');
  const [result, setResult] = useState<AutomationTestResult | null>(null);

  const runTest = async () => {
    setResult(null);
    try { setResult(await test.mutateAsync({ id: automation.id, payload: toInput(automation) })); }
    catch (e) { setResult({ error: (e as Error).message, stage: 'request' }); }
  };
  // Auto-run the connection test when opened - instant feedback, no extra click.
  useEffect(() => { runTest(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const rows = managed.data?.resources || [];
  const orphans = rows.filter((r) => r.orphan).length;
  const active = rows.filter((r) => !r.orphan && r.status !== 'disabled').length;
  const disabled = rows.filter((r) => !r.orphan && r.status === 'disabled').length;

  const doForget = async () => {
    const ok = await confirm({
      title: 'Forget all managed state?',
      message: `Stop tracking all ${rows.length} resource(s)? They stay in NetBird unchanged, but this automation will no longer disable them when they leave the source (matching addresses may be re-adopted on the next sync).`,
      confirmText: 'Forget',
    });
    if (ok) await forget.mutateAsync(automation.id);
  };

  return (
    <Modal open onClose={onClose} icon={<Stethoscope size={18} />} title={`Diagnostics - ${automation.name}`}
      subtitle="Check the connection, inspect what's managed, and review the run log." size="lg"
      tabs={
        <Tabs bordered={false} value={tab} onChange={(k) => setTab(k as DiagTab)} items={[
          { key: 'connection', label: <span className="inline-flex items-center gap-2"><PlugZap size={15} /> Connection</span> },
          { key: 'resources', label: <span className="inline-flex items-center gap-2"><Boxes size={15} /> Resources{rows.length ? ` (${rows.length})` : ''}</span> },
          { key: 'runs', label: <span className="inline-flex items-center gap-2"><ScrollText size={15} /> Runs</span> },
        ]} />
      }
      footer={
        <>
          {tab === 'connection' && <Button variant="secondary" size="sm" onClick={runTest} disabled={test.isPending}><RefreshCw size={14} className={test.isPending ? 'animate-spin' : undefined} /> Re-test</Button>}
          <Button variant="primary" size="sm" onClick={onClose}>Done</Button>
        </>
      }>
      {tab === 'connection' && (
        test.isPending && !result
          ? <div className="flex flex-col items-center gap-2 py-10"><Spinner /><span className="text-sm text-nb-gray-500">Checking the source…</span></div>
          : result ? <TestReport result={result} /> : <div className="py-10 text-center text-sm text-nb-gray-500">Click Re-test to check the connection.</div>
      )}

      {tab === 'resources' && (
        <div className="flex flex-col gap-3">
          <p className="text-[0.85rem] text-nb-gray-500 dark:text-nb-gray-400">Resources this integration created or adopted. They’re disabled automatically when they leave the source.</p>
          {managed.isLoading ? <div className="flex justify-center py-8"><Spinner /></div> : !rows.length ? (
            <div className="flex flex-col items-center gap-1.5 py-8 text-center">
              <Boxes size={22} className="text-nb-gray-400" />
              <div className="text-sm text-nb-gray-500">Nothing managed yet - run a sync to create resources.</div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="green">{active} Active</Badge>
                {!!disabled && <Badge tone="gray">{disabled} Disabled</Badge>}
                {!!orphans && <Badge tone="red">{orphans} Orphan{orphans > 1 ? 's' : ''}</Badge>}
                {managed.data && !managed.data.networkKnown && <span className="text-[0.78rem] text-amber-500">Couldn't read the network - orphan status unknown.</span>}
              </div>
              <div className="nb-scroll rounded-md border border-nb-gray-200 dark:border-nb-gray-800 overflow-hidden max-h-64 overflow-y-auto">
                <table className="w-full text-[0.8rem]">
                  <thead className="sticky top-0 bg-nb-gray-50 dark:bg-nb-gray-930">
                    <tr className="text-left text-nb-gray-400 border-b border-nb-gray-100 dark:border-nb-gray-900">
                      <th className="px-3 py-1.5 font-medium">Address</th><th className="px-3 py-1.5 font-medium">Name</th><th className="px-3 py-1.5 font-medium">State</th><th className="px-3 py-1.5 font-medium">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className={cn('border-t border-nb-gray-100 dark:border-nb-gray-900', r.orphan && 'bg-red-500/4')}>
                        <td className="px-3 py-1.5"><Copyable value={r.address}><span className="font-mono text-nb-gray-700 dark:text-nb-gray-200">{r.address}</span></Copyable></td>
                        <td className="px-3 py-1.5 text-nb-gray-600 dark:text-nb-gray-300 truncate max-w-[160px]">{r.name || '-'}</td>
                        <td className="px-3 py-1.5">
                          {r.orphan
                            ? <span className="inline-flex items-center gap-1.5 text-red-500"><AlertTriangle size={13} /> Orphan</span>
                            : <span className="inline-flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-full', r.status === 'disabled' ? 'bg-nb-gray-400' : 'bg-green-500')} />{r.status === 'disabled' ? 'Disabled' : 'Active'}</span>}
                        </td>
                        <td className="px-3 py-1.5 text-nb-gray-500" title={r.lastSeenAt || ''}>{relTime(r.lastSeenAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {orphans > 0 && <Tip tone="amber"><b>{orphans} orphan{orphans > 1 ? 's' : ''}:</b> still tracked here but gone from NetBird (deleted manually). Click <b>Repair</b> to forget them so the next sync re-creates them.</Tip>}
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="secondary" size="sm" onClick={() => repair.mutateAsync(automation.id)} disabled={repair.isPending || !orphans}>
                  <Wrench size={14} /> Repair{orphans ? ` (${orphans})` : ''}
                </Button>
                <Button variant="secondary" size="sm" onClick={doForget} disabled={forget.isPending || !rows.length}>Forget all</Button>
                {repair.data && <span className="text-[0.78rem] text-green-600 dark:text-green-500">Removed {repair.data.removed} orphan(s).</span>}
                {forget.data && <span className="text-[0.78rem] text-green-600 dark:text-green-500">Cleared {forget.data.forgotten}.</span>}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'runs' && <RunHistory id={automation.id} />}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[0.72rem] uppercase tracking-wider text-nb-gray-400 font-medium">{title}</div>
      {children}
    </div>
  );
}
