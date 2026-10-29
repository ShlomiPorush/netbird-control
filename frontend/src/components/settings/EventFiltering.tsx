import { useState } from 'react';
import { Plus, Pencil, Trash2, Filter as FilterIcon, Rows3, Building2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useFilterRules, useMspStatus } from '@/lib/queries';
import { useSaveFilterRule, useDeleteFilterRule, useSetBuiltinNoise, useScanMatchingEvents, usePurgeMatchingEvents, usePropagateFilterRules } from '@/lib/mutations';
import { getTenantMode } from '@/lib/api';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useViewer } from '@/contexts/ViewerContext';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { formatTimestamp } from '@/lib/logfmt';
import type { FilterRule, FilterRuleInput, MatchingEventsResult } from '@/lib/types';
import {
  Badge, Button, IconButton, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td, Pagination,
  Modal, Field, Input, SelectMenu,
} from '@/components/ui';

const FIELD_LABELS: Record<string, string> = {
  any_addr: 'Source or Destination address',
  source_addr: 'Source address',
  destination_addr: 'Destination address',
  source_name: 'Source name',
  destination_name: 'Destination name',
  protocol: 'Protocol',
  direction: 'Direction',
  port: 'Destination port',
};
const OP_LABELS: Record<string, string> = {
  contains: 'contains', equals: 'equals', starts_with: 'starts with', ends_with: 'ends with', regex: 'matches regex',
};
const PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmpv6', 'gre', 'esp'];
const DIRECTIONS = ['ingress', 'egress'];

export function EventFiltering() {
  const { data, isLoading } = useFilterRules();
  const del = useDeleteFilterRule();
  const setBuiltin = useSetBuiltinNoise();
  const confirm = useConfirm();
  const { viewer } = useViewer();
  const [modal, setModal] = useState<{ rule: FilterRule | null } | null>(null);

  // MSP admin only, and never while managing a tenant: push this main config to every tenant.
  const propagate = usePropagateFilterRules();
  const canPropagate = useMspStatus().data?.available === true && !getTenantMode();
  const onPropagate = async () => {
    const ok = await confirm({
      title: 'Apply To All Tenants',
      message: "This REPLACES every tenant's event-filtering rules and their built-in noise toggle with this main account's current configuration. Each tenant's existing rules are removed first. Continue?",
      confirmText: 'Apply To All Tenants',
    });
    if (!ok) return;
    try {
      const r = await propagate.mutateAsync();
      await confirm({ title: 'Applied', message: `Applied to ${r.tenants} tenant(s) - ${r.rules} rule(s) each.${r.errors ? ` ${r.errors} tenant(s) failed.` : ''}`, confirmText: 'OK', danger: false });
    } catch (err) { await confirm({ title: 'Failed to Save', message: (err as Error).message, confirmText: 'OK' }); }
  };

  const rules = data?.rules || [];
  const fields = data?.fields || Object.keys(FIELD_LABELS);
  const operators = data?.operators || Object.keys(OP_LABELS);
  const { sorted, state } = useTableSort(rules, {
    field: (r) => FIELD_LABELS[r.field] || r.field,
    enabled: (r) => (r.enabled ? 1 : 0),
  });
  // Client pagination so long rule lists stay manageable (default 25, like every list page).
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);

  const onDelete = async (r: FilterRule) => {
    const ok = await confirm({ title: 'Delete rule', message: 'Delete this filter rule? Future matching events will be stored again.', confirmText: 'Delete' });
    if (ok) await del.mutateAsync(r.id);
  };

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <p className="text-nb-gray-500 text-sm">Discard noisy webhook traffic events before they're stored. Matching events are dropped; everything else is kept.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canPropagate && (
            <Button variant="secondary" onClick={onPropagate} disabled={propagate.isPending} title="Replace every tenant's event-filtering config with this one">
              <Building2 size={15} /> Apply To All Tenants
            </Button>
          )}
          <Button variant="primary" onClick={() => setModal({ rule: null })}><Plus size={15} /> Add rule</Button>
        </div>
      </div>

      {/* Built-in noise toggle */}
      <label className="flex items-center gap-3 mb-6 p-3.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/30 cursor-pointer">
        <input
          type="checkbox"
          className="h-4 w-4 accent-netbird"
          checked={data?.builtinNoise ?? true}
          onChange={async (e) => {
            try { await setBuiltin.mutateAsync(e.target.checked); }
            catch (err) { await confirm({ title: 'Failed to Save', message: (err as Error).message, confirmText: 'OK' }); }
          }}
        />
        <span className="text-sm">
          <span className="font-medium text-nb-gray-800 dark:text-nb-gray-100">Discard broadcast &amp; multicast noise</span>
          <span className="block text-nb-gray-500 text-[0.8rem]">Built-in filter for 255.255.255.255, subnet broadcasts, 224–239.x multicast and IPv6 ff00::/8 multicast (e.g. ff02::1/ff02::2 NDP).</span>
        </span>
      </label>

      {isLoading ? <LoadingState /> : !rules.length ? (
        <EmptyState title="No Filter Rules" hint="All traffic events are stored (except the built-in noise filter above)." icon={<FilterIcon size={22} />} />
      ) : (
        <>
          {/* Rows-per-page control, consistent with the other list pages. */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
          </div>
        <Table>
          <THead>
            <SortTh label="Discard Events Where" sortKey="field" state={state} />
            <SortTh label="Enabled" sortKey="enabled" state={state} />
            <Th className="text-right">{''}</Th>
          </THead>
          <TBody>
            {pageRows.map((r) => (
              <Tr key={r.id} onClick={() => setModal({ rule: r })}>
                <Td>
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <Badge tone="gray">{FIELD_LABELS[r.field] || r.field}</Badge>
                    <span className="text-nb-gray-500">{OP_LABELS[r.operator] || r.operator}</span>
                    <Badge tone="orange"><span className="font-mono">{r.value}</span></Badge>
                  </div>
                </Td>
                <Td onClick={(e) => e.stopPropagation()}>
                  <RuleToggle rule={r} />
                </Td>
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex items-center gap-1.5">
                    <IconButton onClick={() => setModal({ rule: r })} title="Edit"><Pencil size={15} /></IconButton>
                    <IconButton onClick={() => onDelete(r)} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="rules" />
        </>
      )}

      {viewer.canPurge && <PurgeMatching />}

      {modal && <FilterRuleModal rule={modal.rule} fields={fields} operators={operators} onClose={() => setModal(null)} />}
    </div>
  );
}

// Find + delete events ALREADY in the DB that match the filters above (garbage ingested
// before a rule existed). Shown only to EVENT_PURGE_ADMINS (gated by viewer.canPurge).
function PurgeMatching() {
  const scan = useScanMatchingEvents();
  const purge = usePurgeMatchingEvents();
  const confirm = useConfirm();
  const [result, setResult] = useState<MatchingEventsResult | null>(null);
  const [done, setDone] = useState('');

  const runScan = async () => {
    setDone('');
    try { setResult(await scan.mutateAsync()); } catch { setResult(null); }
  };
  const runPurge = async () => {
    if (!result?.total) return;
    const ok = await confirm({
      title: 'Delete matching events',
      message: `Permanently delete ${result.total} stored event(s) that match the current filters? This cannot be undone.`,
      confirmText: `Delete ${result.total}`,
    });
    if (!ok) return;
    try {
      const r = await purge.mutateAsync();
      setDone(`Deleted ${r.deleted} event(s).`);
      setResult(null);
    } catch { /* surfaced below */ }
  };

  return (
    <div className="mt-8 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-4">
      <h3 className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Clean Up Already-Stored Garbage</h3>
      <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3 max-w-2xl">
        Scan the events already in the database for rows that <span className="font-medium">match the filters above</span> (e.g. ingested before a rule existed, or while a toggle was off), preview them, then delete. Restricted to the configured purge admins.
      </p>
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="secondary" onClick={runScan} disabled={scan.isPending}>{scan.isPending ? 'Scanning…' : 'Scan for matching events'}</Button>
        {result && (
          <span className="text-sm text-nb-gray-600 dark:text-nb-gray-300">
            Found <span className="font-semibold text-nb-gray-900 dark:text-nb-gray-100">{result.total}</span> matching <span className="text-nb-gray-400">(scanned {result.scanned})</span>.
          </span>
        )}
        {done && <span className="text-sm text-green-600 dark:text-green-500">{done}</span>}
        {(scan.isError || purge.isError) && <span className="text-sm text-red-500">Something went wrong.</span>}
      </div>

      {result && result.total > 0 && (
        <>
          <div className="mt-4 w-full overflow-x-auto">
            <table className="w-full border-y border-nb-gray-200 dark:border-nb-gray-900 min-w-[680px]">
              <thead>
                <tr className="text-left text-[0.66rem] uppercase tracking-wide text-nb-gray-500 dark:text-nb-gray-400 bg-nb-gray-100/60 dark:bg-nb-gray-930/40">
                  <th className="h-10 px-3 font-medium">Time</th>
                  <th className="px-3 font-medium">Source</th>
                  <th className="px-3 font-medium">Destination</th>
                  <th className="px-3 font-medium">Event</th>
                </tr>
              </thead>
              <tbody>
                {result.sample.map((e) => (
                  <tr key={e.id} className="border-t border-nb-gray-100 dark:border-nb-gray-900">
                    <td className="px-3 py-2 text-[0.76rem] text-nb-gray-500 whitespace-nowrap">{formatTimestamp(e.timestamp)}</td>
                    <td className="px-3 py-2"><span className="font-mono text-[0.76rem] text-nb-gray-600 dark:text-nb-gray-300 break-all">{e.source_addr || e.source_name || '-'}</span></td>
                    <td className="px-3 py-2"><span className="font-mono text-[0.76rem] text-nb-gray-600 dark:text-nb-gray-300 break-all">{e.destination_addr || e.destination_name || '-'}</span></td>
                    <td className="px-3 py-2 text-[0.76rem] text-nb-gray-500 truncate max-w-[220px]">{e.message || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.total > result.sample.length && <p className="text-[0.76rem] text-nb-gray-500 mt-2">Showing the first {result.sample.length} of {result.total}.</p>}
          <div className="mt-3">
            <Button variant="danger" onClick={runPurge} disabled={purge.isPending}>
              <Trash2 size={14} /> {purge.isPending ? 'Deleting…' : `Delete ${result.total} matching event${result.total === 1 ? '' : 's'}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function RuleToggle({ rule }: { rule: FilterRule }) {
  const save = useSaveFilterRule();
  const confirm = useConfirm();
  return (
    <button
      onClick={async () => {
        try { await save.mutateAsync({ id: rule.id, payload: { field: rule.field, operator: rule.operator, value: rule.value, enabled: !rule.enabled } }); }
        catch (err) { await confirm({ title: 'Failed to Save', message: (err as Error).message, confirmText: 'OK' }); }
      }}
      className={cn('relative inline-flex h-5 w-9 items-center rounded-full transition-colors', rule.enabled ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700')}
      title={rule.enabled ? 'Enabled' : 'Disabled'}
    >
      <span className={cn('inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform', rule.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]')} />
    </button>
  );
}

function FilterRuleModal({ rule, fields, operators, onClose }: {
  rule: FilterRule | null; fields: string[]; operators: string[]; onClose: () => void;
}) {
  const save = useSaveFilterRule();
  const [field, setField] = useState(rule?.field || fields[0] || 'any_addr');
  const [operator, setOperator] = useState(rule?.operator || 'contains');
  const [value, setValue] = useState(rule?.value || '');
  const [error, setError] = useState('');

  const isProtocol = field === 'protocol';
  const isDirection = field === 'direction';

  const onFieldChange = (f: string) => {
    setField(f);
    if (f === 'protocol') { setOperator('equals'); setValue((v) => (PROTOCOLS.includes(v) ? v : 'tcp')); }
    else if (f === 'direction') { setOperator('equals'); setValue((v) => (DIRECTIONS.includes(v) ? v : 'egress')); }
  };

  const submit = async () => {
    if (operator !== 'regex' && !value.trim()) { setError('Value is required.'); return; }
    setError('');
    const payload: FilterRuleInput = { field, operator, value: value.trim(), enabled: rule?.enabled ?? true };
    try {
      await save.mutateAsync({ id: rule?.id, payload });
      onClose();
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<FilterIcon size={18} />}
      title={rule ? 'Edit Filter Rule' : 'Add Filter Rule'}
      subtitle="Traffic events matching this rule are discarded."
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending}>{save.isPending ? '…' : 'Save'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Field">
          <SelectMenu value={field} onChange={(v) => onFieldChange(v)}
            options={fields.map((f) => ({ value: f, label: FIELD_LABELS[f] || f }))} />
        </Field>
        {!isProtocol && !isDirection && (
          <Field label="Operator">
            <SelectMenu value={operator} onChange={(v) => setOperator(v)} searchable={false}
              options={operators.map((o) => ({ value: o, label: OP_LABELS[o] || o }))} />
          </Field>
        )}
        <Field label="Value" hint={operator === 'regex' ? 'A case-insensitive regular expression.' : undefined}>
          {isProtocol ? (
            <SelectMenu value={value} onChange={(v) => setValue(v)} searchable={false}
              options={PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() }))} />
          ) : isDirection ? (
            <SelectMenu value={value} onChange={(v) => setValue(v)} searchable={false}
              options={DIRECTIONS.map((d) => ({ value: d, label: d }))} />
          ) : (
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 100.64.0.10" />
          )}
        </Field>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
