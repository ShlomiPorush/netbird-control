import { useMemo, useState } from 'react';
import { Inbox, MonitorSmartphone, X, Rows3 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAccessRequests, usePeers } from '@/lib/queries';
import { useApproveRequest, useDenyRequest } from '@/lib/mutations';
import { useViewer } from '@/contexts/ViewerContext';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import type { AccessRequest, AccessRequestStatus, GrantTarget } from '@/lib/types';
import { Badge, Button, EmptyState, LoadingState, Table, THead, SortTh, TBody, Tr, Td, Pagination, Modal, Field, Input, SearchInput, SelectMenu, ClearFiltersButton, PillTabs } from '@/components/ui';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { DurationControl, durationFromMinutes, durationPayload, type DurationState } from '@/components/access/DurationControl';
import { TargetChips, TARGET_META } from '@/components/access/targets';
import { TargetSearch } from '@/components/access/TargetSearch';
import { AutoApprovalPanel } from '@/components/access/AutoApprovalPanel';
import { formatMaybeDate } from '@/lib/logfmt';
import { ucLabel } from '@/lib/str';
import { useUrlTab } from '@/lib/useUrlTab';

const STATUS_TONE: Record<AccessRequestStatus, 'green' | 'gray' | 'red' | 'orange'> = {
  pending: 'orange', approved: 'green', denied: 'red', cancelled: 'gray', expired: 'gray',
};

// "90 min" is fine, "1440 min" is not - fold whole hours/days into their unit.
const durLabel = (min: number) =>
  min % 1440 === 0 ? `${min / 1440} day${min / 1440 === 1 ? '' : 's'}`
    : min % 60 === 0 ? `${min / 60} hour${min / 60 === 1 ? '' : 's'}`
      : `${min} min`;

type Tab = 'requests' | 'auto';

export default function AccessRequests() {
  const { isAdmin } = useViewer();
  const [tab, setTab] = useUrlTab<Tab>(['requests', 'auto'], 'requests');
  const tabs: { key: Tab; label: string }[] = [
    { key: 'requests', label: 'Requests' },
    ...(isAdmin ? [{ key: 'auto' as Tab, label: 'Auto-Approval' }] : []),
  ];

  return (
    <div>
      <p className="text-nb-gray-500 text-sm mb-5">
        Review requests for temporary access. Approving creates a time-boxed grant that auto-expires; you can
        also approve or deny from the Telegram group.
      </p>

      {tabs.length > 1 && (
        <PillTabs className="mb-5" items={tabs} value={tab} onChange={(k) => setTab(k as Tab)} />
      )}

      {tab === 'auto' ? <AutoApprovalPanel /> : <RequestsList />}
    </div>
  );
}

type StatusFilter = 'all' | AccessRequestStatus;
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'denied', label: 'Denied' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
];

// Once approved, the duration ACTUALLY granted wins the display (0 = unlimited bypass).
const grantedMin = (r: AccessRequest) => (r.status === 'approved' && r.approvedMinutes != null ? r.approvedMinutes : null);
const forLabel = (r: AccessRequest) => {
  const gm = grantedMin(r);
  if (gm != null) return gm === 0 ? 'Unlimited' : durLabel(gm);
  return r.requestedMinutes ? durLabel(r.requestedMinutes) : '-';
};
const forDiffers = (r: AccessRequest) => {
  const gm = grantedMin(r);
  return gm != null && gm !== (r.requestedMinutes || 0);
};

type KindFilter = 'all' | 'access' | 'bypass';

function RequestsList() {
  const { data, isLoading } = useAccessRequests();
  const [review, setReview] = useState<AccessRequest | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kindF, setKindF] = useState<KindFilter>('all');
  const list = data || [];

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return list.filter((r) => {
      if (status !== 'all' && r.status !== status) return false;
      if (kindF !== 'all' && r.kind !== kindF) return false;
      if (!q) return true;
      return (r.requesterName || '').toLowerCase().includes(q)
        || (r.requesterEmail || '').toLowerCase().includes(q)
        || (r.reason || '').toLowerCase().includes(q)
        || r.targets.some((t) => (t.name || t.id || '').toLowerCase().includes(q));
    });
  }, [list, search, status, kindF]);
  const pendingCount = list.filter((r) => r.status === 'pending').length;

  const { sorted, state } = useTableSort(filtered, {
    requester: (r) => r.requesterName || r.requesterEmail || '',
    type: (r) => `${r.kind}${r.extendBypass ? '-ext' : ''}${r.tempDevice ? '-tmp' : ''}`,
    wants: (r) => (r.targets || []).map((t) => t.name || t.id).join(', '),
    for: (r) => {
      const gm = grantedMin(r);
      return gm != null ? (gm === 0 ? Number.MAX_SAFE_INTEGER : gm) : (r.requestedMinutes || 0);
    },
    reason: (r) => r.reason || '',
    asked: (r) => r.createdAt || '',
    status: (r) => r.status,
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25, [search, status, kindF]);

  if (isLoading) return <LoadingState />;
  if (!list.length) return <EmptyState title="No Access Requests" hint="When someone requests access, it appears here (and in Telegram) for approval." icon={<Inbox size={22} />} />;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder="Search requester, target or reason…" />
        <div className="w-44"><SelectMenu value={status} onChange={(v) => setStatus(v as StatusFilter)} searchable={false} options={STATUS_OPTIONS} /></div>
        <div className="w-40"><SelectMenu value={kindF} onChange={(v) => setKindF(v as KindFilter)} searchable={false}
          options={[{ value: 'all', label: 'All Types' }, { value: 'access', label: 'Access' }, { value: 'bypass', label: 'Bypass' }]} /></div>
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton active={!!search || status !== 'all' || kindF !== 'all'} onClear={() => { setSearch(''); setStatus('all'); setKindF('all'); }} />
        {pendingCount > 0 && <span className="text-sm text-nb-gray-500">{pendingCount} pending</span>}
      </div>

      {!filtered.length ? (
        <EmptyState title="No Matching Requests" hint="Try a different search or status filter." icon={<Inbox size={22} />} />
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <THead>
                <SortTh label="Requester" sortKey="requester" state={state} />
                <SortTh label="Type" sortKey="type" state={state} />
                <SortTh label="Wants Access To" sortKey="wants" state={state} />
                <SortTh label="For" sortKey="for" state={state} />
                <SortTh label="Reason" sortKey="reason" state={state} />
                <SortTh label="Asked" sortKey="asked" state={state} />
                <SortTh label="Status" sortKey="status" state={state} />
              </THead>
              <TBody>
                {pageRows.map((r) => (
                  <Tr key={r.id} onClick={() => setReview(r)}>
                    <Td>
                      <div className="font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate max-w-[180px]">{r.requesterName}</div>
                      {r.requesterEmail && <div className="text-[0.76rem] text-nb-gray-500 truncate max-w-[180px]">{r.requesterEmail}</div>}
                    </Td>
                    <Td>
                      <span className="inline-flex flex-col items-start gap-1">
                        {r.kind === 'bypass'
                          ? <Badge tone="cyan">{r.extendBypass ? 'Bypass Extension' : 'Bypass'}</Badge>
                          : <Badge tone="gray">Access</Badge>}
                        {r.kind === 'bypass' && r.tempDevice && <Badge tone="orange">Temp Device</Badge>}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <TargetChips targets={r.targets} />
                      </div>
                    </Td>
                    <Td>
                      <span className="text-sm text-nb-gray-600 dark:text-nb-gray-300 whitespace-nowrap">{forLabel(r)}</span>
                      {forDiffers(r) && <span className="block text-[0.72rem] text-nb-gray-500 whitespace-nowrap">Requested {r.requestedMinutes ? durLabel(r.requestedMinutes) : '-'}</span>}
                    </Td>
                    <Td><span className="text-sm text-nb-gray-500 truncate max-w-[200px] inline-block align-bottom">{r.reason || '-'}</span></Td>
                    <Td><span className="text-sm text-nb-gray-500 whitespace-nowrap">{formatMaybeDate(r.createdAt)}</span></Td>
                    <Td>
                      <span className="inline-flex flex-col gap-0.5">
                        <Badge tone={STATUS_TONE[r.status]}>{ucLabel(r.status)}</Badge>
                        {r.status !== 'pending' && r.decidedBy && <span className="text-[0.7rem] text-nb-gray-400">by {r.decidedBy}</span>}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: cards instead of the wide table */}
          <div className="md:hidden flex flex-col gap-2.5">
            {pageRows.map((r) => (
              <div key={r.id} onClick={() => setReview(r)}
                className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{r.requesterName}</div>
                    {r.requesterEmail && <div className="text-[0.76rem] text-nb-gray-500 truncate">{r.requesterEmail}</div>}
                  </div>
                  <span className="shrink-0 inline-flex flex-col items-end gap-0.5">
                    <Badge tone={STATUS_TONE[r.status]}>{ucLabel(r.status)}</Badge>
                    {r.status !== 'pending' && r.decidedBy && <span className="text-[0.7rem] text-nb-gray-400">by {r.decidedBy}</span>}
                  </span>
                </div>
                <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                  {r.kind === 'bypass'
                    ? <Badge tone="cyan">{r.extendBypass ? 'Bypass Extension' : 'Bypass'}</Badge>
                    : <Badge tone="gray">Access</Badge>}
                  {r.kind === 'bypass' && r.tempDevice && <Badge tone="orange">Temp Device</Badge>}
                  <TargetChips targets={r.targets} />
                </div>
                {r.reason && <div className="mt-2 text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300 break-words">{r.reason}</div>}
                <div className="mt-2 text-[0.76rem] text-nb-gray-500">
                  {formatMaybeDate(r.createdAt)}
                  {forLabel(r) !== '-' ? <> · For: {forLabel(r)}{forDiffers(r) ? ` (requested ${r.requestedMinutes ? durLabel(r.requestedMinutes) : '-'})` : ''}</> : null}
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="requests" />
        </>
      )}

      {review && <ReviewModal request={review} onClose={() => setReview(null)} />}
    </div>
  );
}

function DeviceKV({ label, value, mono, dot }: { label: string; value: string; mono?: boolean; dot?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 min-w-0">
      <span className="shrink-0 text-nb-gray-500">{label}</span>
      <span title={value} className={cn('min-w-0 truncate text-right text-nb-gray-800 dark:text-nb-gray-100', mono && 'font-mono text-[0.78rem]')}>
        {dot !== undefined && <span className={cn('inline-block h-2 w-2 rounded-full mr-1.5 align-middle', dot ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />}
        {value}
      </span>
    </div>
  );
}

function ReviewModal({ request, onClose }: { request: AccessRequest; onClose: () => void }) {
  const approve = useApproveRequest();
  const deny = useDenyRequest();
  const [duration, setDuration] = useState<DurationState>(durationFromMinutes(request.requestedMinutes));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const pending = request.status === 'pending';
  const busy = approve.isPending || deny.isPending;
  const isBypass = request.kind === 'bypass';
  // How long an approved bypass lasts before the scheduler auto-revokes it (0 = unlimited).
  // Defaults to the requester's proposed duration; a proposal outside the presets gets its
  // own "As Requested" entry so it stays selectable.
  const [bypassMinutes, setBypassMinutes] = useState(request.requestedMinutes > 0 ? request.requestedMinutes : 1440);
  // The approver may adjust WHAT is granted (add/remove targets) before approving.
  const [targets, setTargets] = useState<GrantTarget[]>(request.targets || []);
  // Live device context for bypass requests, so the approver decides without hunting for info.
  const allPeers = usePeers(isBypass).data || [];
  const device = isBypass ? allPeers.find((p) => p.id === request.targets[0]?.id) : undefined;

  const doApprove = async () => {
    // A device bypass: approve + optionally schedule the auto-revoke.
    if (isBypass) {
      setError('');
      try { await approve.mutateAsync({ id: request.id, payload: bypassMinutes > 0 ? { durationMinutes: bypassMinutes } : {} }); onClose(); }
      catch (e) { setError('Failed: ' + (e as Error).message); }
      return;
    }
    const dp = durationPayload(duration);
    if (!dp) { setError('Set a valid future expiry.'); return; }
    if (!targets.length) { setError('Add at least one target - or deny the request.'); return; }
    setError('');
    try { await approve.mutateAsync({ id: request.id, payload: { ...dp, targets } }); onClose(); }
    catch (e) { setError('Failed: ' + (e as Error).message); }
  };
  const doDeny = async () => {
    setError('');
    try { await deny.mutateAsync({ id: request.id, reason: reason.trim() }); onClose(); }
    catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} size={isBypass || pending ? 'lg' : 'md'} icon={<Inbox size={18} />}
      title={isBypass ? (request.extendBypass ? 'Bypass Extension Request' : 'Device Bypass Request') : 'Access Request'}
      subtitle={`From ${request.requesterName}`}
      footer={pending ? (
        <>
          <Button variant="danger" size="sm" className="mr-auto" onClick={doDeny} disabled={busy}>{deny.isPending ? '…' : 'Deny'}</Button>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={doApprove} disabled={busy}>{approve.isPending ? '…' : isBypass ? 'Approve Device' : 'Approve & Grant'}</Button>
        </>
      ) : <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-4">
        {isBypass && pending && (
          <p className="text-sm text-nb-gray-600 dark:text-nb-gray-300">
            {request.extendBypass
              ? <>The device already has a <b>timed bypass</b> and the requester asks for more time. Approving restarts the bypass with the duration you pick below.</>
              : <>The requester's device failed compliance checks. Approving <b>bypasses</b> it in NetBird so it can connect despite the failing checks.</>}
          </p>
        )}

        {/* Full device context - decide without hunting for info elsewhere. */}
        {isBypass && (
          <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-3">
            <div className="flex items-center gap-2 text-[0.8rem] font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-2">
              <MonitorSmartphone size={14} className="text-nb-gray-400" /> Device Details
            </div>
            {!device ? (
              <p className="text-[0.82rem] text-nb-gray-500">Device not found - it may have been removed from NetBird.</p>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-[0.82rem]">
                  <DeviceKV label="Status" value={device.connected ? 'Online' : `Offline · last seen ${formatMaybeDate(device.last_seen) || 'never'}`} dot={device.connected} />
                  <DeviceKV label="OS" value={device.os || '-'} />
                  <DeviceKV label="Agent Version" value={device.version || '-'} />
                  <DeviceKV label="Public IP" value={device.connection_ip || '-'} mono />
                  <DeviceKV label="Location" value={device.geo || '-'} />
                  <DeviceKV label="Last Login" value={formatMaybeDate(device.last_login) || '-'} />
                  {request.extendBypass && <DeviceKV label="Current Bypass Ends" value={formatMaybeDate(device.bypass_expires_at || '') || '-'} />}
                </div>
                {(device.groups || []).length > 0 && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[0.74rem] text-nb-gray-500">Groups:</span>
                    {(device.groups || []).slice(0, 6).map((g) => {
                      const name = typeof g === 'string' ? g : (g as { name?: string }).name || '';
                      return <Badge key={name} tone="gray">{name}</Badge>;
                    })}
                    {(device.groups || []).length > 6 && <span className="text-[0.72rem] text-nb-gray-400">+{(device.groups || []).length - 6} more</span>}
                  </div>
                )}
                {device.disapproval_reason && (
                  <p className="mt-2.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[0.8rem] text-amber-600 dark:text-amber-400">
                    <b>Why it's blocked:</b> {device.disapproval_reason}
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {(() => {
          const requesterCard = (
            <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-3 text-sm flex flex-col gap-2">
              <div><span className="text-nb-gray-500">Requester: </span><span className="text-nb-gray-800 dark:text-nb-gray-100">{request.requesterName}</span>{request.requesterEmail && <span className="text-nb-gray-500"> ({request.requesterEmail})</span>}</div>
              {/* Pending access requests get the EDITABLE targets field instead. Approved ones
                  show what was ACTUALLY granted (the approver may have adjusted the list). */}
              {(isBypass || !pending) && (() => {
                const granted = request.status === 'approved' && request.approvedTargets?.length ? request.approvedTargets : request.targets;
                const dropped = request.status === 'approved' && request.approvedTargets?.length
                  ? request.targets.filter((t) => !request.approvedTargets!.some((a) => a.type === t.type && a.id === t.id))
                  : [];
                return (
                  <>
                    <div className="flex items-start gap-2"><span className="text-nb-gray-500 shrink-0">{isBypass ? 'Device: ' : request.status === 'approved' ? 'Granted: ' : 'Access to: '}</span><TargetChips targets={granted} /></div>
                    {dropped.length > 0 && (
                      <div className="text-[0.78rem] text-amber-600 dark:text-amber-400">Requested but not granted: {dropped.map((t) => t.name || t.id).join(', ')}</div>
                    )}
                  </>
                );
              })()}
              {request.reason && <div><span className="text-nb-gray-500">Reason: </span><span className="text-nb-gray-700 dark:text-nb-gray-200">{request.reason}</span></div>}
              <div>
                {(!isBypass || request.requestedMinutes > 0) && <><span className="text-nb-gray-500">Requested: </span><span className="text-nb-gray-700 dark:text-nb-gray-200">{request.requestedMinutes ? durLabel(request.requestedMinutes) : 'unspecified'}</span> · </>}
                <span className="text-nb-gray-500">{formatMaybeDate(request.createdAt)}</span>
              </div>
            </div>
          );
          const denyField = (
            <Field label="Deny Reason (Optional)" hint="Shown to the requester if you deny."><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this denied?" /></Field>
          );

          // Pending ACCESS requests: two columns (what is granted | for how long / deny) so
          // everything fits without the modal scrolling.
          if (!isBypass && pending) {
            return (
              <div className="grid md:grid-cols-2 gap-x-5 gap-y-4 items-start">
                <div className="flex flex-col gap-4">
                  {requesterCard}
                  <Field label="Granted Targets" hint="Prefilled with the request - remove or add targets; removed items are simply not granted.">
                    <TargetSearch chosen={targets} onPick={(t) => setTargets((p) => [...p, t])} />
                    {targets.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {targets.map((t, i) => {
                          const requestedIt = (request.targets || []).some((r) => r.type === t.type && r.id === t.id);
                          return (
                            <span key={`${t.type}-${t.id}`} className={cn('inline-flex items-center gap-1.5 rounded-md border pl-2 pr-1 py-1 text-[0.78rem]',
                              requestedIt ? 'border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900' : 'border-netbird/40 bg-netbird/[0.06]')}>
                              <span className="text-nb-gray-400">{TARGET_META[t.type].icon}</span>
                              <span className="text-nb-gray-700 dark:text-nb-gray-200">{t.name}</span>
                              {!requestedIt && <span className="text-[0.65rem] uppercase tracking-wide text-netbird">added</span>}
                              <button type="button" onClick={() => setTargets((p) => p.filter((_, idx) => idx !== i))} className="text-nb-gray-400 hover:text-red-500"><X size={12} /></button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {(request.targets || []).some((r) => !targets.some((t) => t.type === r.type && t.id === r.id)) && (
                      <p className="mt-1.5 text-[0.78rem] text-amber-600 dark:text-amber-400">
                        Removed from the request: {(request.targets || []).filter((r) => !targets.some((t) => t.type === r.type && t.id === r.id)).map((r) => r.name || r.id).join(', ')}
                      </p>
                    )}
                  </Field>
                </div>
                <div className="flex flex-col gap-4">
                  <Field label="Duration" hint="Prefilled with the requested length - adjust as needed."><DurationControl value={duration} onChange={setDuration} /></Field>
                  {denyField}
                </div>
              </div>
            );
          }
          return (
            <>
              {requesterCard}
              {pending ? (
                <>
                  {request.tempDevice && (
                    <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[0.8rem] text-amber-600 dark:text-amber-400">
                      <b>Temporary Device</b> - when the bypass duration ends, the device is <b>deleted</b> from NetBird
                      automatically (not just blocked). An unlimited bypass is therefore not available.
                    </p>
                  )}
                  <Field label="Bypass Duration" hint={request.tempDevice
                    ? 'When this passes the device is DELETED from NetBird automatically.'
                    : 'The bypass is revoked automatically when this passes - the device is blocked again until compliant. Unlimited = until removed manually or the device becomes compliant.'}>
                    <SelectMenu value={String(bypassMinutes)} onChange={(v) => setBypassMinutes(Number(v))} searchable={false}
                      options={[
                        ...(request.requestedMinutes > 0 && ![60, 240, 480, 1440, 4320].includes(request.requestedMinutes)
                          ? [{ value: String(request.requestedMinutes), label: `As Requested (${durLabel(request.requestedMinutes)})` }] : []),
                        { value: '60', label: '1 Hour' }, { value: '240', label: '4 Hours' }, { value: '480', label: '8 Hours' },
                        { value: '1440', label: '24 Hours' }, { value: '4320', label: '3 Days' },
                        ...(request.tempDevice ? [] : [{ value: '0', label: 'Unlimited' }]),
                      ]} />
                  </Field>
                  {denyField}
                </>
              ) : (
                <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-3 text-sm flex flex-col gap-2">
                  <div className="inline-flex items-center gap-2"><span className="text-nb-gray-500">Status: </span><Badge tone={STATUS_TONE[request.status]}>{ucLabel(request.status)}</Badge></div>
                  {request.decidedBy && (
                    <div>
                      <span className="text-nb-gray-500">By: </span><span className="text-nb-gray-700 dark:text-nb-gray-200">{request.decidedBy}</span>
                      {request.decidedAt && <span className="text-nb-gray-500"> · {formatMaybeDate(request.decidedAt)}</span>}
                      {request.decidedVia && <span className="text-nb-gray-500"> · via {request.decidedVia}</span>}
                    </div>
                  )}
                  {request.status === 'approved' && request.approvedMinutes != null && (
                    <div>
                      <span className="text-nb-gray-500">Granted: </span>
                      <span className="text-nb-gray-700 dark:text-nb-gray-200">{request.approvedMinutes === 0 ? 'Unlimited' : durLabel(request.approvedMinutes)}</span>
                      {request.approvedMinutes !== (request.requestedMinutes || 0) && request.requestedMinutes > 0 && (
                        <span className="text-nb-gray-500"> · requested {durLabel(request.requestedMinutes)}</span>
                      )}
                    </div>
                  )}
                  {request.decisionNote && <div><span className="text-nb-gray-500">Note: </span><span className="text-nb-gray-700 dark:text-nb-gray-200">{request.decisionNote}</span></div>}
                </div>
              )}
            </>
          );
        })()}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
