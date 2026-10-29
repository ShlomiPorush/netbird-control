import { useMemo, useState } from 'react';
import { CalendarClock, Plus, Trash2, X, Rows3 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useRecurringAccess, useUsers } from '@/lib/queries';
import { useSaveRecurring, useDeleteRecurring } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { ToolbarMenu } from '@/components/logs/toolbar';
import type { RecurringAccessRule, RecurringAccessInput, GrantTarget } from '@/lib/types';
import { Badge, Button, IconButton, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td, Modal, Field, Input, Pagination } from '@/components/ui';
import { UserSelect } from '@/components/logs/UserSelect';
import { TargetChips, TARGET_META } from '@/components/access/targets';
import { TargetSearch } from '@/components/access/TargetSearch';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "Sun-Thu" style label for a sorted day set; falls back to a comma list for gaps.
function daysLabel(days: number[]) {
  if (days.length === 7) return 'Every Day';
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous && sorted.length > 2) return `${DAY_LABELS[sorted[0]]}-${DAY_LABELS[sorted[sorted.length - 1]]}`;
  return sorted.map((d) => DAY_LABELS[d]).join(', ');
}

// Recurring Access tab: standing schedules (user + targets + weekdays + daily window) that
// spawn a normal temporary grant at each window start. Rows open the edit modal on click.
export function RecurringPanel() {
  const { data, isLoading } = useRecurringAccess();
  const del = useDeleteRecurring();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<RecurringAccessRule | 'new' | null>(null);
  const rules = data || [];

  // Sort + client pagination (default 25). Rows are keyed by id and edited/deleted by object,
  // so reordering the list is safe.
  const { sorted, state } = useTableSort(rules, {
    user: (r) => r.userLabel || '',
    targets: (r) => r.targets.map((t) => t.name || t.id).join(', '),
    // Sort by earliest weekday, then window start - a natural "schedule" order.
    schedule: (r) => `${[...r.days].sort((a, b) => a - b)[0] ?? 9}-${r.startTime || ''}`,
    status: (r) => `${r.enabled ? 'a' : 'b'}:${r.activeGrantId != null ? '0' : '1'}`,
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);

  const onDelete = async (r: RecurringAccessRule) => {
    const ok = await confirm({
      title: 'Delete Recurring Rule',
      message: `Delete ${r.userLabel}'s recurring access? ${r.activeGrantId ? 'The currently active window is revoked immediately.' : 'Future windows will no longer be granted.'}`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try { await del.mutateAsync(r.id); }
    catch (e) { await confirm({ title: 'Delete failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-sm text-nb-gray-500 max-w-2xl">
          Standing schedules - at every window start the user gets a normal temporary grant that
          expires at the window end (times follow the app's configured time zone).
        </p>
        <Button variant="primary" onClick={() => setEditing('new')} className="shrink-0">
          <Plus size={15} /><span className="hidden sm:inline">Add Rule</span>
        </Button>
      </div>

      {isLoading ? <LoadingState /> : !rules.length ? (
        <EmptyState title="No Recurring Rules" hint="e.g. give a contractor access every workday 9:00-17:00, granted and revoked automatically." icon={<CalendarClock size={22} />} />
      ) : (
        <>
          {/* Rows-per-page control, consistent with the other list pages. */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
          </div>
          <div className="hidden md:block">
            <Table>
              <THead>
                <SortTh label="User" sortKey="user" state={state} />
                <SortTh label="Targets" sortKey="targets" state={state} />
                <SortTh label="Schedule" sortKey="schedule" state={state} />
                <SortTh label="Status" sortKey="status" state={state} />
                <Th className="text-right">{''}</Th>
              </THead>
              <TBody>
                {pageRows.map((r) => (
                  <Tr key={r.id} onClick={() => setEditing(r)}>
                    <Td>
                      <div className="font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate max-w-[200px]">{r.userLabel}</div>
                      {r.note && <div className="text-[0.76rem] text-nb-gray-500 truncate max-w-[200px]">{r.note}</div>}
                    </Td>
                    <Td onClick={(e) => e.stopPropagation()}><TargetChips targets={r.targets} /></Td>
                    <Td>
                      <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200 whitespace-nowrap">{daysLabel(r.days)}</span>
                      <span className="text-sm text-nb-gray-500 whitespace-nowrap"> · {r.startTime}-{r.endTime}</span>
                      {r.validUntil && <span className="block text-[0.76rem] text-nb-gray-500 whitespace-nowrap">until {r.validUntil}</span>}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <Badge tone={r.enabled ? 'green' : 'gray'}>{r.enabled ? 'Enabled' : 'Disabled'}</Badge>
                        {r.activeGrantId != null && <Badge tone="orange">Active Now</Badge>}
                      </div>
                    </Td>
                    <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <IconButton onClick={() => onDelete(r)} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden flex flex-col gap-2.5">
            {pageRows.map((r) => (
              <div key={r.id} onClick={() => setEditing(r)}
                className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors">
                <div className="flex items-center gap-2.5">
                  <span className="flex-1 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{r.userLabel}</span>
                  <Badge tone={r.enabled ? 'green' : 'gray'} className="shrink-0">{r.enabled ? 'Enabled' : 'Disabled'}</Badge>
                  <div className="shrink-0 -mr-1" onClick={(e) => e.stopPropagation()}>
                    <IconButton onClick={() => onDelete(r)} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                  </div>
                </div>
                <div className="mt-2 text-[0.82rem] text-nb-gray-500">{daysLabel(r.days)} · {r.startTime}-{r.endTime}{r.validUntil ? ` · until ${r.validUntil}` : ''}</div>
                <div className="mt-2" onClick={(e) => e.stopPropagation()}><TargetChips targets={r.targets} /></div>
              </div>
            ))}
          </div>

          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="rules" />
        </>
      )}

      {editing && <RuleModal rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleModal({ rule, onClose }: { rule: RecurringAccessRule | null; onClose: () => void }) {
  const save = useSaveRecurring();
  const users = useUsers().data || [];
  const userOpts = useMemo(
    () => users.filter((u) => !u.is_service_user).map((u) => ({ id: u.id, name: u.name || u.email || u.id, email: u.email || '' })),
    [users],
  );
  const [userId, setUserId] = useState(rule?.userId || '');
  const [targets, setTargets] = useState<GrantTarget[]>(rule?.targets || []);
  const [days, setDays] = useState<number[]>(rule?.days || [0, 1, 2, 3, 4]);
  const [startTime, setStartTime] = useState(rule?.startTime || '09:00');
  const [endTime, setEndTime] = useState(rule?.endTime || '17:00');
  const [validUntil, setValidUntil] = useState(rule?.validUntil || '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [note, setNote] = useState(rule?.note || '');
  const [error, setError] = useState('');

  const toggleDay = (d: number) => setDays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]));

  const submit = async () => {
    if (!userId) { setError('Select a user.'); return; }
    if (!targets.length) { setError('Add at least one target.'); return; }
    if (!days.length) { setError('Pick at least one weekday.'); return; }
    setError('');
    const u = userOpts.find((x) => x.id === userId);
    const payload: RecurringAccessInput = {
      userId, userLabel: u?.name || userId, userEmail: u?.email || '',
      targets, days, startTime, endTime, validUntil, enabled, note: note.trim(),
    };
    try { await save.mutateAsync({ id: rule?.id, payload }); onClose(); }
    catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} size="lg" icon={<CalendarClock size={18} />}
      title={rule ? 'Edit Recurring Rule' : 'Add Recurring Rule'}
      subtitle="A temporary grant is created at every window start and revoked at its end."
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending}>{save.isPending ? '…' : rule ? 'Save Changes' : 'Create Rule'}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <Field label="User">
          <UserSelect users={userOpts} value={userId} onChange={setUserId} />
        </Field>
        <Field label="Targets" hint="What the user may reach during each window - networks, resources, groups or access profiles.">
          <TargetSearch chosen={targets} onPick={(t) => setTargets((p) => [...p, t])} />
          {targets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {targets.map((t, i) => (
                <span key={`${t.type}-${t.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900 pl-2 pr-1 py-1 text-[0.78rem]">
                  <span className="text-nb-gray-400">{TARGET_META[t.type].icon}</span>
                  <span className="text-nb-gray-700 dark:text-nb-gray-200">{t.name}</span>
                  <button type="button" onClick={() => setTargets((p) => p.filter((_, idx) => idx !== i))} className="text-nb-gray-400 hover:text-red-500"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </Field>
        <Field label="Days" hint="Weekdays the window applies to (app time zone).">
          <div className="flex flex-wrap gap-1.5">
            {DAY_LABELS.map((label, d) => (
              <button key={d} type="button" onClick={() => toggleDay(d)}
                className={cn('h-9 px-3 rounded-md border text-sm transition-colors',
                  days.includes(d)
                    ? 'border-netbird/50 bg-netbird/10 text-netbird font-medium'
                    : 'border-nb-gray-200 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800')}>
                {label}
              </button>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="From"><Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
          <Field label="Until"><Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></Field>
        </div>
        <Field label="Until Date (Optional)" hint="Last day the rule applies (inclusive) - past it the rule stops and is disabled automatically. Empty = no end date.">
          <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="w-48" />
        </Field>
        {rule && (
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-netbird" />
            <span className="text-sm text-nb-gray-800 dark:text-nb-gray-100">Enabled</span>
            {!enabled && rule.activeGrantId != null && <span className="text-[0.78rem] text-amber-600 dark:text-amber-400">Disabling revokes the currently active window.</span>}
          </label>
        )}
        <Field label="Note (Optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why / ticket #" /></Field>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
