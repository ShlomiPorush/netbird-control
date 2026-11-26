import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { formatTimestamp } from '@/lib/logfmt';
import { remoteApi, type CreatedResourceState, type RemoteAccessConfig, type RemoteAccessStatus } from '@/lib/remoteAccess';
import { Badge, Card, LoadingState } from '@/components/ui';
import { cn } from '@/lib/cn';

const CREATED_STATES: Record<CreatedResourceState, { label: string; tone: string }> = {
  creating: { label: 'Creating', tone: 'text-nb-gray-500' },
  unknown: { label: 'Unconfirmed', tone: 'text-amber-600 dark:text-amber-400' },
  created: { label: 'Active', tone: 'text-green-600 dark:text-green-500' },
  kept: { label: 'Kept', tone: 'text-amber-600 dark:text-amber-400' },
  failed: { label: 'Failed', tone: 'text-nb-gray-500' },
  deleted: { label: 'Removed', tone: 'text-nb-gray-500' },
  gone: { label: 'Gone', tone: 'text-nb-gray-500' },
};
const CREATED_REASON_STATES: CreatedResourceState[] = ['kept', 'unknown', 'failed', 'gone'];
const IN_USE_STATES: CreatedResourceState[] = ['creating', 'unknown', 'created', 'kept'];
const createdCols = 'grid grid-cols-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_11rem_minmax(0,1fr)] gap-x-3 gap-y-1.5';
const groupLabel = 'text-[0.75rem] font-semibold uppercase tracking-wide text-nb-gray-500';

export function StatusLine({ ok, warn, label, detail }: { ok: boolean | null; warn?: boolean; label: string; detail?: ReactNode }) {
  const icon = ok === null ? <AlertTriangle size={16} className="text-nb-gray-400" />
    : ok ? <CheckCircle2 size={16} className="text-green-500" />
      : warn ? <AlertTriangle size={16} className="text-amber-500" /> : <XCircle size={16} className="text-red-500" />;
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">{label}</div>
        {detail && <div className="text-[0.8rem] text-nb-gray-500 dark:text-nb-gray-400 break-words">{detail}</div>}
      </div>
    </div>
  );
}

export function gatewaysSummary(st: RemoteAccessStatus): { ok: boolean | null; warn: boolean; label: string } {
  const problems = !!(st.reachError || st.domainRoutes.length || st.extraReach.length || st.names.reachError || st.names.extraReach.length
    || st.conflicts.length || st.membership?.removed.length || st.membership?.error || st.error || st.lastApply.error);
  if (!st.gateway.enrolled) return { ok: false, warn: true, label: 'Gateway Not Enrolled' };
  const ipOk = st.gateway.online && !!st.guacdReachable;
  const namesOk = !st.names.gateway.enrolled || (st.names.gateway.online && !!st.names.guacdReachable);
  if (ipOk && namesOk && !problems) return { ok: true, warn: false, label: 'Gateways Online' };
  return { ok: false, warn: ipOk, label: ipOk ? 'Needs Attention' : 'Gateway Offline' };
}

function Tile({ label, value, sub, warn }: { label: string; value: ReactNode; sub?: ReactNode; warn?: boolean }) {
  return (
    <div className={cn('rounded-lg border p-3.5 bg-white dark:bg-nb-gray-950', warn ? 'border-amber-500/40' : 'border-nb-gray-200 dark:border-nb-gray-800')}>
      <div className="text-[0.74rem] uppercase tracking-wide text-nb-gray-500">{label}</div>
      <div className={cn('mt-1 text-lg font-semibold', warn ? 'text-amber-600 dark:text-amber-400' : 'text-nb-gray-900 dark:text-nb-gray-50')}>{value}</div>
      {sub && <div className="mt-0.5 text-[0.76rem] text-nb-gray-500">{sub}</div>}
    </div>
  );
}

function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="mb-1 flex items-center gap-2 text-sm font-bold tracking-tight text-nb-gray-800 dark:text-nb-gray-100">
      {children}{count !== undefined && <Badge tone="gray">{count}</Badge>}
    </div>
  );
}

function Gateways({ st, cfg }: { st: RemoteAccessStatus; cfg: RemoteAccessConfig }) {
  return (
    <Card className="p-4">
      <SectionTitle>Gateways</SectionTitle>
      <div className={cn(groupLabel, 'mt-1')}>IP Gateway</div>
      <StatusLine ok={st.gateway.enrolled && st.gateway.online} warn={st.gateway.enrolled}
        label={!st.gateway.enrolled ? 'Gateway Not Enrolled' : st.gateway.online ? 'Gateway Online' : 'Gateway Offline'}
        detail={st.gateway.enrolled ? st.gateway.peers.map((p) => `${p.name}${p.connected ? '' : ' (offline)'}`).join(', ') : 'Create a setup key in Settings → Remote Access and start the gateway containers.'} />
      <StatusLine ok={st.guacdReachable} label={st.guacdReachable ? 'guacd Reachable' : 'guacd Not Reachable'}
        detail={st.guacdReachable ? `${cfg.guacdHost}:${cfg.guacdPort}` : `No answer from ${cfg.guacdHost}:${cfg.guacdPort}. Are the gateway containers running (netbird-docker-compose-files/docker-compose-remote-access.yml)?`} />
      {st.reachError && <StatusLine ok={false} label="Unreadable Policy Blocks Every Session" detail={st.reachError} />}
      {st.domainRoutes.length > 0 && (
        <StatusLine ok={false} label="Domain Routes Block Every Session"
          detail={`The gateway receives domain-based routes (${st.domainRoutes.slice(0, 4).map((d) => d.name || d.address).join(', ')}). They can't be bounded to addresses, so all sessions are refused. Change those policies' or routes' groups so they don't include the gateway (often the All group).`} />
      )}
      {st.extraReach.length > 0 && (
        <StatusLine ok={false} warn label="The Gateway Reaches More Than You Selected"
          detail={`Other policies or routes give the gateway access to ${st.extraReach.slice(0, 5).map((e) => `${e.name} (${e.address})`).join(', ')}${st.extraReach.length > 5 ? ` and ${st.extraReach.length - 5} more` : ''}. Sessions still need each user's own access, but a compromised gateway could reach these too. Usually caused by policies whose source is All.`} />
      )}
      <div className={cn(groupLabel, 'mt-3')}>Names Gateway (Optional)</div>
      <StatusLine ok={st.names.gateway.enrolled ? st.names.gateway.online : null} warn={st.names.gateway.enrolled}
        label={!st.names.gateway.enrolled ? 'Not Enrolled - Host Names Of Domain Resources Are Refused' : st.names.gateway.online ? 'Gateway Online' : 'Gateway Offline'}
        detail={st.names.gateway.enrolled ? st.names.gateway.peers.map((p) => `${p.name}${p.connected ? '' : ' (offline)'}`).join(', ') : 'Optional. Create a names gateway setup key in Settings → Remote Access and start it with the remote-names profile.'} />
      {st.names.gateway.enrolled && (
        <StatusLine ok={st.names.guacdReachable} label={st.names.guacdReachable ? 'guacd Reachable' : 'guacd Not Reachable'}
          detail={st.names.guacdReachable ? `${cfg.namesGuacdHost}:${cfg.namesGuacdPort}` : `No answer from ${cfg.namesGuacdHost}:${cfg.namesGuacdPort}. Is the names gateway running (profile remote-names)?`} />
      )}
      {st.names.reachError && <StatusLine ok={false} label="Unreadable Policy Blocks Connecting By Name" detail={st.names.reachError} />}
      {st.names.extraReach.length > 0 && (
        <StatusLine ok={false} label="Address Routes Block Connecting By Name"
          detail={`The names gateway receives address routes (${st.names.extraReach.slice(0, 5).map((e) => `${e.name} (${e.address})`).join(', ')}${st.names.extraReach.length > 5 ? ` and ${st.names.extraReach.length - 5} more` : ''}). One of them could capture the address a name resolves to, so connecting by name is refused. Usually caused by policies whose source is All.`} />
      )}
      {st.conflicts.length > 0 && (
        <StatusLine ok={false} warn label="Address Conflicts In The Selected Networks"
          detail={<>The same address is a resource in more than one network: {st.conflicts.slice(0, 4).map((c) => `${c.address} (${c.networks.join(', ')})`).join('; ')}{st.conflicts.length > 4 ? ` and ${st.conflicts.length - 4} more` : ''}. Sessions to such an address are refused while the gateways can reach more than one of them. Fix it on the <Link className="text-netbird hover:underline" to="/networks">Networks</Link> page.</>} />
      )}
      {st.membership && st.membership.removed.length > 0 && (
        <StatusLine ok={false} warn label="Members Added Outside NetBird Control Were Removed"
          detail={`${st.membership.removed.slice(0, 5).map((r) => `${r.kind === 'user' ? 'User' : 'Device'} ${r.name} from ${r.group} (${formatTimestamp(r.at)})`).join('; ')}. Only the gateways belong in these groups. A gateway enrolled by signing in as a user is removed too: enroll it again with a setup key.`} />
      )}
      {st.membership?.error && <StatusLine ok={false} label="Couldn't Remove A Member Added Outside NetBird Control" detail={`${st.membership.error} It is tried again on the next read from NetBird.`} />}
      {(st.error || st.lastApply.error) && <StatusLine ok={false} label="Problem" detail={st.error || st.lastApply.error} />}
    </Card>
  );
}

function OpenedServers({ st }: { st: RemoteAccessStatus }) {
  const held = st.held || [];
  return (
    <Card className="p-4">
      <SectionTitle count={held.length}>Opened Servers</SectionTitle>
      {held.length === 0
        ? <div className="text-[0.8rem] text-nb-gray-500 py-1.5">None right now. A server opens to its gateway when someone starts a session to it.</div>
        : (
          <ul className="flex flex-col py-1">
            {held.map((h) => (
              <li key={h.resourceId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-sm border-t border-nb-gray-100 dark:border-nb-gray-900 first:border-t-0">
                <span className="min-w-0 break-words text-nb-gray-800 dark:text-nb-gray-100">
                  {h.name}{h.name !== h.address && <span className="text-nb-gray-500"> ({h.address})</span>}
                  <span className="text-[0.78rem] text-nb-gray-500"> - {h.network}</span>
                </span>
                <span className={h.inUse ? 'text-[0.78rem] font-medium text-green-600 dark:text-green-500' : 'text-[0.78rem] text-nb-gray-500'}>
                  {h.inUse ? 'In Use' : `Until ${formatTimestamp(h.expiresAt)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}

function LaunchServers() {
  const createdQ = useQuery({ queryKey: ['remote-access-created'], queryFn: remoteApi.createdResources, refetchInterval: 30000 });
  const created = createdQ.data;
  return (
    <Card className="p-4">
      <SectionTitle count={created?.items.length}>Servers Added By Launch Links</SectionTitle>
      {createdQ.isLoading ? <div className="text-[0.8rem] text-nb-gray-500 py-1.5">Loading…</div>
        : !created ? <div className="text-sm text-red-500 py-1.5">The list could not be loaded.</div>
          : created.items.length === 0 ? <div className="text-[0.8rem] text-nb-gray-500 py-1.5">None yet.</div>
            : (
              <div>
                <div className={`${createdCols} hidden sm:grid py-1.5 text-[0.72rem] font-medium uppercase tracking-wide text-nb-gray-500`}>
                  <span>Address</span><span>Name</span><span>Added</span><span>State</span>
                </div>
                <ul>
                  {created.items.map((it) => {
                    const state = CREATED_STATES[it.state] || { label: it.state, tone: 'text-nb-gray-500' };
                    const cellLabel = 'sm:hidden block text-[0.7rem] uppercase tracking-wide text-nb-gray-500';
                    return (
                      <li key={it.id} className={`${createdCols} py-2 border-t border-nb-gray-100 dark:border-nb-gray-900 text-sm`}>
                        <div className="min-w-0">
                          <span className={cellLabel}>Address</span>
                          <span className="font-mono text-[0.82rem] break-all text-nb-gray-800 dark:text-nb-gray-100" title={it.resourceName || undefined}>{it.address}</span>
                        </div>
                        <div className="min-w-0">
                          <span className={cellLabel}>Name</span>
                          <span className="break-words text-nb-gray-700 dark:text-nb-gray-200">{it.name || '-'}</span>
                        </div>
                        <div className="min-w-0">
                          <span className={cellLabel}>Added</span>
                          <span className="text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-400">{it.createdAt ? formatTimestamp(it.createdAt) : '-'}</span>
                        </div>
                        <div className="min-w-0">
                          <span className={cellLabel}>State</span>
                          <span className={`text-[0.8rem] font-medium ${state.tone}`}>{state.label}</span>
                          {CREATED_REASON_STATES.includes(it.state) && it.reason && (
                            <span className="block text-[0.76rem] text-nb-gray-500 break-words">{it.reason}</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {created.finishedMore && <div className="pt-2 text-[0.76rem] text-nb-gray-500">Only the latest 50 finished entries are shown.</div>}
              </div>
            )}
    </Card>
  );
}

export function RemoteAccessOps() {
  const cfgQ = useQuery({ queryKey: ['remote-access-config'], queryFn: remoteApi.config });
  const statusQ = useQuery({ queryKey: ['remote-access-status'], queryFn: remoteApi.status, refetchInterval: 30000 });
  const createdQ = useQuery({ queryKey: ['remote-access-created'], queryFn: remoteApi.createdResources, refetchInterval: 30000 });
  if (cfgQ.isLoading || statusQ.isLoading) return <LoadingState />;
  const cfg = cfgQ.data;
  const st = statusQ.data;
  if (!cfg || !st) return <p className="text-sm text-red-500">The Remote Access status could not be loaded.</p>;
  const summary = gatewaysSummary(st);
  const launchInUse = (createdQ.data?.items || []).filter((i) => IN_USE_STATES.includes(i.state)).length;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-nb-gray-500 text-sm">The Browser Gateways' health, what they have open right now, and the servers launch links added. Remote Access is set up in Settings → Remote Access.</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Remote Access" value={cfg.enabled ? 'On' : 'Off'} />
        <Tile label="Gateways" value={summary.ok ? 'Online' : summary.label} warn={!summary.ok} />
        <Tile label="Active Sessions" value={String(st.activeSessions)} />
        <Tile label="Launch Link Servers" value={String(launchInUse)} sub="in use now" />
      </div>
      <Gateways st={st} cfg={cfg} />
      <OpenedServers st={st} />
      <LaunchServers />
    </div>
  );
}
