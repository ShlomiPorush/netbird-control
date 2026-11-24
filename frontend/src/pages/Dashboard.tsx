import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MonitorSmartphone, Users as UsersIcon, Network as NetworkIcon, Shield, Inbox, Clock,
  AlertTriangle, Workflow, KeyRound, CheckCircle2, ChevronRight, Layers3, Activity as ActivityIcon, X, Home,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useViewer } from '@/contexts/ViewerContext';
import {
  usePeers, useUsers, useNetworks, usePolicies, useAccessRequests, useMyAccessRequests,
  useTemporaryAccessGrants, useAutomations, useAuditLog, useHourlyStats, useReverseProxyStatus, useResourceConflicts, useBillingSummary, useDiagNotices, type HourlyStat,
} from '@/lib/queries';
import { useDismissNbNotice } from '@/lib/mutations';
import { getTenantMode } from '@/lib/api';
import { formatTimestamp, formatMaybeDate } from '@/lib/logfmt';
import { ucLabel } from '@/lib/str';
import { Badge, Card, LinkButton, PageHeader } from '@/components/ui';
import { TargetChips } from '@/components/access/targets';
import { CloudStatusBanner } from '@/components/admin/CloudStatus';
import { ACTION_LABELS } from '@/pages/Admin';

/** Home: an overview dashboard. Admins get fleet health + "needs attention" + recent activity;
 *  a restricted user gets a personal view (their devices, their requests, their traffic). */
export default function Dashboard() {
  const { restricted } = useViewer();
  return restricted ? <PersonalDashboard /> : <AdminDashboard />;
}

/* ─── Shared pieces ─── */

const ROW = 'flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors';
const ROW_NEUTRAL = 'border-nb-gray-100 dark:border-nb-gray-900 hover:border-netbird/40 dark:hover:border-netbird/40';
const ROW_DANGER = 'border-red-500/30 bg-red-500/5 hover:border-red-500/60';

function StatTile({ icon, label, value, sub, to }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; to?: string;
}) {
  const body = (
    <Card hoverable={!!to} className="p-3 md:p-4 h-full">
      <div className="flex items-start gap-1.5 md:gap-2 text-[0.76rem] md:text-[0.8rem] leading-4 font-medium text-nb-gray-500 dark:text-nb-gray-400 min-w-0">
        <span className="text-netbird shrink-0 mt-px">{icon}</span><span className="min-w-0 break-words">{label}</span>
      </div>
      <div className="mt-1.5 text-xl md:text-2xl font-semibold tracking-tight text-nb-gray-900 dark:text-nb-gray-50 tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[0.74rem] text-nb-gray-500 truncate">{sub}</div>}
    </Card>
  );
  return to ? <Link to={to} className="block h-full">{body}</Link> : body;
}

function Section({ title, action, children, className }: {
  title: string; action?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <Card className={cn('p-4 md:p-5', className)}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-base font-bold tracking-tight text-nb-gray-900 dark:text-nb-gray-50 min-w-0 truncate">{title}</h2>
        <span className="shrink-0">{action}</span>
      </div>
      {children}
    </Card>
  );
}

const seeAll = (to: string) => (
  <Link to={to} className="inline-flex items-center gap-0.5 text-[0.8rem] text-netbird hover:underline">
    See all <ChevronRight size={13} />
  </Link>
);

/** Events-per-hour bar chart. Single series in the validated netbird-600 (#e55311 - passes the
 *  lightness/chroma/contrast checks on both light & dark surfaces); thin bars with 2px surface
 *  gaps and rounded data-ends, a per-bar hover tooltip, and a recessive axis. */
function HourlyChart({ data }: { data: HourlyStat[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.count), 1);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (!data.length || total === 0) {
    return <p className="py-10 text-center text-sm text-nb-gray-500">No traffic events in the last 24 hours.</p>;
  }
  const hourLabel = (iso: string) => `${String(new Date(iso).getHours()).padStart(2, '0')}:00`;
  return (
    <div>
      <div className="flex items-baseline justify-between text-[0.72rem] text-nb-gray-500 mb-1.5">
        <span>{total.toLocaleString()} events · 24h</span>
        <span>peak {max.toLocaleString()}</span>
      </div>
      <div className="relative">
        <div className="flex items-end gap-[2px] h-36 border-b border-nb-gray-200 dark:border-nb-gray-800">
          {data.map((d, i) => (
            <div key={d.hour} className="relative flex-1 h-full flex items-end cursor-default"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <div
                className="w-full rounded-t-[3px] transition-opacity"
                style={{
                  height: d.count ? `${Math.max((d.count / max) * 100, 2)}%` : '0%',
                  backgroundColor: '#e55311',
                  opacity: hover === null || hover === i ? 1 : 0.45,
                }}
              />
            </div>
          ))}
        </div>
        {hover !== null && (
          <div
            className="absolute -top-2 -translate-y-full -translate-x-1/2 z-10 whitespace-nowrap rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl px-2.5 py-1.5 text-[0.75rem]"
            style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}
          >
            <span className="text-nb-gray-500">{formatTimestamp(data[hover].hour)}</span>
            <span className="ml-2 font-semibold text-nb-gray-900 dark:text-nb-gray-100 tabular-nums">{data[hover].count.toLocaleString()}</span>
            <span className="ml-1 text-nb-gray-500">events</span>
          </div>
        )}
      </div>
      <div className="mt-1 flex text-[0.65rem] text-nb-gray-400">
        {data.map((d, i) => (
          <span key={d.hour} className="flex-1 text-center">{i % 6 === 0 ? hourLabel(d.hour) : ''}</span>
        ))}
      </div>
    </div>
  );
}

/* ─── Admin dashboard ─── */

function AdminDashboard() {
  const { canApprove, isAdmin } = useViewer();
  // Access requests are a main-account feature (customers have no app login) - don't fire the
  // request query in tenant mode (its route is main-only → 403). Billing + notices stay: they
  // are per-tenant. Peers/users/networks/grants/automations/conflicts all run in tenant context.
  const inTenant = !!getTenantMode();
  const dismissNotice = useDismissNbNotice();
  const peers = usePeers().data || [];
  const users = useUsers().data || [];
  const networks = useNetworks().data || [];
  const policies = usePolicies().data || [];
  const requests = useAccessRequests(undefined, canApprove && !inTenant).data || [];
  const grants = useTemporaryAccessGrants().data || [];
  const automations = useAutomations().data || [];
  const audit = useAuditLog({ page: 1, per_page: 5 }).data?.events || [];
  const hourly = useHourlyStats(24).data || [];
  const rproxy = useReverseProxyStatus().data;

  const online = peers.filter((p) => p.connected).length;
  // Servers vs end-user devices - the SAME classification the Peers page tabs use (peer.kind).
  const servers = peers.filter((p) => p.kind === 'server');
  const endUsers = peers.filter((p) => p.kind !== 'server');
  const serversOnline = servers.filter((p) => p.connected).length;
  const endUsersOnline = endUsers.filter((p) => p.connected).length;
  const resourceCount = networks.reduce((s, n) => s + (n.resources || 0), 0);
  const humanUsers = users.filter((u) => !u.is_service_user).length;
  const billed = useBillingSummary().data?.billedUsers;
  const pending = requests.filter((r) => r.status === 'pending');
  const activeGrants = grants.filter((g) => g.status === 'active');

  // "Needs attention" - the things an admin actually opens the app for.
  const expiring = useMemo(() => activeGrants.filter((g) => {
    const left = new Date(g.expiresAt).getTime() - Date.now();
    return left > 0 && left < 24 * 3600_000;
  }), [activeGrants]);
  const nonCompliant = peers.filter((p) => p.approval_required && !p.force_approved);
  const failedAutomations = automations.filter((a) => a.enabled && a.lastStatus === 'error');
  const conflicts = useResourceConflicts().data?.conflicts || [];
  // Still-relevant NetBird account notifications (routing peer down / integration issues).
  const nbNotices = useDiagNotices().data?.notices || [];
  const allClear = !pending.length && !expiring.length && !nonCompliant.length && !failedAutomations.length && !conflicts.length && !nbNotices.length;

  return (
    <div className="min-w-0">
      {/* Header + quick actions (top, where they're reachable - not buried at the bottom) */}
      <PageHeader title="Overview" icon={<Home size={19} />}
        description="A live snapshot of your NetBird network - what's healthy and what needs your attention."
        actions={<>
          {pending.length > 0 && (
            <LinkButton to="/access-requests" variant="primary" size="sm"><Inbox size={14} /> Review {pending.length} Request{pending.length === 1 ? '' : 's'}</LinkButton>
          )}
          <LinkButton to="/temporary-access" variant="secondary" size="sm"><Clock size={14} /> Grant Access</LinkButton>
          <LinkButton to="/networks" variant="secondary" size="sm"><Layers3 size={14} /> Add Resource</LinkButton>
        </>} />

      <CloudStatusBanner className="mb-6" />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
        <StatTile icon={<MonitorSmartphone size={14} />} label="Peers Online" value={<>{online}<span className="text-base font-normal text-nb-gray-400"> / {peers.length}</span></>}
          sub={`Servers ${serversOnline}/${servers.length} · End Users ${endUsersOnline}/${endUsers.length}`} to="/peers?status=online" />
        <StatTile icon={<UsersIcon size={14} />} label="Users" value={humanUsers} sub={billed != null ? `${billed} billed` : undefined} to="/users" />
        <StatTile icon={<NetworkIcon size={14} />} label="Networks" value={networks.length} sub={`${resourceCount} resources`} to="/networks" />
        <StatTile icon={<Shield size={14} />} label="Policies" value={policies.length} to="/policies" />
        {/* Access requests are main-only - hide the tile while managing a tenant. */}
        {!inTenant && <StatTile icon={<Inbox size={14} />} label="Pending Requests" value={pending.length} to="/access-requests" />}
        <StatTile icon={<Clock size={14} />} label="Active Grants" value={activeGrants.length} to="/temporary-access" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Needs attention */}
        <Section title="Needs Attention" action={pending.length > 0 ? seeAll('/access-requests') : undefined}>
          {allClear ? (
            <p className="flex items-center gap-2 py-6 justify-center text-sm text-nb-gray-500">
              <CheckCircle2 size={16} className="text-green-500" /> All clear - nothing waiting on you.
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {pending.slice(0, 4).map((r) => (
                <Link key={r.id} to="/access-requests" className={cn(ROW, ROW_NEUTRAL)}>
                  <Inbox size={15} className="shrink-0 text-netbird" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate">{r.requesterName}</span>
                    <span className="block text-[0.74rem] text-nb-gray-500 truncate">{r.targets.map((t) => t.name || t.id).join(', ')}</span>
                  </span>
                  <Badge tone="orange">Pending</Badge>
                </Link>
              ))}
              {expiring.slice(0, 3).map((g) => (
                <Link key={g.id} to="/temporary-access" className={cn(ROW, ROW_NEUTRAL)}>
                  <Clock size={15} className="shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate">{g.userLabel}</span>
                    <span className="block text-[0.74rem] text-nb-gray-500 truncate">Access expires {formatMaybeDate(g.expiresAt)}</span>
                  </span>
                  <Badge tone="cyan">Expiring</Badge>
                </Link>
              ))}
              {nonCompliant.slice(0, 3).map((p) => (
                <Link key={p.id} to={`/peers/${encodeURIComponent(p.id)}`} className={cn(ROW, ROW_NEUTRAL)}>
                  <AlertTriangle size={15} className="shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate">{p.name || p.dns_label || p.id}{p.owner_email ? ` · ${p.owner_email}` : ''}</span>
                    <span className="block text-[0.74rem] text-amber-600 dark:text-amber-400 truncate" title={p.disapproval_reason || undefined}>
                      {p.disapproval_reason ? `Blocked: ${p.disapproval_reason}` : 'Non-compliant - awaiting approval'}
                    </span>
                  </span>
                  <ChevronRight size={14} className="text-nb-gray-400" />
                </Link>
              ))}
              {nonCompliant.length > 3 && (
                <Link to="/peers" className={cn(ROW, ROW_NEUTRAL)}>
                  <AlertTriangle size={15} className="shrink-0 text-amber-500" />
                  <span className="flex-1 text-sm text-nb-gray-800 dark:text-nb-gray-100">+{nonCompliant.length - 3} more non-compliant device{nonCompliant.length - 3 === 1 ? '' : 's'}</span>
                  <ChevronRight size={14} className="text-nb-gray-400" />
                </Link>
              )}
              {conflicts.slice(0, 3).map((c, i) => (
                <Link key={`conf-${i}`} to={`/networks/${encodeURIComponent(c.networkId)}`} className={cn(ROW, ROW_DANGER)}>
                  <AlertTriangle size={15} className="shrink-0 text-red-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate">
                      Address conflict in {(c.networks || [{ name: c.networkName }]).map((n) => n.name).join(' + ')}: {c.resources.map((r) => r.name).join(' + ')}
                    </span>
                    <span className="block text-[0.74rem] text-red-500 truncate">
                      {c.address} · {c.overlapCount === -1 ? 'everyone affected' : `${c.overlapCount} user${c.overlapCount === 1 ? '' : 's'} with unpredictable access`}{c.crossNetwork ? ' · cross-network' : ''}
                    </span>
                  </span>
                  <Badge tone="red">Conflict</Badge>
                </Link>
              ))}
              {conflicts.length > 3 && (
                <Link to="/networks" className={cn(ROW, ROW_DANGER)}>
                  <AlertTriangle size={15} className="shrink-0 text-red-500" />
                  <span className="flex-1 text-sm text-nb-gray-800 dark:text-nb-gray-100">+{conflicts.length - 3} more address conflict{conflicts.length - 3 === 1 ? '' : 's'}</span>
                  <ChevronRight size={14} className="text-nb-gray-400" />
                </Link>
              )}
              {nbNotices.slice(0, 3).map((n, i) => (
                // The row link and the Ignore button are siblings (no button inside a link). The
                // link's ::after covers the whole row, so a click anywhere but Ignore opens
                // Troubleshoot; Ignore sits above that layer.
                <div key={`nbn-${n.id || i}`} className={cn(ROW, ROW_DANGER, 'relative')}>
                  <Link to="/troubleshoot" className="flex min-w-0 flex-1 items-center gap-3 after:absolute after:inset-0 after:rounded-lg">
                    <AlertTriangle size={15} className="shrink-0 text-red-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate">{n.event}{n.peerName ? ` - ${n.peerName}` : ''}</span>
                      <span className="block text-[0.74rem] text-red-500 truncate">{n.message || 'Reported by NetBird'}</span>
                    </span>
                    <Badge tone="red">{n.kind === 'routing' ? 'Routing' : 'Integration'}</Badge>
                  </Link>
                  {/* Admin-only Ignore: hides the notice for everyone. */}
                  {isAdmin && n.id && (
                    <button type="button" title="Ignore - hide this notice for everyone" aria-label="Ignore this notice"
                      onClick={() => dismissNotice.mutate(n.id)}
                      className="relative z-10 shrink-0 text-nb-gray-400 hover:text-red-500 transition-colors">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              {failedAutomations.map((a) => (
                <Link key={a.id} to="/automation" className={cn(ROW, ROW_DANGER)}>
                  <Workflow size={15} className="shrink-0 text-red-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate">Automation “{a.name}” failed</span>
                    {a.lastError && <span className="block text-[0.74rem] text-red-500 truncate">{a.lastError}</span>}
                  </span>
                  <ChevronRight size={14} className="text-nb-gray-400" />
                </Link>
              ))}
            </div>
          )}
        </Section>

        {/* Recent app changes */}
        <Section title="Recent Changes" action={seeAll('/admin')}>
          {!audit.length ? (
            <p className="py-6 text-center text-sm text-nb-gray-500">No changes recorded yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-nb-gray-100 dark:divide-nb-gray-900">
              {audit.map((ev) => (
                <div key={ev.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate">{ACTION_LABELS[ev.action] || ev.action}</span>
                    <span className="block text-[0.74rem] text-nb-gray-500 truncate">{ev.actor_name || ev.actor_email || 'Unknown'}{ev.target ? ` · ${ev.target}` : ''}</span>
                  </span>
                  <span className="shrink-0 text-[0.72rem] text-nb-gray-400 whitespace-nowrap">{formatTimestamp(ev.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* Reverse proxy (Cloud ingress) - status only, and only the account's OWN clusters
          (NetBird's shared eu1… cluster is noise here). Hidden entirely when there are none. */}
      {rproxy?.available && rproxy.clusters.some((c) => c.type !== 'shared') && (
        <Section title="Reverse Proxy" className="mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {rproxy.clusters.filter((c) => c.type !== 'shared').map((c) => (
              <div key={c.id} className="rounded-lg border border-nb-gray-100 dark:border-nb-gray-900 px-3 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', c.online ? 'bg-green-500' : 'bg-red-500')} title={c.online ? 'Online' : 'Offline'} />
                  <span className="min-w-0 flex-1 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{c.address}</span>
                  <Badge tone={c.online ? 'green' : 'red'}>{c.online ? 'Online' : 'Offline'}</Badge>
                </div>
                <div className="mt-1 ml-4 text-[0.76rem] text-nb-gray-500">
                  {c.connectedProxies} prox{c.connectedProxies === 1 ? 'y' : 'ies'} connected · {c.services} service{c.services === 1 ? '' : 's'}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Traffic chart */}
      <Section title="Traffic - Last 24 Hours" action={seeAll('/activity')}>
        <HourlyChart data={hourly} />
      </Section>
    </div>
  );
}

/* ─── Personal dashboard (restricted user) ─── */

const REQ_TONE: Record<string, 'green' | 'gray' | 'red' | 'orange'> = {
  pending: 'orange', approved: 'green', denied: 'red', cancelled: 'gray', expired: 'gray',
};

function PersonalDashboard() {
  // Requests are a main-account feature - the /mine route is main-only, so skip it in tenant mode.
  const inTenant = !!getTenantMode();
  const peers = usePeers().data || []; // server-scoped to the viewer's own devices
  const myRequests = useMyAccessRequests(!inTenant).data || [];
  const hourly = useHourlyStats(24).data || [];

  const online = peers.filter((p) => p.connected).length;
  const myPending = myRequests.filter((r) => r.status === 'pending').length;

  return (
    <div className="min-w-0">
      <PageHeader title="My Overview" icon={<Home size={19} />}
        description="Your devices, your access requests, and your recent traffic."
        actions={<LinkButton to="/request-access" variant="primary" size="sm"><KeyRound size={14} /> Request Access</LinkButton>} />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
        <StatTile icon={<MonitorSmartphone size={14} />} label="My Devices" value={<>{online}<span className="text-base font-normal text-nb-gray-400"> / {peers.length}</span></>} sub="online now" to="/peers" />
        {!inTenant && <StatTile icon={<Inbox size={14} />} label="Pending Requests" value={myPending} to="/request-access" />}
        <StatTile icon={<ActivityIcon size={14} />} label="Events · 24h" value={hourly.reduce((s, d) => s + d.count, 0).toLocaleString()} to="/activity" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Section title="My Devices" action={seeAll('/peers')}>
          {!peers.length ? (
            <p className="py-6 text-center text-sm text-nb-gray-500">No devices enrolled yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-nb-gray-100 dark:divide-nb-gray-900">
              {peers.slice(0, 5).map((p) => (
                <Link key={p.id} to={`/peers/${encodeURIComponent(p.id)}`} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0 group">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', p.connected ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate group-hover:text-netbird transition-colors">{p.name || p.dns_label || p.id}</span>
                    <span className="block font-mono text-[0.72rem] text-nb-gray-500 truncate">{p.ip}</span>
                  </span>
                  <span className="shrink-0 text-[0.72rem] text-nb-gray-400 whitespace-nowrap">{p.connected ? 'online' : formatMaybeDate(p.last_seen)}</span>
                </Link>
              ))}
            </div>
          )}
        </Section>

        {/* Access requests are main-only (customers have no app login) - hidden in tenant mode. */}
        {!inTenant && (
          <Section title="My Requests" action={seeAll('/request-access')}>
            {!myRequests.length ? (
              <p className="py-6 text-center text-sm text-nb-gray-500">You haven’t requested access yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-nb-gray-100 dark:divide-nb-gray-900">
                {myRequests.slice(0, 5).map((r) => (
                  <div key={r.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0 flex-1"><TargetChips targets={r.targets} /></span>
                    <span className="shrink-0 text-[0.72rem] text-nb-gray-400 whitespace-nowrap">{formatMaybeDate(r.createdAt)}</span>
                    <Badge tone={REQ_TONE[r.status] || 'gray'}>{ucLabel(r.status)}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}
      </div>

      <Section title="My Traffic - Last 24 Hours" action={seeAll('/activity')}>
        <HourlyChart data={hourly} />
      </Section>
    </div>
  );
}
