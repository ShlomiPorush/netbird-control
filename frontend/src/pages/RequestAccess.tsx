import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeyRound, X, Ban, CheckCircle2, AlertTriangle, MonitorSmartphone, Rows3, MonitorCog, History, ChevronDown, ChevronUp } from 'lucide-react';
import { useMyAccessRequests, usePeers } from '@/lib/queries';
import { useCreateAccessRequest, useCancelAccessRequest, useRevokeBypass, useNetbirdRefresh } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useViewer } from '@/contexts/ViewerContext';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import type { GrantTarget, AccessRequest, AccessRequestStatus, Peer } from '@/lib/types';
import { Badge, Button, Checkbox, EmptyState, LoadingState, IconButton, Table, THead, Th, SortTh, TBody, Tr, Td, PageHeader, Field, Textarea, Modal, Pagination } from '@/components/ui';
import { DurationControl, DEFAULT_DURATION, durationPayload, type DurationState } from '@/components/access/DurationControl';
import { TARGET_META, TargetChips } from '@/components/access/targets';
import { TargetSearch } from '@/components/access/TargetSearch';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { formatMaybeDate } from '@/lib/logfmt';
import { ucLabel } from '@/lib/str';
import { cn } from '@/lib/cn';

const STATUS_TONE: Record<AccessRequestStatus, 'green' | 'gray' | 'red' | 'orange'> = {
  pending: 'orange', approved: 'green', denied: 'red', cancelled: 'gray', expired: 'gray',
};

function proposedMinutes(d: DurationState): number {
  const p = durationPayload(d);
  if (!p) return 0;
  if (p.durationMinutes) return p.durationMinutes;
  if (p.expiresAt) return Math.max(1, Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 60000));
  return 0;
}

export default function RequestAccess() {
  const create = useCreateAccessRequest();
  const cancel = useCancelAccessRequest();
  const confirm = useConfirm();
  const { data: mine, isLoading } = useMyAccessRequests();
  const [targets, setTargets] = useState<GrantTarget[]>([]);
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<DurationState>(DEFAULT_DURATION);
  const [error, setError] = useState('');
  const [doneMsg, setDoneMsg] = useState('');

  // Deep link (e.g. Troubleshoot's "Open Request Access"): ?type=&id=&name= preloads the
  // target so the user doesn't have to search for it again. Consumed once, then cleared.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const type = searchParams.get('type');
    const id = searchParams.get('id');
    const name = searchParams.get('name');
    if (!type || !id || !name || !['resource', 'network', 'profile'].includes(type)) return;
    let access: GrantTarget['access'];
    try { access = searchParams.get('access') ? JSON.parse(searchParams.get('access')!) : undefined; } catch { access = undefined; }
    const t: GrantTarget = {
      type: type as GrantTarget['type'], id, name,
      networkId: searchParams.get('networkId') || undefined,
      resourceType: searchParams.get('resourceType') || undefined,
      access,
    };
    setTargets((prev) => (prev.some((x) => x.type === t.type && x.id === t.id) ? prev : [...prev, t]));
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (!targets.length) { setError('Add at least one thing to request.'); return; }
    if (!reason.trim()) { setError('Please add a reason for this request.'); return; }
    setError('');
    try {
      const res = await create.mutateAsync({ targets, reason: reason.trim(), requestedMinutes: proposedMinutes(duration) });
      // Part of a request can be auto-approved (and part sent to review) - tailor the confirmation.
      const msg = res.autoApproved && res.pending
        ? 'Part of your request was approved automatically - the rest is pending review.'
        : res.autoApproved
          ? 'Approved automatically - your access has been granted.'
          : 'Request submitted - an approver will review it.';
      setTargets([]); setReason(''); setDuration(DEFAULT_DURATION); setDoneMsg(msg);
      setTimeout(() => setDoneMsg(''), 5000);
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };
  const onCancel = async (r: AccessRequest) => {
    const ok = await confirm({ title: 'Cancel request', message: 'Withdraw this pending access request?', confirmText: 'Cancel request' });
    if (ok) await cancel.mutateAsync(r.id);
  };

  const requests = mine || [];

  // The requester's own non-compliant devices (blocked by posture/EDR checks) - they can ask an
  // approver to bypass them. Admins and 'View All Peers' holders get EVERY peer from the server,
  // so filter to their own by owner e-mail; plain restricted users are already server-filtered.
  const { viewer, restricted, can } = useViewer();
  const peers = usePeers().data || [];
  const [bypassFor, setBypassFor] = useState<Peer | null>(null);

  // Fresh peer state on entry - the blocked-devices card keys on last_seen recency and
  // compliance flags, so stale cache here means wrong decisions (same as Troubleshoot).
  const refreshNb = useNetbirdRefresh();
  useEffect(() => {
    refreshNb.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const myDevices = useMemo(() => {
    const seesAll = !restricted || can('peers.all') || can('networks.manage');
    return seesAll ? peers.filter((p) => (p.owner_email || '').toLowerCase() === (viewer.email || '').toLowerCase()) : peers;
  }, [peers, restricted, can, viewer.email]);
  // Blocked devices, split by RECENCY of the last connection attempt. A blocked client
  // refreshes last_seen/last_login on every attempt, so "tried within the last hour"
  // separates "someone is at this machine trying to connect right now" from a parked/
  // powered-off device (whose EDR reason is just an artifact of being off). Older ones
  // are COLLAPSED, never hidden - and pop back into the main list the moment the device
  // tries again, which is exactly when its owner needs the Request Bypass button.
  const BLOCKED_RECENT_MS = 3600_000;
  const lastAttempt = (p: Peer) => Math.max(new Date(p.last_seen || 0).getTime() || 0, new Date(p.last_login || 0).getTime() || 0);
  const myBlockedAll = useMemo(
    () => myDevices.filter((p) => p.approval_required && !p.force_approved).sort((a, b) => lastAttempt(b) - lastAttempt(a)),
    [myDevices]);
  const myBlockedDevices = useMemo(() => myBlockedAll.filter((p) => Date.now() - lastAttempt(p) < BLOCKED_RECENT_MS), [myBlockedAll]);
  const myBlockedStale = useMemo(() => myBlockedAll.filter((p) => Date.now() - lastAttempt(p) >= BLOCKED_RECENT_MS), [myBlockedAll]);
  const [showStaleBlocked, setShowStaleBlocked] = useState(false);
  // Own devices with an active bypass - the owner can remove it once it's no longer needed.
  const myBypassedDevices = useMemo(() => myDevices.filter((p) => p.force_approved), [myDevices]);
  const revokeBypass = useRevokeBypass();
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
  const pendingBypassFor = (peerId: string) =>
    requests.some((r) => r.kind === 'bypass' && r.status === 'pending' && r.targets[0]?.id === peerId);

  // What to show per request: once approved, the APPROVER-ADJUSTED list (what was actually
  // granted), not the original ask; plus how many of the requested targets were dropped.
  const shownTargets = (r: AccessRequest) => (r.status === 'approved' && r.approvedTargets?.length ? r.approvedTargets : r.targets);
  const droppedCount = (r: AccessRequest) =>
    r.status === 'approved' && r.approvedTargets?.length
      ? r.targets.filter((t) => !r.approvedTargets!.some((a) => a.type === t.type && a.id === t.id)).length
      : 0;

  // Once approved, show the duration that was ACTUALLY granted (0 = unlimited bypass) -
  // the approver may have shortened, extended or made it unlimited vs. the original ask.
  const grantedMinutes = (r: AccessRequest) =>
    r.status === 'approved' && r.approvedMinutes != null ? r.approvedMinutes : null;
  const durationLabel = (r: AccessRequest) => {
    const gm = grantedMinutes(r);
    if (gm != null) return gm === 0 ? 'Unlimited' : `${gm} min`;
    return r.requestedMinutes ? `${r.requestedMinutes} min` : '-';
  };
  const durationDiffers = (r: AccessRequest) => {
    const gm = grantedMinutes(r);
    return gm != null && gm !== (r.requestedMinutes || 0);
  };

  const { sorted, state } = useTableSort(requests, {
    requested: (r) => shownTargets(r).map((t) => t.name || t.id).join(', '),
    duration: (r) => {
      const gm = grantedMinutes(r);
      return gm != null ? (gm === 0 ? Number.MAX_SAFE_INTEGER : gm) : (r.requestedMinutes || 0);
    },
    reason: (r) => r.reason || '',
    when: (r) => r.createdAt || '',
    status: (r) => r.status,
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);

  return (
    <div>
      <PageHeader title="Request Access" description="Ask for temporary access to a resource, network or access profile. An admin approves it, and it auto-expires." />

      {/* Non-compliant devices → request a bypass */}
      {myBlockedAll.length > 0 && (() => {
        const blockedRow = (p: Peer) => (
          <div key={p.id} className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 px-3.5 py-3">
            <div className="flex items-start gap-3">
              <span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', p.connected ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} title={p.connected ? 'Connected' : 'Disconnected'} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{p.name || p.dns_label || p.id}</div>
                <div className="font-mono text-[0.72rem] text-nb-gray-500 truncate">{p.ip}</div>
              </div>
              {pendingBypassFor(p.id)
                ? <Badge tone="orange">Requested</Badge>
                : <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setBypassFor(p)}>Request Bypass</Button>}
            </div>

            {p.disapproval_reason && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[0.72rem] font-medium text-amber-600 dark:text-amber-400" title={p.disapproval_reason}>
                <AlertTriangle size={11} /> Blocked: {p.disapproval_reason}
              </div>
            )}

            {/* Device facts only - this card is for the END USER deciding "is this my
                device?", not an admin view. No groups, no network internals. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.76rem] text-nb-gray-500">
              {(p.os || p.version) && <span className="inline-flex items-center gap-1.5 truncate"><MonitorCog size={12} className="shrink-0" /> {[p.os, p.version].filter(Boolean).join(' · ')}</span>}
              {p.hostname && p.hostname !== p.name && <span className="inline-flex items-center gap-1.5 truncate"><MonitorSmartphone size={12} className="shrink-0" /> {p.hostname}</span>}
              <span className="inline-flex items-center gap-1.5 truncate"><History size={12} className="shrink-0" /> {p.connected ? 'Connected now' : `Seen ${formatMaybeDate(p.last_seen)}`}</span>
            </div>
          </div>
        );
        return (
          <div className="max-w-3xl mb-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50">
              <AlertTriangle size={15} className="text-amber-500" /> Devices Needing Approval
            </div>
            <p className="mt-0.5 mb-3 text-[0.82rem] text-nb-gray-500">
              These devices failed compliance checks and can't connect. You can ask an approver to bypass them.
            </p>
            {myBlockedDevices.length > 0 && (
              <div className="flex flex-col gap-2">{myBlockedDevices.map(blockedRow)}</div>
            )}
            {myBlockedStale.length > 0 && (
              <div className={cn(myBlockedDevices.length > 0 && 'mt-2.5')}>
                <button type="button" onClick={() => setShowStaleBlocked((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-[0.8rem] text-nb-gray-500 hover:text-nb-gray-700 dark:hover:text-nb-gray-300 transition-colors">
                  {showStaleBlocked ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  {myBlockedStale.length} blocked device{myBlockedStale.length === 1 ? '' : 's'} with no recent connection attempt
                </button>
                {!showStaleBlocked && (
                  <p className="mt-1 text-[0.72rem] text-nb-gray-500">
                    Probably powered off or unused - a device moves back up here the moment it tries to connect.
                  </p>
                )}
                {showStaleBlocked && <div className="mt-2 flex flex-col gap-2">{myBlockedStale.map(blockedRow)}</div>}
              </div>
            )}
          </div>
        );
      })()}

      {/* Devices with an active bypass → the owner can remove it */}
      {myBypassedDevices.length > 0 && (
        <div className="max-w-3xl mb-5 rounded-lg border border-green-500/30 bg-green-500/5 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50">
            <CheckCircle2 size={15} className="text-green-500" /> Bypassed Devices
          </div>
          <p className="mt-0.5 mb-3 text-[0.82rem] text-nb-gray-500">
            These devices have an active compliance bypass. Remove it when it's no longer needed - the device
            will be blocked again until it passes the checks.
          </p>
          <div className="flex flex-col gap-2">
            {myBypassedDevices.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 px-3 py-2">
                <MonitorSmartphone size={15} className="shrink-0 text-nb-gray-400" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate">{p.name || p.dns_label || p.id}</span>
                  <span className="block font-mono text-[0.72rem] text-nb-gray-500 truncate">{p.ip}</span>
                  {p.bypass_temp_device && p.bypass_expires_at && (
                    <span className="block text-[0.72rem] text-amber-600 dark:text-amber-400">Temporary device - deleted automatically on {formatMaybeDate(p.bypass_expires_at)}</span>
                  )}
                  {!p.bypass_temp_device && p.bypass_expires_at && (
                    <span className="block text-[0.72rem] text-nb-gray-500">Bypass ends {formatMaybeDate(p.bypass_expires_at)}</span>
                  )}
                </span>
                <Badge tone="green">Bypassed</Badge>
                {p.bypass_expires_at && (pendingBypassFor(p.id)
                  ? <Badge tone="gray">Extension Pending</Badge>
                  : <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setBypassFor(p)}>Request Extension</Button>)}
                <Button variant="secondary" size="sm" className="shrink-0" onClick={() => onRemoveBypass(p)} disabled={revokeBypass.isPending}>Revoke Bypass</Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="max-w-3xl rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4 md:p-5 flex flex-col gap-4">
        <Field label="What Do You Need Access To?" hint="Start typing - pick one or more resources, networks or access profiles.">
          <TargetSearch chosen={targets} onPick={(t) => setTargets((p) => [...p, t])} />
          {targets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {targets.map((t, i) => (
                <span key={`${t.type}-${t.id}-${i}`} className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900 pl-2 pr-1 py-1 text-[0.78rem]">
                  <span className="text-nb-gray-400">{TARGET_META[t.type].icon}</span>
                  <span className="text-nb-gray-700 dark:text-nb-gray-200">{t.name}</span>
                  <button type="button" onClick={() => setTargets((p) => p.filter((_, idx) => idx !== i))} className="text-nb-gray-400 hover:text-red-500"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </Field>
        <Field label="For How Long?" hint="Your proposed duration - an admin can adjust it on approval."><DurationControl value={duration} onChange={setDuration} /></Field>
        <Field label="Reason" hint="Explain why you need this - it helps the approver decide."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why do you need this? Ticket #…" /></Field>
        {error && <p className="text-sm text-red-500">{error}</p>}
        {doneMsg && <p className="inline-flex items-center gap-1.5 text-sm text-green-600 dark:text-green-500"><CheckCircle2 size={15} /> {doneMsg}</p>}
        <div><Button variant="primary" onClick={submit} disabled={create.isPending || !targets.length || !reason.trim()}><KeyRound size={15} /> {create.isPending ? 'Submitting…' : 'Submit request'}</Button></div>
      </div>

      <div className="flex items-center justify-between gap-3 mt-8 mb-3">
        <h2 className="text-base font-semibold text-nb-gray-900 dark:text-nb-gray-50">My Requests</h2>
        {requests.length > 0 && (
          <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        )}
      </div>
      {isLoading ? <LoadingState /> : !requests.length ? (
        <EmptyState title="No Requests Yet" hint="Requests you submit will appear here with their status." icon={<KeyRound size={22} />} />
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <THead>
                <SortTh label="Requested" sortKey="requested" state={state} />
                <SortTh label="For" sortKey="duration" state={state} />
                <SortTh label="Reason" sortKey="reason" state={state} />
                <SortTh label="When" sortKey="when" state={state} />
                <SortTh label="Status" sortKey="status" state={state} />
                <Th className="text-right">{''}</Th>
              </THead>
              <TBody>
                {pageRows.map((r) => (
                  <Tr key={r.id}>
                    <Td>
                      <TargetChips targets={shownTargets(r)} />
                      {r.kind === 'bypass' && r.extendBypass && <span className="block mt-1 text-[0.72rem] text-nb-gray-500">Bypass extension</span>}
                      {r.kind === 'bypass' && r.tempDevice && <span className="block mt-1 text-[0.72rem] text-amber-600 dark:text-amber-400">Temporary device - deleted when the bypass expires</span>}
                      {droppedCount(r) > 0 && <span className="block mt-1 text-[0.72rem] text-nb-gray-500">{droppedCount(r)} requested target{droppedCount(r) === 1 ? ' was' : 's were'} not granted</span>}
                    </Td>
                    <Td>
                      <span className="text-sm text-nb-gray-600 dark:text-nb-gray-300 whitespace-nowrap">{durationLabel(r)}</span>
                      {durationDiffers(r) && <span className="block text-[0.72rem] text-nb-gray-500 whitespace-nowrap">Requested {r.requestedMinutes} min</span>}
                    </Td>
                    <Td><span className="text-sm text-nb-gray-500 truncate max-w-[220px] inline-block align-bottom">{r.reason || '-'}</span></Td>
                    <Td><span className="text-sm text-nb-gray-500 whitespace-nowrap">{formatMaybeDate(r.createdAt)}</span></Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <Badge tone={STATUS_TONE[r.status]}>{ucLabel(r.status)}</Badge>
                        {r.status === 'denied' && r.decisionNote && <span title={r.decisionNote} className="text-red-500 text-xs cursor-help">ⓘ</span>}
                      </span>
                    </Td>
                    <Td className="text-right">
                      {r.status === 'pending' && <IconButton onClick={() => onCancel(r)} title="Cancel request" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Ban size={15} /></IconButton>}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: cards instead of the wide table */}
          <div className="md:hidden flex flex-col gap-2.5">
            {pageRows.map((r) => (
              <div key={`m-${r.id}`} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <TargetChips targets={shownTargets(r)} />
                    {r.kind === 'bypass' && r.extendBypass && <span className="block mt-1 text-[0.72rem] text-nb-gray-500">Bypass extension</span>}
                    {r.kind === 'bypass' && r.tempDevice && <span className="block mt-1 text-[0.72rem] text-amber-600 dark:text-amber-400">Temporary device - deleted when the bypass expires</span>}
                    {droppedCount(r) > 0 && <span className="block mt-1 text-[0.72rem] text-nb-gray-500">{droppedCount(r)} requested target{droppedCount(r) === 1 ? ' was' : 's were'} not granted</span>}
                  </div>
                  <span className="shrink-0 inline-flex items-center gap-1.5">
                    <Badge tone={STATUS_TONE[r.status]}>{ucLabel(r.status)}</Badge>
                    {r.status === 'pending' && <IconButton onClick={() => onCancel(r)} title="Cancel request" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Ban size={15} /></IconButton>}
                  </span>
                </div>
                {r.reason && <div className="mt-2 text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300 wrap-break-word">{r.reason}</div>}
                {r.status === 'denied' && r.decisionNote && <div className="mt-1 text-[0.78rem] text-red-500 wrap-break-word">Denied: {r.decisionNote}</div>}
                <div className="mt-2 flex items-center gap-2 text-[0.76rem] text-nb-gray-500">
                  <span>{formatMaybeDate(r.createdAt)}</span>
                  {durationLabel(r) !== '-' ? <span>· {durationLabel(r)}{durationDiffers(r) ? ` (requested ${r.requestedMinutes} min)` : ''}</span> : null}
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="requests" />
        </>
      )}

      {bypassFor && <BypassModal peer={bypassFor} onClose={() => setBypassFor(null)} />}
    </div>
  );
}

/** Ask an approver to bypass a non-compliant device (NetBird EDR bypass on approval).
 *  For a device that already has a TIMED bypass, the same modal submits an EXTENSION
 *  request instead - the server detects the active bypass and just moves the expiry. */
function BypassModal({ peer, onClose }: { peer: Peer; onClose: () => void }) {
  const create = useCreateAccessRequest();
  const isExtension = !!peer.force_approved;
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<DurationState>(DEFAULT_DURATION);
  const [tempDevice, setTempDevice] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!reason.trim()) { setError(isExtension ? 'Please explain why more time is needed.' : 'Please explain why this device should be bypassed.'); return; }
    setError('');
    try {
      await create.mutateAsync({
        kind: 'bypass',
        targets: [{ type: 'peer', id: peer.id, name: peer.name || peer.dns_label || peer.id }],
        reason: reason.trim(),
        requestedMinutes: proposedMinutes(duration),
        // Extensions inherit the current bypass's temp flag server-side.
        tempDevice: isExtension ? undefined : tempDevice,
      });
      onClose();
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} size="md" icon={<MonitorSmartphone size={18} />}
      title={isExtension ? 'Request Bypass Extension' : 'Request Device Bypass'}
      subtitle={`${peer.name || peer.dns_label || peer.id} · ${peer.ip}`}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={create.isPending || !reason.trim()}>{create.isPending ? '…' : 'Submit Request'}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        {isExtension ? (
          <p className="text-sm text-nb-gray-600 dark:text-nb-gray-300">
            This device's bypass ends {peer.bypass_expires_at ? <b>{formatMaybeDate(peer.bypass_expires_at)}</b> : 'soon'}.
            An approver will review your request; if approved, the bypass gets a <b>new duration</b> starting from the approval.
          </p>
        ) : (
          <p className="text-sm text-nb-gray-600 dark:text-nb-gray-300">
            This device failed compliance checks. An approver will review your request; if approved, the
            device is <b>bypassed</b> and can connect despite the failing checks.
          </p>
        )}
        {isExtension && peer.bypass_temp_device && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[0.8rem] text-amber-600 dark:text-amber-400">
            <b>Temporary Device</b> - it will still be deleted automatically when the extended period ends.
          </p>
        )}
        {peer.disapproval_reason && (
          <p className="text-[0.82rem] text-amber-600 dark:text-amber-400">Why it's blocked: {peer.disapproval_reason}</p>
        )}
        <Field label="For How Long?" hint="Your proposed duration - the approver can adjust it on approval.">
          <DurationControl value={duration} onChange={setDuration} />
        </Field>
        <Field label="Reason" hint={isExtension ? 'Explain why more time is needed - it helps the approver decide.' : 'Explain why the bypass is needed - it helps the approver decide.'}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="e.g. AV agent is being reinstalled, need access for today's deployment…" />
        </Field>
        {!isExtension && (
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <Checkbox checked={tempDevice} onChange={(e) => setTempDevice(e.target.checked)} className="mt-0.5" />
            <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
              Temporary Device
              <span className="block text-[0.8rem] text-nb-gray-500 mt-0.5">
                The device will be <b>deleted automatically</b> from NetBird when the approved bypass period ends
                (it will have to re-enroll to come back).
              </span>
            </span>
          </label>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
