import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Rows3, Code2, User as UserIcon, User2, ExternalLink, MapPin, X, Monitor, Server, Globe, Mail, Flag, Send, Eye, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DateRange } from 'react-day-picker';
import { cn } from '@/lib/cn';
import { useAdminLogs, useAuditLog, useIpHistory, useIpHistoryUsers, useNetworks, useOutboundLog, useOutboundBody, type LogParams } from '@/lib/queries';
import { ucLabel } from '@/lib/str';
import { useNetbirdRefresh } from '@/lib/mutations';
import { useDebounced } from '@/lib/useDebounced';
import { formatTimestamp, formatUserId } from '@/lib/logfmt';
import { useServerSort } from '@/lib/useTableSort';
import type { AdminEvent, AuditEvent, IpAssignment, OutboundEntry, UserRef } from '@/lib/types';
import {
  SearchInput, SelectMenu, IconButton, EmptyState, LoadingState, LogLoader, useSettledDelay, Pagination, Badge, PageHeader,
  Table, THead, Th, SortTh, TBody, Tr, Td, Input, Copyable, ClearFiltersButton, FlagIcon, PillTabs, Modal,
} from '@/components/ui';
import { DateRangePicker } from '@/components/logs/DateRangePicker';
import { RawModal } from '@/components/logs/RawModal';
import { PeerCell } from '@/components/logs/cells';
import { UserSelect } from '@/components/logs/UserSelect';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { useUrlTab } from '@/lib/useUrlTab';
import { getTenantMode } from '@/lib/api';

type Tab = 'app' | 'netbird' | 'ips' | 'outbound';

export default function Admin() {
  // The outbound notifications log is app-level (main-only) - drop it while managing a tenant so
  // its query never fires (its route is not tenant-allowlisted → 403). Filtering it out of the
  // valid tabs also makes ?tab=outbound fall back to 'app' safely in tenant mode.
  const inTenant = !!getTenantMode();
  const validTabs: Tab[] = inTenant ? ['app', 'netbird', 'ips'] : ['app', 'netbird', 'ips', 'outbound'];
  const [tab, setTab] = useUrlTab<Tab>(validTabs, 'app');
  const ALL_TABS: { key: Tab; label: string }[] = [
    { key: 'app', label: 'App Changes' },
    { key: 'netbird', label: 'NetBird Events' },
    { key: 'ips', label: 'IP History' },
    { key: 'outbound', label: 'Notifications' },
  ];
  const tabs = ALL_TABS.filter((t) => validTabs.includes(t.key));
  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm mb-3 text-nb-gray-400">
        <ShieldCheck size={14} /> Admin
        <span className="text-nb-gray-300 dark:text-nb-gray-700">›</span> {tabs.find((t) => t.key === tab)?.label}
      </div>
      <PageHeader
        title="Audit Logs"
        description="Changes made through this app, and administrative actions in your NetBird account."
      />
      <PillTabs className="mb-5" items={tabs} value={tab} onChange={(k) => setTab(k as Tab)} />
      {tab === 'app' ? <AppChanges /> : tab === 'netbird' ? <NetbirdEvents /> : tab === 'ips' ? <IpHistory /> : <OutboundLog />}
    </div>
  );
}

// ─── App changes (this app's own audit log) ───
// Exported for the dashboard's "recent changes" card, so both render identical labels.
export const ACTION_LABELS: Record<string, string> = {
  'resource.create': 'Created resource',
  'resource.update': 'Updated resource',
  'resource.delete': 'Deleted resource',
  'network.grants': 'Updated network access',
  'network.default_profiles': 'Updated default access profiles',
  'network.create': 'Created network',
  'network.update': 'Updated network',
  'network.delete': 'Deleted network',
  'template.create': 'Created template',
  'template.update': 'Updated template',
  'template.delete': 'Deleted template',
  'filter.create': 'Created filter rule',
  'filter.update': 'Updated filter rule',
  'filter.delete': 'Deleted filter rule',
  'filter.builtin_noise': 'Built-in noise filter',
  'events.purge_matched': 'Purged events matching filters',
  'settings.app_config': 'Updated general settings',
  'settings.netbird_api': 'Updated NetBird API connection',
  'settings.webhook': 'Updated webhook authentication',
  'settings.traffic_pull': 'Changed the Traffic Events API pull',
  'settings.telegram': 'Updated Telegram notifications',
  'settings.approvers': 'Updated access-request approvers',
  'settings.smtp': 'Updated email (SMTP) settings',
  'settings.auto_approval': 'Updated auto-approval rules',
  'settings.permissions': 'Updated feature permissions',
  'user.delete': 'Deleted a user',
  'peer.setupkey': 'Created install setup key',
  'peer.bypass_revoke': 'Removed device bypass',
  'peer.bypass_expire': 'Device bypass expired',
  'peer.bypass_auto': 'Automatic EDR bypass applied (OS rule)',
  'settings.edr_auto_bypass': 'Updated automatic EDR bypass rules',
  'recurring.create': 'Created recurring access rule',
  'recurring.update': 'Updated recurring access rule',
  'recurring.delete': 'Deleted recurring access rule',
  'recurring.expire': 'Recurring access rule ended',
  'review.send': 'Sent weekly review digest',
  'cleanup.ignore': 'Ignored cleanup finding',
  'cleanup.unignore': 'Unignored cleanup finding',
  'notice.dismiss': 'Ignored NetBird notice',
  'blocklist.override': 'Admin override of blocklist',
  'tenant.create': 'Created MSP tenant',
  'tenant.update': 'Updated MSP tenant',
  'tenant.delete': 'Deleted MSP tenant',
  'tenant.verify': 'Verified tenant domain',
  'tenant.token': 'Set tenant API token',
  'tenant.webhook': 'Updated tenant webhook token',
  'tenant.provision': 'Provisioned tenant service user',
  'tenant.plan': 'Changed tenant subscription plan',
  'settings.msp_provisioning': 'Updated MSP provisioning token',
  'blocklist.add': 'Added blocklist entry',
  'blocklist.update': 'Updated blocklist entry',
  'blocklist.delete': 'Deleted blocklist entry',
  'blocklist.enforce': 'Enforced blocklist on existing resources',
  'access.grant': 'Granted temporary access',
  'access.revoke': 'Revoked temporary access',
  'access.expire': 'Temporary access expired',
  'access.extend': 'Extended temporary access',
  'request.create': 'Requested access',
  'request.approve': 'Approved an access request',
  'request.deny': 'Denied an access request',
  'request.cancel': 'Cancelled an access request',
  'request.expire': 'Access request expired',
};

// Category filters, mirroring the Telegram routing categories (auditCategory / netbirdSubcategory).
const APP_CATEGORIES: { value: string; label: string }[] = [
  { value: '', label: 'All Categories' },
  { value: 'resources', label: 'Resources & Routing' },
  { value: 'networks', label: 'Networks' },
  { value: 'policies', label: 'Policies' },
  { value: 'inventory', label: 'Peers & Groups' },
  { value: 'automation', label: 'Automation' },
  { value: 'requests', label: 'Access Requests' },
  { value: 'settings', label: 'Settings, Filters & Access' },
];
const NB_CATEGORIES: { value: string; label: string }[] = [
  { value: '', label: 'All Categories' },
  { value: 'nb_peers', label: 'Peers' },
  { value: 'nb_users', label: 'Users & Access' },
  { value: 'nb_groups', label: 'Groups' },
  { value: 'nb_policies', label: 'Policies & Posture' },
  { value: 'nb_keys', label: 'Setup Keys' },
  { value: 'nb_network', label: 'Network & DNS' },
  { value: 'nb_other', label: 'Other' },
];

function actionTone(action: string): 'green' | 'red' | 'cyan' | 'gray' {
  if (action.endsWith('.create')) return 'green';
  if (action.endsWith('.delete')) return 'red';
  if (action.endsWith('.update') || action.startsWith('settings') || action.startsWith('network')) return 'cyan';
  return 'gray';
}

// Audit metadata as wrapping "key: value" rows. Long values (e.g. a bulk-delete's full id
// list) break and clamp to a few lines instead of overflowing the cell; full value on hover.
function MetaRows({ meta }: { meta: [string, unknown][] }) {
  return (
    <div className="flex flex-col gap-1">
      {meta.map(([k, v]) => {
        const val = String(v);
        return (
          <div key={k} title={`${k}: ${val}`}
            className="text-[0.75rem] leading-relaxed break-all line-clamp-3 text-nb-gray-600 dark:text-nb-gray-300">
            <span className="text-nb-gray-400 dark:text-nb-gray-500">{k}: </span>{val}
          </div>
        );
      })}
    </div>
  );
}

function AppChanges() {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const { sort, dir, state: sortState, params: sortParams } = useServerSort();

  const dSearch = useDebounced(search);
  useEffect(() => { setPage(1); }, [dSearch, range, perPage, category, sort, dir]);

  const params: LogParams = {
    page, per_page: perPage, search: dSearch || undefined, category: category || undefined,
    from: range?.from ? range.from.toISOString() : undefined,
    to: range?.to ? range.to.toISOString() : undefined,
    ...sortParams,
  };
  const { data, isLoading, isFetching, refetch } = useAuditLog(params);
  const loader = useSettledDelay(isLoading);
  const refresh = useNetbirdRefresh();
  const events = data?.events || [];
  const totalPages = Math.max(Math.ceil((data?.total || 0) / perPage), 1);

  // The target of network.* actions is a network id - show its name instead of the raw id.
  const networks = useNetworks().data;
  const netName = useMemo(() => {
    const m = new Map((networks || []).map((n) => [n.id, n.name || n.id]));
    return (action: string, target?: string) =>
      (target && action.startsWith('network.') && m.has(target) ? m.get(target)! : (target || ''));
  }, [networks]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by action, target or user…" />
        <DateRangePicker value={range} onChange={setRange} />
        <div className="w-52"><SelectMenu value={category} onChange={setCategory} searchable={false} options={APP_CATEGORIES} /></div>
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton active={!!search || !!range || !!category} onClear={() => { setSearch(''); setRange(undefined); setCategory(''); }} />
        <IconButton onClick={async () => { await refresh.mutateAsync(); refetch(); }} title="Refresh" className="h-[42px] w-[42px] ml-auto">
          <RefreshCw size={15} className={cn((refresh.isPending || isFetching) && 'animate-spin')} />
        </IconButton>
      </div>

      {loader.visible ? <LogLoader done={loader.done} label="Loading Audit Log…" /> : !events.length ? (
        <EmptyState title="No Changes Recorded Yet" hint="Changes you make through the app (resources, settings, templates, filters) will appear here." />
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <THead>
                <SortTh label="Time" sortKey="time" state={sortState} />
                <SortTh label="User" sortKey="user" state={sortState} />
                <SortTh label="Action" sortKey="action" state={sortState} />
                <SortTh label="Target" sortKey="target" state={sortState} />
                <Th>Details</Th>
              </THead>
              <TBody>
                {events.map((ev) => <AuditRow key={ev.id} ev={ev} netName={netName} />)}
              </TBody>
            </Table>
          </div>
          <div className="md:hidden flex flex-col gap-2.5">
            {events.map((ev) => <AuditCard key={ev.id} ev={ev} netName={netName} />)}
          </div>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={data?.total} totalCapped={data?.totalCapped} label="changes" />
        </>
      )}
    </div>
  );
}

function AuditRow({ ev, netName }: { ev: AuditEvent; netName: (a: string, t?: string) => string }) {
  const meta = ev.meta && typeof ev.meta === 'object' ? Object.entries(ev.meta) : [];
  return (
    <Tr>
      <Td><span className="text-[0.82rem] text-nb-gray-500 whitespace-nowrap">{formatTimestamp(ev.timestamp)}</span></Td>
      <Td>
        <div className="min-w-0">
          <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate">{ev.actor_name || ev.actor_email || 'Unknown'}</div>
          {ev.actor_email && ev.actor_name && <div className="text-[0.72rem] text-nb-gray-500 truncate">{ev.actor_email}</div>}
        </div>
      </Td>
      <Td><Badge tone={actionTone(ev.action)}>{ACTION_LABELS[ev.action] || ev.action}</Badge></Td>
      <Td><span className="text-sm text-nb-gray-700 dark:text-nb-gray-300 break-all">{netName(ev.action, ev.target) || '-'}</span></Td>
      <Td>
        {meta.length ? (
          <div className="max-w-md"><MetaRows meta={meta} /></div>
        ) : <span className="text-nb-gray-500">-</span>}
      </Td>
    </Tr>
  );
}

function AuditCard({ ev, netName }: { ev: AuditEvent; netName: (a: string, t?: string) => string }) {
  const meta = ev.meta && typeof ev.meta === 'object' ? Object.entries(ev.meta) : [];
  return (
    <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={actionTone(ev.action)}>{ACTION_LABELS[ev.action] || ev.action}</Badge>
        <span className="text-[0.72rem] text-nb-gray-500 whitespace-nowrap shrink-0">{formatTimestamp(ev.timestamp)}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-sm">
        <UserIcon size={14} className="shrink-0 text-nb-gray-400" />
        <span className="truncate text-nb-gray-800 dark:text-nb-gray-200">{ev.actor_name || ev.actor_email || 'Unknown'}</span>
      </div>
      {ev.target && (
        <div className="mt-1.5 text-[0.8rem] break-all text-nb-gray-600 dark:text-nb-gray-300">
          <span className="text-nb-gray-400">Target: </span>{netName(ev.action, ev.target)}
        </div>
      )}
      {!!meta.length && (
        <div className="mt-2.5 rounded-md bg-nb-gray-50 dark:bg-nb-gray-900/40 px-2.5 py-2">
          <MetaRows meta={meta} />
        </div>
      )}
    </div>
  );
}

// ─── NetBird admin events (from the NetBird Management API) ───
function NetbirdEvents() {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [raw, setRaw] = useState<AdminEvent | null>(null);
  const { sort, dir, state: sortState, params: sortParams } = useServerSort();

  const dSearch = useDebounced(search);
  useEffect(() => { setPage(1); }, [dSearch, range, perPage, category, sort, dir]);

  const params: LogParams = {
    page, per_page: perPage, search: dSearch || undefined, category: category || undefined,
    from: range?.from ? range.from.toISOString() : undefined,
    to: range?.to ? range.to.toISOString() : undefined,
    ...sortParams,
  };
  const { data, isLoading, isFetching, refetch } = useAdminLogs(params);
  const loader = useSettledDelay(isLoading);
  const refresh = useNetbirdRefresh();
  const usersMap: Record<string, UserRef> = data?.users || {};
  const events = data?.events || [];
  const totalPages = Math.max(Math.ceil((data?.total || 0) / perPage), 1);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search admin events…" />
        <DateRangePicker value={range} onChange={setRange} />
        <div className="w-52"><SelectMenu value={category} onChange={setCategory} searchable={false} options={NB_CATEGORIES} /></div>
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton active={!!search || !!range || !!category} onClear={() => { setSearch(''); setRange(undefined); setCategory(''); }} />
        <IconButton onClick={async () => { await refresh.mutateAsync(); refetch(); }} title="Refresh" className="h-[42px] w-[42px] ml-auto">
          <RefreshCw size={15} className={cn((refresh.isPending || isFetching) && 'animate-spin')} />
        </IconButton>
      </div>

      {loader.visible ? (
        <LogLoader done={loader.done} label="Loading Events…" />
      ) : !events.length ? (
        <EmptyState title="No Admin Events Found" hint="Try adjusting your search or date range." />
      ) : (
        <>
        <div className="hidden md:block">
          <Table className="min-w-[800px]">
            <THead>
              <SortTh label="Event" sortKey="event" state={sortState} />
              <SortTh label="User" sortKey="user" state={sortState} />
              <Th>Meta</Th>
              <Th>Reference</Th>
            </THead>
            <TBody>
              {events.map((ev, i) => <AdminRow key={i} ev={ev} usersMap={usersMap} appUserId={data?.appUserId || ''} onRaw={setRaw} />)}
            </TBody>
          </Table>
        </div>
        <div className="md:hidden flex flex-col gap-2.5">
          {events.map((ev, i) => <AdminCard key={i} ev={ev} usersMap={usersMap} appUserId={data?.appUserId || ''} onRaw={setRaw} />)}
        </div>
        <Pagination page={page} totalPages={totalPages} onPage={setPage} total={data?.total} totalCapped={data?.totalCapped} label="events" />
        </>
      )}

      <RawModal data={raw} onClose={() => setRaw(null)} />
    </div>
  );
}

function initiatorName(ev: AdminEvent, usersMap: Record<string, UserRef>): string {
  const info = ev.initiator_id ? usersMap[ev.initiator_id] : undefined;
  if (info?.display_name) return info.display_name;
  if (info?.email) return info.email;
  if (ev.initiator_id === 'sys') return 'System';
  if (ev.initiator_id && !ev.initiator_id.includes('|')) return 'Service Account';
  if (ev.initiator_id) return formatUserId(ev.initiator_id);
  return '-';
}

// Origin tag: events initiated by the app's own NetBird API token were caused by THIS APP
// (grants, automations, merges...); everything else came from outside (dashboard, other API).
function SourceBadge({ ev, appUserId }: { ev: AdminEvent; appUserId: string }) {
  const viaApp = !!appUserId && ev.initiator_id === appUserId;
  return viaApp
    ? <span title="Performed by this app through its NetBird API token" className="inline-flex items-center rounded-md border border-netbird/40 bg-netbird/10 px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-wide text-netbird shrink-0">Via App</span>
    : <span title="Performed directly in NetBird (dashboard or another API client)" className="inline-flex items-center rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-wide text-nb-gray-500 shrink-0">NetBird</span>;
}

function AdminRow({ ev, usersMap, appUserId, onRaw }: { ev: AdminEvent; usersMap: Record<string, UserRef>; appUserId: string; onRaw: (e: AdminEvent) => void }) {
  const name = initiatorName(ev, usersMap);
  const meta = ev.meta && typeof ev.meta === 'object' ? Object.entries(ev.meta) : [];
  return (
    <Tr>
      <Td>
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
            <span className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">{formatTimestamp(ev.timestamp)}</span>
            <SourceBadge ev={ev} appUserId={appUserId} />
          </div>
          <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200">{ev.message}</span>
        </div>
      </Td>
      <Td>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center h-8 w-8 rounded-md shrink-0 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500 dark:text-nb-gray-400">
            <UserIcon size={15} />
          </div>
          <div className="min-w-0">
            <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate">{name}</div>
            <div className="text-[0.72rem] font-mono text-nb-gray-500 truncate">{ev.initiator_id ? formatUserId(ev.initiator_id) : '-'}</div>
          </div>
        </div>
      </Td>
      <Td>
        {meta.length ? (
          <div className="max-w-md"><MetaRows meta={meta} /></div>
        ) : <span className="text-nb-gray-500">-</span>}
      </Td>
      <Td>
        <div className="flex items-center justify-between gap-3">
          {ev.reference
            ? <a href={ev.reference} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-netbird hover:underline text-sm">Open<ExternalLink size={12} /></a>
            : <span className="text-nb-gray-500">-</span>}
          <button onClick={() => onRaw(ev)} title="View raw" className="text-nb-gray-400 hover:text-netbird shrink-0">
            <Code2 size={15} />
          </button>
        </div>
      </Td>
    </Tr>
  );
}

function AdminCard({ ev, usersMap, appUserId, onRaw }: { ev: AdminEvent; usersMap: Record<string, UserRef>; appUserId: string; onRaw: (e: AdminEvent) => void }) {
  const name = initiatorName(ev, usersMap);
  const meta = ev.meta && typeof ev.meta === 'object' ? Object.entries(ev.meta) : [];
  return (
    <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
          <span className="text-[0.72rem] text-nb-gray-500 dark:text-nb-gray-400 whitespace-nowrap">{formatTimestamp(ev.timestamp)}</span>
          <SourceBadge ev={ev} appUserId={appUserId} />
        </div>
        <button onClick={() => onRaw(ev)} title="View raw" className="text-nb-gray-400 hover:text-netbird shrink-0">
          <Code2 size={15} />
        </button>
      </div>
      <div className="mt-1.5 text-sm text-nb-gray-700 dark:text-nb-gray-200">{ev.message}</div>
      <div className="mt-2.5 flex items-center gap-2.5">
        <div className="flex items-center justify-center h-8 w-8 rounded-md shrink-0 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500 dark:text-nb-gray-400">
          <UserIcon size={15} />
        </div>
        <div className="min-w-0">
          <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate">{name}</div>
          <div className="text-[0.72rem] font-mono text-nb-gray-500 truncate">{ev.initiator_id ? formatUserId(ev.initiator_id) : '-'}</div>
        </div>
      </div>
      {!!meta.length && (
        <div className="mt-2.5 rounded-md bg-nb-gray-50 dark:bg-nb-gray-900/40 px-2.5 py-2">
          <MetaRows meta={meta} />
        </div>
      )}
      {ev.reference && (
        <div className="mt-2.5">
          <a href={ev.reference} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-netbird hover:underline text-sm">Open<ExternalLink size={12} /></a>
        </div>
      )}
    </div>
  );
}

// ─── IP History: which user/device held each NetBird IP, over time (forensic lookup) ───
function IpHistory() {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [search, setSearch] = useState('');
  const [at, setAt] = useState(''); // datetime-local: "who held it at this instant?"
  const [user, setUser] = useState('');
  const { sort, dir, state: sortState, params: sortParams } = useServerSort();

  const dSearch = useDebounced(search);
  useEffect(() => { setPage(1); }, [dSearch, at, user, sort, dir, perPage]);

  const { data, isLoading, isFetching, refetch } = useIpHistory({
    page, per_page: perPage,
    q: dSearch || undefined,
    at: at ? new Date(at).toISOString() : undefined,
    user: user || undefined,
    ...sortParams,
  });
  const loader = useSettledDelay(isLoading);
  const rows = data?.rows || [];
  const totalPages = Math.max(data?.total_pages || 1, 1);

  const logUsers = useIpHistoryUsers().data;
  const userList = useMemo(
    () => (logUsers || []).map((u) => ({ id: u.user_id, name: u.display_name || formatUserId(u.user_id), email: u.email || '' })),
    [logUsers],
  );
  const statusBadge = (r: IpAssignment) =>
    r.releasedAt ? <Badge tone="gray">Released</Badge> : <Badge tone="green">Active</Badge>;
  const userCell = (r: IpAssignment) => (
    <div className="min-w-0">
      <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate">{r.userName || (r.userId ? formatUserId(r.userId) : 'Server (no user)')}</div>
      {r.userEmail && <div className="text-[0.72rem] text-nb-gray-500 truncate">{r.userEmail}</div>}
    </div>
  );
  // An IP value with click-to-copy, and an optional country flag. The flag belongs to the
  // EXTERNAL (public) IP - that's what the geo is derived from - so only that column shows it.
  const ipValue = (value: string, cc?: string) => (
    <span className="inline-flex items-center gap-2 min-w-0">
      {cc !== undefined && <FlagIcon cc={cc} className="shrink-0" />}
      <Copyable value={value}><span className="font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-100">{value}</span></Copyable>
    </span>
  );
  // Hover fields for the device - same shape/style as the Traffic Events peer popup.
  const deviceFields = (r: IpAssignment) => [
    { icon: <Server size={14} />, label: 'Peer', value: r.peerName || r.peerId },
    r.dnsLabel ? { icon: <Globe size={14} />, label: 'Domain', value: r.dnsLabel } : null,
    r.userName ? { icon: <User2 size={14} />, label: 'User', value: r.userName } : null,
    r.userEmail ? { icon: <Mail size={14} />, label: 'User E-Mail', value: r.userEmail } : null,
    { icon: <MapPin size={14} />, label: 'NetBird IP', value: r.ip },
    r.connectionIp ? { icon: <Globe size={14} />, label: 'External IP', value: r.connectionIp } : null,
    r.region ? { icon: <Flag size={14} />, label: 'Region', value: r.region } : null,
  ];
  // Desktop: full peer cell with the rich hover popup (icon + name + address).
  const deviceCell = (r: IpAssignment) => (
    <PeerCell name={r.peerName || r.peerId} addr={r.ip} icon={<Monitor size={15} />} peerId={r.peerId} fields={deviceFields(r)} />
  );
  // Mobile: a compact link (hover popups don't apply to touch).
  const deviceLink = (r: IpAssignment) => (
    <Link to={`/peers/${encodeURIComponent(r.peerId)}`} className="text-sm text-nb-gray-700 dark:text-nb-gray-200 hover:text-netbird hover:underline truncate inline-block max-w-[150px]">
      {r.peerName || r.peerId}
    </Link>
  );

  return (
    <div>
      <p className="text-[0.9rem] text-nb-gray-500 dark:text-nb-gray-400 mb-4">
        Every interval a NetBird IP was assigned to a device (and its owner). Search an IP and pick a
        point in time to answer “who held this IP then?” - useful when another system only logged the IP.
      </p>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by IP, user or device…" />
        <div className="relative">
          <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-nb-gray-400 pointer-events-none" />
          <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} title="Only assignments active at this moment" className={cn('pl-9 w-56', at && 'pr-8')} />
          {at && (
            <button onClick={() => setAt('')} title="Clear time filter" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-nb-gray-400 hover:text-red-500"><X size={14} /></button>
          )}
        </div>
        <UserSelect users={userList} value={user} onChange={setUser} />
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton active={!!search || !!at || !!user} onClear={() => { setSearch(''); setAt(''); setUser(''); }} />
        <IconButton onClick={() => refetch()} title="Refresh" className="h-[42px] w-[42px] ml-auto">
          <RefreshCw size={15} className={cn(isFetching && 'animate-spin')} />
        </IconButton>
      </div>

      {loader.visible ? <LogLoader done={loader.done} label="Loading IP History…" /> : !rows.length ? (
        <EmptyState title="No IP Assignments Found" hint="History builds up as peers are seen; try a different search or time." />
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <THead>
                <SortTh label="NetBird IP" sortKey="ip" state={sortState} />
                <SortTh label="External IP" sortKey="external" state={sortState} />
                <SortTh label="User" sortKey="user" state={sortState} />
                <SortTh label="Device" sortKey="device" state={sortState} />
                <SortTh label="First Seen" sortKey="firstSeen" state={sortState} />
                <SortTh label="Last Seen" sortKey="lastSeen" state={sortState} />
                <SortTh label="Status" sortKey="status" state={sortState} />
              </THead>
              <TBody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td>{ipValue(r.ip)}</Td>
                    <Td>{r.connectionIp ? ipValue(r.connectionIp, r.countryCode) : <span className="text-nb-gray-500 text-sm">-</span>}</Td>
                    <Td>{userCell(r)}</Td>
                    <Td>{deviceCell(r)}</Td>
                    <Td><span className="text-[0.82rem] text-nb-gray-500 whitespace-nowrap">{formatTimestamp(r.firstSeen)}</span></Td>
                    <Td><span className="text-[0.82rem] text-nb-gray-500 whitespace-nowrap">{formatTimestamp(r.releasedAt || r.lastSeen)}</span></Td>
                    <Td>{statusBadge(r)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: cards instead of the wide table */}
          <div className="md:hidden flex flex-col gap-2.5">
            {rows.map((r) => (
              <div key={r.id} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex flex-col gap-1">
                    {ipValue(r.ip)}
                    {r.connectionIp && (
                      <span className="inline-flex items-center gap-1.5 text-[0.72rem] text-nb-gray-500">
                        <FlagIcon cc={r.countryCode} className="shrink-0" /> <Copyable value={r.connectionIp}><span className="font-mono">{r.connectionIp}</span></Copyable>
                      </span>
                    )}
                  </div>
                  <span className="shrink-0">{statusBadge(r)}</span>
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-3">
                  {userCell(r)}
                  {deviceLink(r)}
                </div>
                <div className="mt-2 text-[0.76rem] text-nb-gray-500">
                  {formatTimestamp(r.firstSeen)} → {formatTimestamp(r.releasedAt || r.lastSeen)}
                </div>
              </div>
            ))}
          </div>

          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={data?.total} label="assignments" />
        </>
      )}
    </div>
  );
}

// ─── Outbound notifications (everything the app itself sent out - email / Telegram) ───
const OUTBOUND_CHANNELS = [
  { value: '', label: 'All Channels' },
  { value: 'email', label: 'Email' },
  { value: 'telegram', label: 'Telegram' },
];
const OUTBOUND_STATUSES = [
  { value: '', label: 'All Statuses' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
];

function channelBadge(channel: OutboundEntry['channel']) {
  return channel === 'email'
    ? <Badge tone="cyan" icon={<Mail size={12} />}>Email</Badge>
    : <Badge tone="orange" icon={<Send size={12} />}>Telegram</Badge>;
}
function outcomeBadge(r: OutboundEntry) {
  return r.ok
    ? <Badge tone="green">Sent</Badge>
    : <Badge tone="red" className="max-w-[16rem]"><span className="truncate" title={r.error}>Failed{r.error ? ` - ${r.error}` : ''}</span></Badge>;
}
// Feature slugs are kebab-case tags ('access-granted', 'nb_peers') - label them readably.
function featureLabel(feature: string) {
  return feature ? ucLabel(feature.replace(/^nb_/, 'NetBird ').replace(/[-_]/g, ' ')) : '';
}

function OutboundLog() {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const { sort, dir, state: sortState, params: sortParams } = useServerSort();

  const dSearch = useDebounced(search);
  useEffect(() => { setPage(1); }, [dSearch, range, perPage, channel, status, sort, dir]);

  const { data, isLoading, isFetching, refetch } = useOutboundLog({
    page, per_page: perPage, search: dSearch || undefined,
    channel: channel || undefined, status: status || undefined,
    from: range?.from ? range.from.toISOString() : undefined,
    to: range?.to ? range.to.toISOString() : undefined,
    ...sortParams,
  });
  const loader = useSettledDelay(isLoading);
  const rows = data?.rows || [];
  const totalPages = Math.max(Math.ceil((data?.total || 0) / perPage), 1);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by recipient, message or feature…" />
        <DateRangePicker value={range} onChange={setRange} />
        <div className="w-40"><SelectMenu value={channel} onChange={setChannel} searchable={false} options={OUTBOUND_CHANNELS} /></div>
        <div className="w-40"><SelectMenu value={status} onChange={setStatus} searchable={false} options={OUTBOUND_STATUSES} /></div>
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton active={!!search || !!range || !!channel || !!status} onClear={() => { setSearch(''); setRange(undefined); setChannel(''); setStatus(''); }} />
        <IconButton onClick={() => refetch()} title="Refresh" className="h-[42px] w-[42px] ml-auto">
          <RefreshCw size={15} className={cn(isFetching && 'animate-spin')} />
        </IconButton>
      </div>

      {loader.visible ? <LogLoader done={loader.done} label="Loading Messages…" /> : !rows.length ? (
        <EmptyState title="Nothing Sent Yet" hint="Every email and Telegram message this app sends will be recorded here - who got it, when, and which feature sent it." />
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <THead>
                <SortTh label="Time" sortKey="time" state={sortState} />
                <SortTh label="Channel" sortKey="channel" state={sortState} />
                <SortTh label="Recipient" sortKey="recipient" state={sortState} />
                <SortTh label="Feature" sortKey="feature" state={sortState} />
                <SortTh label="Message" sortKey="subject" state={sortState} />
                <Th>Status</Th>
                <Th></Th>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td><span className="text-[0.82rem] text-nb-gray-500 whitespace-nowrap">{formatTimestamp(r.timestamp)}</span></Td>
                    <Td>{channelBadge(r.channel)}</Td>
                    <Td><span className="text-sm text-nb-gray-800 dark:text-nb-gray-200 break-all">{r.recipient || '-'}</span></Td>
                    <Td>{r.feature ? <Badge>{featureLabel(r.feature)}</Badge> : <span className="text-nb-gray-500">-</span>}</Td>
                    <Td><span className="text-sm text-nb-gray-700 dark:text-nb-gray-300 line-clamp-2 max-w-md" title={r.subject}>{r.subject || '-'}</span></Td>
                    <Td>{outcomeBadge(r)}</Td>
                    <Td className="text-right">
                      <IconButton onClick={() => setPreviewId(r.id)} title="Preview" className="h-8 w-8">
                        <Eye size={15} />
                      </IconButton>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
          <div className="md:hidden flex flex-col gap-2.5">
            {rows.map((r) => (
              <div key={r.id} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  {channelBadge(r.channel)}
                  <span className="text-[0.72rem] text-nb-gray-500 whitespace-nowrap shrink-0">{formatTimestamp(r.timestamp)}</span>
                </div>
                <div className="mt-2.5 text-sm break-all text-nb-gray-800 dark:text-nb-gray-200">{r.recipient || '-'}</div>
                {r.subject && <div className="mt-1.5 text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300">{r.subject}</div>}
                <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                  {r.feature ? <Badge>{featureLabel(r.feature)}</Badge> : null}
                  {outcomeBadge(r)}
                  <button onClick={() => setPreviewId(r.id)} className="ml-auto inline-flex items-center gap-1 text-[0.78rem] text-nb-gray-600 dark:text-nb-gray-300 hover:text-netbird">
                    <Eye size={13} /> Preview
                  </button>
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={data?.total} totalCapped={data?.totalCapped} label="messages" />
        </>
      )}
      <MessagePreviewModal id={previewId} onClose={() => setPreviewId(null)} />
    </div>
  );
}

// Reads exactly what was sent - the stored rendered body of one email / Telegram message. The
// email body is untrusted HTML we author; render it in an EMPTY-sandbox iframe (no scripts, no
// same-origin, no forms, no network) as defense-in-depth. Telegram messages are lightweight HTML
// (b/i/a/code) with \n line breaks - wrap them so the breaks survive, in the same sandboxed frame.
function MessagePreviewModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { data, isLoading } = useOutboundBody(id);
  const open = id != null;
  const body = data?.body || '';
  const isEmail = data?.channel === 'email';
  // Telegram: wrap the message HTML so \n line breaks render; email srcDoc is already a full document.
  const srcDoc = isEmail
    ? body
    : `<div style="font-family:sans-serif;padding:12px;white-space:pre-wrap">${body}</div>`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      widthClass="max-w-[820px]"
      title={data ? data.subject || 'Message Preview' : 'Message Preview'}
      subtitle={data ? `To: ${data.recipient || '-'}` : undefined}
      icon={data ? (data.channel === 'email' ? <Mail size={18} /> : <Send size={18} />) : <Eye size={18} />}
    >
      {isLoading ? (
        <LoadingState />
      ) : !body ? (
        <EmptyState title="No Preview Available" hint="This message was sent before message previews were captured." />
      ) : (
        <div>
          <div className="mb-2">{data && channelBadge(data.channel)}</div>
          <iframe
            sandbox=""
            srcDoc={srcDoc}
            title="Message Preview"
            className="w-full min-h-[360px] rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white"
          />
          {isEmail && (
            <p className="mt-2 text-[0.78rem] text-nb-gray-500">Rendered email - external images and scripts are blocked.</p>
          )}
        </div>
      )}
    </Modal>
  );
}
