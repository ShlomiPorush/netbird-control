import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useSystemHealth } from '@/lib/queries';
import type { SystemHealth } from '@/lib/types';
import { useTableSort } from '@/lib/useTableSort';
import { formatTimestamp } from '@/lib/logfmt';
import { Badge, LoadingState, Table, THead, SortTh, TBody, Tr, Td } from '@/components/ui';

// ─── System Health - schedulers, database, integrations, retention ───
const SCHED_LABELS: Record<string, string> = {
  automations: 'Automations',
  grantExpiry: 'Temporary Access Expiry',
  grantReconcile: 'Grant Device Reconcile',
  grantCrashCleanup: 'Crashed-Grant Cleanup',
  bypassExpiry: 'Bypass Expiry & Temp-Device Delete',
  requestEscalation: 'Request Reminders & Auto-Expire',
  accessReviewDigest: 'Weekly Access Review Digest',
  trafficAnomalies: 'Traffic Anomaly Scan',
  recurringAccess: 'Recurring Access',
  recertification: 'Access Recertification',
  ipHistorySync: 'IP History Sync',
  proxyLogsSync: 'Proxy Access Logs Sync',
  trafficPull: 'Traffic Events API Pull',
  auditPull: 'Audit Events API Pull',
  retentionPurge: 'Event Retention Purge',
  mspDigest: 'Weekly MSP Digest',
  internalBackup: 'Internal Encrypted Backup',
  tenantTokenRotation: 'Tenant Token Rotation',
  resetStuckAutomations: 'Startup: Reset Stuck Automations',
  resetStuckGrants: 'Startup: Reset Stuck Grants',
};

// What each job actually DOES - shown under its name so nobody has to guess.
const SCHED_DESCRIPTIONS: Record<string, string> = {
  automations: 'Runs due automation jobs every 60s - imports resources from their configured sources into networks, honoring the blocklist and duplicate-address guards.',
  grantExpiry: 'Every 60s: revokes temporary access grants whose time is up and removes their groups/policies, so an expired grant can never leave access behind.',
  grantReconcile: "Every 60s: keeps active grants aligned with each user's CURRENT devices - newly enrolled devices join the grant, removed devices drop off.",
  grantCrashCleanup: 'Every 60s: removes grants left half-created by a crash or restart, so nothing stays partially configured in NetBird.',
  bypassExpiry: 'Every 60s: ends timed device bypasses - the device is blocked again until compliant, and a TEMPORARY device is deleted from NetBird entirely.',
  requestEscalation: 'Every 60s: sends the one-time Telegram reminder for pending access requests and auto-expires stale ones (timings in Settings → Security).',
  accessReviewDigest: 'Sends the weekly digest of everything currently open - active grants, bypasses, permissions, auto-approval rules, pending requests - to Telegram/email on its configured day and hour.',
  trafficAnomalies: 'Every 60s: watches for traffic spikes (a device moving far above its own 7-day hourly average) and country changes, alerting Telegram (thresholds in Settings → Security).',
  recurringAccess: "Every 60s: opens and closes recurring-access windows - creates the grant when a rule's schedule starts and revokes it when the window ends.",
  recertification: 'Opens a new access-review round when the configured interval has passed and nudges Telegram when a round is overdue (checked every 60s).',
  ipHistorySync: 'Every 60s: refreshes the peers cache and records which device/user held each NetBird IP as time intervals - this powers the IP History page.',
  proxyLogsSync: "Every 5 minutes: copies new reverse-proxy access logs from NetBird Cloud (which keeps only 7 days) into the app's database, where Data Retention governs them.",
  trafficPull: 'Every 5 minutes: for accounts that opted in (Settings → Webhook), reads traffic events from the NetBird API and stores them like streamed webhook events. A no-op for accounts that leave it off.',
  auditPull: 'Every 5 minutes: for accounts that opted in (Settings → Webhook), reads audit events from the NetBird API and stores them like webhook events. A no-op for accounts that leave it off.',
  mspDigest: "Hourly check: on the configured day and hour, sends the weekly snapshot of every MSP tenant to main's Telegram and/or email. Off by default.",
  internalBackup: 'Hourly check: at the configured hour, writes the daily envelope-encrypted full backup to the backup folder. Off until a passphrase and a folder are set.',
  retentionPurge: 'Checked every 10 minutes, acts once per day: deletes traffic + NetBird events older than the Data Retention setting. Disabled retention = nothing is ever deleted.',
  tenantTokenRotation: "Hourly: re-issues each MSP tenant's managed service-user token when it is within 30 days of its 365-day expiry, so tenant access never lapses.",
  resetStuckAutomations: "One-time at startup: clears automations left flagged as 'running' by a crash, so the scheduler can pick them up again.",
  resetStuckGrants: 'One-time at startup: clears temporary grants left flagged mid-operation by a crash, so expiry/reconcile can handle them normally.',
};

function fmtBytes(b: number): string {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function fmtCount(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function HealthCard({ label, value, sub, warn }: { label: string; value: ReactNode; sub?: ReactNode; warn?: boolean }) {
  return (
    <div className={cn('rounded-lg border p-3.5 bg-white dark:bg-nb-gray-950',
      warn ? 'border-amber-500/40' : 'border-nb-gray-200 dark:border-nb-gray-800')}>
      <div className="text-[0.74rem] uppercase tracking-wide text-nb-gray-500">{label}</div>
      <div className={cn('mt-1 text-lg font-semibold', warn ? 'text-amber-600 dark:text-amber-400' : 'text-nb-gray-900 dark:text-nb-gray-50')}>{value}</div>
      {sub && <div className="mt-0.5 text-[0.76rem] text-nb-gray-500">{sub}</div>}
    </div>
  );
}

// Telegram card: on top of enabled/off, surfaces the send queue - depth, rate-limit pauses
// and since-boot counters - so a 429 storm is visible here instead of only in the logs.
function TelegramCard({ tg }: { tg: SystemHealth['integrations']['telegram'] }) {
  if (!tg.enabled || !tg.hasToken) return <HealthCard label="Telegram" value="Off" />;
  const q = tg.queue;
  const value = q.paused ? 'Rate Limited' : q.queued > 0 ? `${q.queued} Queued` : 'Enabled';
  const bits = [
    `${fmtCount(q.sent)} sent`,
    q.queued > 0 ? `${q.queued} in queue` : '',
    q.retries ? `${q.retries} retries` : '',
    q.failed ? `${q.failed} failed` : '',
  ].filter(Boolean).join(' · ');
  return (
    <HealthCard label="Telegram" value={value} warn={q.paused || q.failed > 0}
      sub={
        <>
          {bits} <span className="text-nb-gray-400">(since restart)</span>
          {q.paused && q.pausedUntil && <span className="block">paused until {formatTimestamp(q.pausedUntil)} - retrying</span>}
          {q.lastError && q.lastErrorAt && (
            <span className="block truncate text-red-500" title={q.lastError}>last error {formatTimestamp(q.lastErrorAt)}: {q.lastError}</span>
          )}
        </>
      } />
  );
}

export function SystemHealthTab() {
  const { data, isLoading } = useSystemHealth();
  // Compute + sort the jobs before any early return so the hook runs on every render.
  const schedEntries = data ? Object.entries(data.schedulers) : [];
  const { sorted: schedSorted, state: schedState } = useTableSort(schedEntries, {
    job: ([key]) => SCHED_LABELS[key] || key,
    status: ([, s]) => (s.lastError ? 'error' : s.runs ? 'ok' : 'waiting'),
    lastRun: ([, s]) => s.lastRunAt || '',
    lastSuccess: ([, s]) => s.lastOkAt || '',
    duration: ([, s]) => s.lastMs,
    runs: ([, s]) => s.runs,
    failures: ([, s]) => s.failures,
  });
  if (isLoading || !data) return <LoadingState />;

  const failing = schedEntries.filter(([, s]) => s.lastError).length;
  const nb = data.integrations.netbird;

  return (
    <div className="flex flex-col gap-5">
      {/* Top row: liveness at a glance */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HealthCard label="Uptime" value={fmtUptime(data.uptimeSec)} sub={`v${data.version || '?'} · Node ${data.node}`} />
        <HealthCard label="Schedulers" value={failing ? `${failing} Failing` : 'All Healthy'} warn={failing > 0}
          sub={`${schedEntries.length} tracked jobs`} />
        <HealthCard label="NetBird API" warn={!nb.configured || !nb.lastOkAt}
          value={!nb.configured ? 'Not Configured' : nb.lastOkAt ? 'Connected' : 'No Contact Yet'}
          sub={nb.lastOkAt ? `last OK ${formatTimestamp(nb.lastOkAt)}${nb.readonly ? ' · read-only' : ''}` : nb.readonly ? 'read-only' : undefined} />
        <HealthCard label="Open Exposure" value={`${data.activeGrants + data.bypassedPeers}`}
          sub={`${data.activeGrants} active grants · ${data.bypassedPeers} bypassed devices · ${data.pendingRequests} pending requests`} />
      </div>

      {/* Schedulers */}
      <div>
        <h3 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50 mb-2">Background Jobs</h3>
        <div className="hidden md:block">
          <Table>
            <THead>
              <SortTh label="Job" sortKey="job" state={schedState} />
              <SortTh label="Status" sortKey="status" state={schedState} />
              <SortTh label="Last Run" sortKey="lastRun" state={schedState} />
              <SortTh label="Last Success" sortKey="lastSuccess" state={schedState} />
              <SortTh label="Duration" sortKey="duration" state={schedState} />
              <SortTh label="Runs" sortKey="runs" state={schedState} />
              <SortTh label="Failures" sortKey="failures" state={schedState} />
            </THead>
            <TBody>
              {schedSorted.map(([key, s]) => (
                <Tr key={key}>
                  <Td>
                    <span className="text-sm text-nb-gray-800 dark:text-nb-gray-100">{SCHED_LABELS[key] || key}</span>
                    {SCHED_DESCRIPTIONS[key] && (
                      <span className="block mt-0.5 max-w-[420px] text-[0.74rem] leading-snug text-nb-gray-500">{SCHED_DESCRIPTIONS[key]}</span>
                    )}
                  </Td>
                  <Td>
                    {s.lastError
                      ? <Badge tone="red">Error</Badge>
                      : s.runs ? <Badge tone="green">OK</Badge> : <Badge tone="gray">Waiting</Badge>}
                    {s.lastError && <span className="block mt-1 max-w-[280px] truncate text-[0.72rem] text-red-500" title={s.lastError}>{s.lastError}</span>}
                  </Td>
                  <Td><span className="text-sm text-nb-gray-500 whitespace-nowrap">{s.lastRunAt ? formatTimestamp(s.lastRunAt) : '-'}</span></Td>
                  <Td><span className="text-sm text-nb-gray-500 whitespace-nowrap">{s.lastOkAt ? formatTimestamp(s.lastOkAt) : '-'}</span></Td>
                  <Td><span className="text-sm text-nb-gray-500">{s.lastMs}ms</span></Td>
                  <Td><span className="text-sm text-nb-gray-500">{fmtCount(s.runs)}</span></Td>
                  <Td><span className={cn('text-sm', s.failures ? 'text-red-500' : 'text-nb-gray-500')}>{s.failures}</span></Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>
        {/* Mobile cards */}
        <div className="md:hidden flex flex-col gap-2">
          {schedEntries.map(([key, s]) => (
            <div key={`m-${key}`} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-nb-gray-800 dark:text-nb-gray-100">{SCHED_LABELS[key] || key}</span>
                {s.lastError ? <Badge tone="red">Error</Badge> : s.runs ? <Badge tone="green">OK</Badge> : <Badge tone="gray">Waiting</Badge>}
              </div>
              {SCHED_DESCRIPTIONS[key] && <div className="mt-0.5 text-[0.72rem] leading-snug text-nb-gray-500">{SCHED_DESCRIPTIONS[key]}</div>}
              {s.lastError && <div className="mt-1 text-[0.74rem] text-red-500 break-words">{s.lastError}</div>}
              <div className="mt-1 text-[0.74rem] text-nb-gray-500">
                {s.lastRunAt ? `last run ${formatTimestamp(s.lastRunAt)}` : 'not run yet'} · {fmtCount(s.runs)} runs · {s.failures} failures
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Database + retention */}
      <div>
        <h3 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50 mb-2">Database</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <HealthCard label="Traffic Events" value={`~${fmtCount(data.db.events.rows)}`}
            sub={`${fmtBytes(data.db.events.bytes)}${data.db.events.oldest ? ` · oldest ${formatTimestamp(data.db.events.oldest)}` : ''}`} />
          <HealthCard label="NetBird Events" value={`~${fmtCount(data.db.adminEvents.rows)}`}
            sub={`${fmtBytes(data.db.adminEvents.bytes)}${data.db.adminEvents.oldest ? ` · oldest ${formatTimestamp(data.db.adminEvents.oldest)}` : ''}`} />
          <HealthCard label="App Audit" value={`~${fmtCount(data.db.audit.rows)}`} sub={fmtBytes(data.db.audit.bytes)} />
          <HealthCard label="IP History" value={`~${fmtCount(data.db.ipAssignments.rows)}`} sub={fmtBytes(data.db.ipAssignments.bytes)} />
        </div>
        <p className="mt-2 text-[0.78rem] text-nb-gray-500">
          Retention: {data.retention.days
            ? `events older than ${data.retention.days} days are purged daily`
            : 'disabled - events are kept forever'}
          {data.retention.last && !data.retention.last.error &&
            ` · last purge ${formatTimestamp(data.retention.last.at)} (${(data.retention.last.events || 0) + (data.retention.last.adminEvents || 0)} rows)`}
          {data.retention.last?.error && <span className="text-red-500"> · last purge FAILED: {data.retention.last.error}</span>}
          {' '}· Configure in Settings › Data Retention.
        </p>
      </div>

      {/* Integrations */}
      <div>
        <h3 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50 mb-2">Integrations</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <HealthCard label="Authentication" warn={!data.authEnabled}
            value={data.authEnabled ? 'SSO Enabled' : 'OPEN MODE'}
            sub={data.authEnabled ? 'Azure AD / OIDC' : 'everyone is admin - configure OIDC!'} />
          <TelegramCard tg={data.integrations.telegram} />
          <HealthCard label="Email (SMTP)" value={data.integrations.smtp.enabled ? 'Enabled' : 'Off'} />
          <HealthCard label="Scheduled Bypass Expiries" value={String(data.scheduledBypasses)} sub="devices with a timed bypass" />
        </div>
      </div>
    </div>
  );
}
