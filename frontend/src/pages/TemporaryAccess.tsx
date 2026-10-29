import { useEffect, useMemo, useState } from 'react';
import { Clock, Plus, Trash2, X, RotateCw, Ban, Rows3 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTemporaryAccessGrants, useUsers, usePeers, useNetworks, useNetworkDetail, useGroups, useAccessProfiles } from '@/lib/queries';
import { useCreateGrant, useExtendGrant, useRevokeGrant, useDeleteGrant } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { useUrlTab } from '@/lib/useUrlTab';
import type { TemporaryAccessGrant, GrantTarget, GrantTargetType, GrantStatus, TemporaryAccessGrantInput } from '@/lib/types';
import {
  Badge, Button, IconButton, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td, Pagination,
  Modal, Field, FieldHint, Input, SelectMenu, PillTabs,
} from '@/components/ui';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { UserSelect } from '@/components/logs/UserSelect';
import { formatMaybeDate } from '@/lib/logfmt';
import { ucLabel } from '@/lib/str';
import { DurationControl, DEFAULT_DURATION, durationPayload, type DurationState } from '@/components/access/DurationControl';
import { TARGET_META, TargetChips } from '@/components/access/targets';
import { TargetSearch } from '@/components/access/TargetSearch';
import { RecurringPanel } from '@/components/access/RecurringPanel';

const STATUS_TONE: Record<GrantStatus, 'green' | 'gray' | 'red'> = { active: 'green', expired: 'gray', revoked: 'gray', error: 'red' };

// ── time helpers ──
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
function fmtLeft(expiresAt: string, now: number): string {
  let s = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
  if (Number.isNaN(s)) return '-';
  if (s <= 0) return 'expired';
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d}d ${h}h left`;
  if (h) return `${h}h ${m}m left`;
  if (m) return `${m}m left`;
  return '<1m left';
}

// ── target picker ──
function TargetPicker({ targets, onChange }: { targets: GrantTarget[]; onChange: (t: GrantTarget[]) => void }) {
  const networks = useNetworks().data || [];
  const groups = useGroups().data || [];
  const profiles = (useAccessProfiles().data || []).filter((p) => p.shared);
  const [type, setType] = useState<GrantTargetType>('network');
  const [networkId, setNetworkId] = useState('');
  const [sel, setSel] = useState('');
  const detail = useNetworkDetail(type === 'resource' && networkId ? networkId : undefined);
  const resources = detail.data?.resources || [];

  const addTarget = (t: GrantTarget) => {
    // Port-policy sub-entries share the resource's id - dedupe by scope too, so
    // "Host · Veeam (TCP)" and "Host · Proxmox (TCP)" can both be granted at once.
    const sig = (x: GrantTarget) => `${x.type}:${x.id}:${JSON.stringify(x.access ?? null)}`;
    if (targets.some((x) => sig(x) === sig(t))) return;
    onChange([...targets, t]);
  };
  const add = () => {
    let t: GrantTarget | null = null;
    if (type === 'network' && sel) { const n = networks.find((x) => x.id === sel); t = { type, id: sel, name: n?.name || sel }; }
    else if (type === 'group' && sel) { const g = groups.find((x) => x.id === sel); t = { type, id: sel, name: g?.name || sel }; }
    else if (type === 'profile' && sel) { const p = profiles.find((x) => String(x.id) === sel); t = { type, id: sel, name: p?.name || sel, groupId: p?.groupId }; }
    else if (type === 'resource' && sel && networkId) { const r = resources.find((x) => x.id === sel); t = { type, id: sel, name: r?.name || r?.address || sel, networkId, resourceType: r?.type }; }
    if (t) addTarget(t);
    setSel('');
  };

  return (
    <div className="flex flex-col gap-2.5">
      {/* Search everything at once (resources / networks / profiles) - the fast path. */}
      <TargetSearch chosen={targets} onPick={addTarget} />
      <div className="flex items-center gap-2 text-[0.68rem] uppercase tracking-wide text-nb-gray-400">
        <span className="h-px flex-1 bg-nb-gray-200 dark:bg-nb-gray-800" /> Or Pick Manually <span className="h-px flex-1 bg-nb-gray-200 dark:bg-nb-gray-800" />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44">
          <SelectMenu
            searchable={false}
            value={type}
            onChange={(v) => { setType(v as GrantTargetType); setSel(''); }}
            options={[
              { value: 'network', label: 'Whole Network' },
              { value: 'resource', label: 'Resource' },
              { value: 'group', label: 'Group' },
              { value: 'profile', label: 'Access Profile' },
            ]}
          />
        </div>
        {type === 'resource' && (
          <div className="w-48">
            <SelectMenu
              value={networkId}
              onChange={(v) => { setNetworkId(v); setSel(''); }}
              placeholder="Network…" searchPlaceholder="Search networks…"
              options={networks.map((n) => ({ value: n.id, label: n.name || n.id }))}
            />
          </div>
        )}
        <div className="flex-1 min-w-[200px]">
          {type === 'network' && (
            <SelectMenu value={sel} onChange={setSel} placeholder="Select network…" searchPlaceholder="Search networks…"
              options={networks.map((n) => ({ value: n.id, label: n.name || n.id }))} />
          )}
          {type === 'group' && (
            <SelectMenu value={sel} onChange={setSel} placeholder={groups.length ? 'Select group…' : 'No groups'} searchPlaceholder="Search groups…"
              options={groups.map((g) => ({ value: g.id, label: g.name }))} />
          )}
          {type === 'profile' && (
            <SelectMenu value={sel} onChange={setSel} placeholder={profiles.length ? 'Select access profile…' : 'No shared profiles'} searchPlaceholder="Search profiles…"
              options={profiles.map((p) => ({ value: String(p.id), label: p.name }))} />
          )}
          {type === 'resource' && (
            <SelectMenu value={sel} onChange={setSel} disabled={!networkId}
              placeholder={!networkId ? 'Pick a network first' : detail.isLoading ? 'Loading…' : 'Select resource…'} searchPlaceholder="Search resources…"
              options={resources.map((r) => ({ value: r.id, label: r.name || r.address || r.id, subtitle: r.name ? r.address : undefined }))} />
          )}
        </div>
        <Button variant="secondary" onClick={add} disabled={!sel} type="button"><Plus size={14} /> Add</Button>
      </div>
      {targets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {targets.map((t, i) => (
            <span key={`${t.type}-${t.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900 pl-2 pr-1 py-1 text-[0.78rem]">
              <span className="text-nb-gray-400">{TARGET_META[t.type].icon}</span>
              <span className="text-nb-gray-700 dark:text-nb-gray-200">{t.name}</span>
              <span className="text-nb-gray-400 text-[0.66rem] uppercase">{TARGET_META[t.type].label}</span>
              <button type="button" onClick={() => onChange(targets.filter((_, idx) => idx !== i))} className="text-nb-gray-400 hover:text-red-500"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── page ──
export default function TemporaryAccess() {
  const [tab, setTab] = useUrlTab<'grants' | 'recurring'>(['grants', 'recurring'], 'grants');
  const { data, isLoading } = useTemporaryAccessGrants(tab === 'grants');
  const revoke = useRevokeGrant();
  const del = useDeleteGrant();
  const confirm = useConfirm();
  const now = useNow(1000);
  const [granting, setGranting] = useState(false);
  const [extend, setExtend] = useState<TemporaryAccessGrant | null>(null);
  const grants = data || [];

  const { sorted, state } = useTableSort(grants, {
    user: (g) => g.userLabel || '',
    targets: (g) => (g.targets || []).map((t) => t.name || t.id).join(', '),
    expires: (g) => g.expiresAt || '',
    timeLeft: (g) => (g.status === 'active' ? new Date(g.expiresAt).getTime() : 0),
    status: (g) => g.status,
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);

  const onRevoke = async (g: TemporaryAccessGrant) => {
    const ok = await confirm({ title: 'Revoke access', message: `Revoke ${g.userLabel}'s temporary access now? Its policy and group are deleted immediately.`, confirmText: 'Revoke' });
    if (ok) await revoke.mutateAsync(g.id);
  };
  const onDelete = async (g: TemporaryAccessGrant) => {
    const ok = await confirm({ title: 'Remove from history', message: `Remove this ${g.status} grant from the list?`, confirmText: 'Remove' });
    if (ok) await del.mutateAsync(g.id);
  };

  return (
    <div>
      <p className="text-nb-gray-500 text-sm max-w-2xl mb-4">
        Grant a user time-boxed access to resources - applied now, automatically revoked when it expires.
      </p>

      {/* One balanced control row: tabs on the left, the grants tab's actions together on
          the right (rows-per-page + the primary button) - wraps cleanly on mobile. */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <PillTabs
          items={[{ key: 'grants', label: 'Grants' }, { key: 'recurring', label: 'Recurring' }]}
          value={tab}
          onChange={(k) => setTab(k as 'grants' | 'recurring')}
        />
        {tab === 'grants' && (
          <div className="flex flex-wrap items-center gap-2">
            {grants.length > 0 && (
              <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
            )}
            <Button variant="primary" onClick={() => setGranting(true)} title="Grant access">
              <Plus size={15} /> Grant access
            </Button>
          </div>
        )}
      </div>

      {tab === 'recurring' ? <RecurringPanel /> : isLoading ? <LoadingState /> : !grants.length ? (
        <EmptyState title="No Temporary Access" hint="Grant a user access to resources for a limited time; it auto-revokes on expiry." icon={<Clock size={22} />} />
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <THead>
                <SortTh label="User" sortKey="user" state={state} />
                <SortTh label="Targets" sortKey="targets" state={state} />
                <SortTh label="Expires" sortKey="expires" state={state} />
                <SortTh label="Time Left" sortKey="timeLeft" state={state} />
                <SortTh label="Status" sortKey="status" state={state} />
                <Th className="text-right">{''}</Th>
              </THead>
              <TBody>
                {pageRows.map((g) => {
                  const urgent = g.status === 'active' && new Date(g.expiresAt).getTime() - now < 3600_000;
                  return (
                    <Tr key={g.id}>
                      <Td>
                        <div className="font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate max-w-[200px]">{g.userLabel}</div>
                        {g.note && <div className="text-[0.76rem] text-nb-gray-500 truncate max-w-[200px]">{g.note}</div>}
                      </Td>
                      <Td><TargetChips targets={g.targets} /></Td>
                      <Td><span className="text-sm text-nb-gray-600 dark:text-nb-gray-300 whitespace-nowrap">{formatMaybeDate(g.expiresAt)}</span></Td>
                      <Td>
                        {g.status === 'active'
                          ? <span className={cn('text-sm whitespace-nowrap', urgent ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-nb-gray-700 dark:text-nb-gray-200')}>{fmtLeft(g.expiresAt, now)}</span>
                          : <span className="text-nb-gray-400 text-sm">-</span>}
                      </Td>
                      <Td>
                        <span className="inline-flex items-center gap-1.5">
                          <Badge tone={STATUS_TONE[g.status]}>{ucLabel(g.status)}</Badge>
                          {g.status === 'error' && g.lastError && <span title={g.lastError} className="text-red-500 text-xs cursor-help">⚠</span>}
                        </span>
                      </Td>
                      <Td className="text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {g.status === 'active' ? (
                            <>
                              <IconButton onClick={() => setExtend(g)} title="Extend / renew"><RotateCw size={15} /></IconButton>
                              <IconButton onClick={() => onRevoke(g)} title="Revoke now" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Ban size={15} /></IconButton>
                            </>
                          ) : (
                            <IconButton onClick={() => onDelete(g)} title="Remove from history" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </div>

          {/* Mobile: cards instead of the wide table */}
          <div className="md:hidden flex flex-col gap-2.5">
            {pageRows.map((g) => {
              const urgent = g.status === 'active' && new Date(g.expiresAt).getTime() - now < 3600_000;
              return (
                <div key={g.id} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{g.userLabel}</div>
                      {g.note && <div className="text-[0.76rem] text-nb-gray-500 truncate">{g.note}</div>}
                    </div>
                    <span className="shrink-0 inline-flex items-center gap-1.5">
                      <Badge tone={STATUS_TONE[g.status]}>{ucLabel(g.status)}</Badge>
                      {g.status === 'error' && g.lastError && <span title={g.lastError} className="text-red-500 text-xs cursor-help">⚠</span>}
                    </span>
                  </div>
                  <div className="mt-2.5"><TargetChips targets={g.targets} /></div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="text-[0.78rem] text-nb-gray-500 min-w-0">
                      <span className="whitespace-nowrap">{formatMaybeDate(g.expiresAt)}</span>
                      {g.status === 'active' && <span className={cn('ml-2 whitespace-nowrap', urgent ? 'text-amber-600 dark:text-amber-400 font-medium' : '')}>· {fmtLeft(g.expiresAt, now)}</span>}
                    </div>
                    <div className="shrink-0 inline-flex items-center gap-1.5">
                      {g.status === 'active' ? (
                        <>
                          <IconButton onClick={() => setExtend(g)} title="Extend / renew"><RotateCw size={15} /></IconButton>
                          <IconButton onClick={() => onRevoke(g)} title="Revoke now" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Ban size={15} /></IconButton>
                        </>
                      ) : (
                        <IconButton onClick={() => onDelete(g)} title="Remove from history" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="grants" />
        </>
      )}

      {granting && <GrantModal onClose={() => setGranting(false)} />}
      {extend && <ExtendModal grant={extend} onClose={() => setExtend(null)} />}
    </div>
  );
}

function GrantModal({ onClose }: { onClose: () => void }) {
  const create = useCreateGrant();
  const users = useUsers().data || [];
  const peers = usePeers().data || [];
  const userOpts = useMemo(
    () => users.filter((u) => !u.is_service_user).map((u) => ({ id: u.id, name: u.name || u.email || u.id, email: u.email || '' })),
    [users],
  );
  const [userId, setUserId] = useState('');
  const [targets, setTargets] = useState<GrantTarget[]>([]);
  const [duration, setDuration] = useState<DurationState>(DEFAULT_DURATION);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const userEmail = userOpts.find((x) => x.id === userId)?.email || '';
  const deviceCount = userEmail ? peers.filter((p) => (p.owner_email || '').toLowerCase() === userEmail.toLowerCase()).length : 0;

  const submit = async () => {
    if (!userId) { setError('Select a user.'); return; }
    if (!targets.length) { setError('Add at least one target.'); return; }
    const dp = durationPayload(duration);
    if (!dp) { setError('Set a valid future expiry.'); return; }
    setError('');
    const u = userOpts.find((x) => x.id === userId);
    const payload: TemporaryAccessGrantInput = { userId, userLabel: u?.name, targets, note: note.trim(), ...dp };
    try { await create.mutateAsync(payload); onClose(); }
    catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} size="lg" icon={<Clock size={18} />}
      title="Grant Temporary Access"
      subtitle="Applied immediately; automatically revoked when it expires."
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={create.isPending}>{create.isPending ? '…' : 'Grant access'}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <Field label="User">
          <UserSelect users={userOpts} value={userId} onChange={setUserId} />
          {userId !== '' && deviceCount === 0 && <FieldHint><span className="text-amber-600 dark:text-amber-400">This user has no enrolled devices yet - the grant stays inert until they add one (it's picked up automatically).</span></FieldHint>}
        </Field>
        <Field label="Targets" hint="What the user may reach. Add any mix of whole networks, specific resources, groups, or access profiles.">
          <TargetPicker targets={targets} onChange={setTargets} />
        </Field>
        <Field label="Duration"><DurationControl value={duration} onChange={setDuration} /></Field>
        <Field label="Note (Optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why / ticket #" /></Field>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

function ExtendModal({ grant, onClose }: { grant: TemporaryAccessGrant; onClose: () => void }) {
  const extend = useExtendGrant();
  const [duration, setDuration] = useState<DurationState>(DEFAULT_DURATION);
  const [error, setError] = useState('');

  const submit = async () => {
    const dp = durationPayload(duration);
    if (!dp) { setError('Set a valid future expiry.'); return; }
    setError('');
    try { await extend.mutateAsync({ id: grant.id, payload: dp }); onClose(); }
    catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} size="md" icon={<RotateCw size={18} />}
      title="Extend Access"
      subtitle={`${grant.userLabel} - currently expires ${formatMaybeDate(grant.expiresAt)}.`}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={extend.isPending}>{extend.isPending ? '…' : 'Set new expiry'}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <Field label="New Expiry" hint="Sets a fresh expiry from now, or an exact time.">
          <DurationControl value={duration} onChange={setDuration} />
        </Field>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
