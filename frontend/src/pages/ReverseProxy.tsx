import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Globe, Rows3, Server, ScrollText, ArrowDown, ArrowUp, Users as UsersIcon, Braces, Link2,
  Network as NetworkIcon, Flag, ShieldAlert, ShieldOff, ShieldCheck, LockKeyhole, LockOpen,
  ChevronRight, ChevronDown, ExternalLink, HelpCircle, Filter as FilterIcon, ChevronsUpDown,
  ArrowRight, Share2, CircleUser, RectangleEllipsis, Binary, FileCode2, Code2, X, RefreshCw, Plus, Container,
  Pencil, Power, Trash2, FolderGit2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { useReverseProxyStatus, useProxyAccessLogs, useProxyLogUsers, useProxyLogsSummary, useProxyServiceStats, useProxyDomains, type ProxyLogFilters } from '@/lib/queries';
import { useDebounced } from '@/lib/useDebounced';
import { UserSelect } from '@/components/logs/UserSelect';
import { DateRangePicker } from '@/components/logs/DateRangePicker';
import type { DateRange } from 'react-day-picker';
import { formatBytes } from '@/lib/logfmt';
import { avatarColor } from '@/lib/str';
import { cn } from '@/lib/cn';
import { useTableSort, type SortState } from '@/lib/useTableSort';
import { useUrlTab } from '@/lib/useUrlTab';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { ToolbarMenu, Segmented } from '@/components/logs/toolbar';
import { formatTimestamp } from '@/lib/logfmt';
import type { ProxyAccessLog, ProxyService, ProxyCluster, ProxyDomain, ProxyLogsSummaryRow, ProxyServiceStats } from '@/lib/types';
import { AddServiceModal, ExposeDockerModal, EditServiceModal } from '@/components/proxy/ProxyServiceModals';
import { RawModal } from '@/components/logs/RawModal';
import { useUpdateProxyService, useDeleteProxyService } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import {
  PageHeader, PillTabs, SearchInput, Badge, Button, EmptyState, LoadingState, LogLoader, useSettledDelay, ClearFiltersButton,
  Table, THead, Th, SortTh, TBody, Tr, Td, Pagination, FlagIcon, HoverCard, Input, RowMenu, MenuItem,
} from '@/components/ui';

type Tab = 'services' | 'infra' | 'logs';

// L4 events (TCP/UDP/TLS) have no HTTP method or status code - the official dashboard
// shows the uppercased protocol instead and renders status as "-".
const isL4 = (p?: string) => ['tcp', 'udp', 'tls'].includes(String(p || '').toLowerCase());

// Official dashboard's formatDuration: ms → s → m → h.
function formatDuration(ms?: number): string {
  const v = Number(ms) || 0;
  if (v <= 0) return '0ms';
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3_600_000) return `${(v / 60_000).toFixed(1)}m`;
  return `${(v / 3_600_000).toFixed(1)}h`;
}

// Official dashboard's auth-method mapping (icon + label) for the events table.
function authMeta(v?: string): { label: string; icon?: string } | null {
  const s = String(v || '').toLowerCase();
  if (!s) return null;
  if (['oidc', 'sso', 'bearer'].includes(s)) return { label: 'SSO', icon: 'users' };
  if (s === 'password') return { label: 'Password', icon: 'pwd' };
  if (s === 'pin') return { label: 'PIN Code', icon: 'pin' };
  if (s === 'header') return { label: 'HTTP Headers', icon: 'braces' };
  if (['link', 'magic_link', 'magic-link'].includes(s)) return { label: 'Magic Link', icon: 'link' };
  if (s === 'ip_restricted') return { label: 'IP Restricted', icon: 'network' };
  if (s === 'country_restricted') return { label: 'Country Restricted', icon: 'flag' };
  if (s === 'geo_unavailable') return { label: 'Geo Unavailable', icon: 'off' };
  if (s.startsWith('crowdsec_')) return { label: `CrowdSec ${s.replace('crowdsec_', '').replace(/^./, (c) => c.toUpperCase())}`, icon: 'alert' };
  return { label: v || '' };
}

function AuthMethodIcon({ v }: { v?: string }) {
  const m = authMeta(v);
  if (!m) return null;
  const cls = 'text-nb-gray-400 shrink-0';
  const pill = (t: string) => <span className="font-mono text-[0.6rem] border border-nb-gray-300 dark:border-nb-gray-700 rounded px-1 text-nb-gray-500">{t}</span>;
  return (
    <span title={`Auth: ${m.label}`} className="inline-flex items-center">
      {m.icon === 'users' ? <UsersIcon size={12} className={cls} />
        : m.icon === 'braces' ? <Braces size={12} className={cls} />
        : m.icon === 'link' ? <Link2 size={12} className={cls} />
        : m.icon === 'network' ? <NetworkIcon size={12} className={cls} />
        : m.icon === 'flag' ? <Flag size={12} className={cls} />
        : m.icon === 'alert' ? <ShieldAlert size={12} className={cls} />
        : m.icon === 'off' ? <ShieldOff size={12} className={cls} />
        : m.icon === 'pwd' ? pill('PWD')
        : m.icon === 'pin' ? pill('PIN')
        : null}
    </span>
  );
}

// ─── The proxy requests table (Time / Location-IP / Request / Status / Bytes / User) ───
// ONE component for both the Detailed view and the summary-pair expansion, exactly like the
// main logs page reuses its EventsTable inline. sortState absent → plain (non-sortable) headers.
function ProxyEventsTable({ logs, sortState }: { logs: ProxyAccessLog[]; sortState?: SortState }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [raw, setRaw] = useState<ProxyAccessLog | null>(null);
  const H = ['Time', 'Location / IP', 'Request', 'Status', 'Bytes', 'User'];
  const KEYS = ['time', 'source', 'request', 'status', 'bytes', 'user'];
  return (
    <>
    <Table>
      <THead>
        {H.map((h, i) => (sortState
          ? <SortTh key={h} label={h} sortKey={KEYS[i]} state={sortState} />
          : <Th key={h}>{h}</Th>))}
      </THead>
      <TBody>
        {logs.map((e, i) => {
          const key = e.id || String(i);
          const l4 = isL4(e.protocol);
          const noBytes = !(e.bytes_download || e.bytes_upload);
          return (
            <Fragment key={key}>
            <Tr onClick={() => setExpanded(expanded === key ? null : key)}>
              <Td>
                <div className="flex items-center gap-2">
                  {expanded === key ? <ChevronDown size={14} className="text-nb-gray-400 shrink-0" /> : <ChevronRight size={14} className="text-nb-gray-400 shrink-0" />}
                  <TimeCell ts={e.timestamp} />
                </div>
              </Td>
              <Td>
                <div className="flex items-center gap-2.5" title={[e.city_name, e.country_code].filter(Boolean).join(', ') || undefined}>
                  <FlagIcon cc={e.country_code} />
                  <span className="font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-200">{e.source_ip || '-'}</span>
                </div>
              </Td>
              <Td>
                <div className="flex items-baseline gap-3 min-w-0 max-w-[420px]">
                  <span className={cn('font-mono text-[0.82rem] font-medium min-w-[44px] shrink-0', l4 ? 'text-nb-gray-800 dark:text-nb-gray-200 uppercase' : 'text-nb-gray-500 dark:text-nb-gray-400')}>
                    {l4 ? String(e.protocol).toUpperCase() : (e.method || '-')}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[0.82rem]" title={`${e.host || ''}${e.path || ''}`}>
                    <span className="text-nb-gray-800 dark:text-nb-gray-200">{e.host || '-'}</span>
                    <span className="text-nb-gray-500 dark:text-nb-gray-400">{e.path || ''}</span>
                  </span>
                </div>
              </Td>
              <Td><StatusCell e={e} /></Td>
              <Td>
                <div className="flex items-center gap-3">
                  {noBytes ? <span className="text-nb-gray-500 text-sm">-</span> : (
                    <div className="text-xs text-nb-gray-600 dark:text-nb-gray-300 font-medium whitespace-nowrap">
                      <div className="flex items-center gap-1"><ArrowDown size={13} className="text-sky-400" /> {formatBytes(e.bytes_download || 0)}</div>
                      <div className="flex items-center gap-1"><ArrowUp size={13} className="text-netbird" /> {formatBytes(e.bytes_upload || 0)}</div>
                    </div>
                  )}
                  <button onClick={(ev) => { ev.stopPropagation(); setRaw(e); }} title="View raw" className="text-nb-gray-400 hover:text-netbird shrink-0">
                    <Code2 size={15} />
                  </button>
                </div>
              </Td>
              <Td>
                {!e.user_id && !e.userName ? <span className="text-nb-gray-500 text-sm">-</span> : (
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center uppercase text-[0.8rem] font-medium bg-nb-gray-200 dark:bg-nb-gray-900"
                      style={{ color: avatarColor(e.userName || e.user_id || '?') }}>
                      {(e.userName || e.user_id || '?').charAt(0)}
                    </div>
                    <span className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate max-w-[160px]">{e.userName || e.user_id}</span>
                    <AuthMethodIcon v={e.auth_method_used} />
                  </div>
                )}
              </Td>
            </Tr>
            {expanded === key && (
              <tr className="border-b border-nb-gray-100 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-930/30">
                <td colSpan={6} className="px-6 py-4">
                  <div className="flex flex-wrap gap-x-6 gap-y-1 mb-2 text-[0.8rem] text-nb-gray-500">
                    {e.serviceName && <span>Service: <span className="text-nb-gray-700 dark:text-nb-gray-300">{e.serviceName}</span></span>}
                    {e.reason && <span className="text-red-500">Reason: {e.reason}</span>}
                    {e.auth_method_used && <span>Auth: <span className="text-nb-gray-700 dark:text-nb-gray-300">{authMeta(e.auth_method_used)?.label}</span></span>}
                    {(() => {
                      const c = crowdsecInfo(e);
                      return c && <span>CrowdSec: <span className="text-nb-gray-700 dark:text-nb-gray-300">{c.label.replace('CrowdSec ', '')}{c.observe ? ' (observe mode - logged, not blocked)' : ' (blocked)'}</span></span>;
                    })()}
                  </div>
                  {e.metadata && Object.keys(e.metadata).length ? (
                    <pre className="nb-scroll max-h-64 overflow-auto rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3 text-[0.74rem] font-mono text-nb-gray-700 dark:text-nb-gray-300">
                      {JSON.stringify(e.metadata, null, 2)}
                    </pre>
                  ) : (
                    <div className="text-sm italic text-nb-gray-500">No metadata recorded for this request.</div>
                  )}
                </td>
              </tr>
            )}
            </Fragment>
          );
        })}
      </TBody>
    </Table>
    {raw && <RawModal data={raw} title="Raw Access Log" onClose={() => setRaw(null)} />}
    </>
  );
}

// Time cell: two stacked lines, absolute (official format "MMM D, YYYY" / "h:mm:ss A").
function TimeCell({ ts }: { ts?: string }) {
  if (!ts) return <span className="text-nb-gray-500 text-sm">-</span>;
  const d = new Date(ts);
  return (
    <div className="whitespace-nowrap">
      <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      <div className="text-[0.76rem] text-nb-gray-500 dark:text-nb-gray-400">{d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</div>
    </div>
  );
}

// CrowdSec verdict the proxy records in the log metadata (NetBird v0.81+): `crowdsec_verdict` is
// crowdsec_ban / _captcha / _throttle / _unavailable, and `crowdsec_mode: observe` means the
// request was only logged, not blocked. Read from metadata, never from the auth method, so it
// shows on rows without an identified user too.
function crowdsecInfo(e: ProxyAccessLog): { label: string; observe: boolean } | null {
  const v = String(e.metadata?.crowdsec_verdict || '').toLowerCase();
  if (!v) return null;
  const kind = v.replace(/^crowdsec_/, '');
  return { label: `CrowdSec ${kind.charAt(0).toUpperCase()}${kind.slice(1)}`, observe: e.metadata?.crowdsec_mode === 'observe' };
}

function CrowdSecBadge({ e }: { e: ProxyAccessLog }) {
  const c = crowdsecInfo(e);
  if (!c) return null;
  return (
    <Badge tone={c.observe ? 'orange' : 'red'} icon={<ShieldAlert size={12} />}>
      <span title={c.observe ? 'Observe mode: CrowdSec flagged this IP, but the request was allowed and only logged' : 'Blocked by CrowdSec'}>
        {c.label}{c.observe ? ' · Observe' : ''}
      </span>
    </Badge>
  );
}

function StatusCell({ e }: { e: ProxyAccessLog }) {
  if (isL4(e.protocol)) return crowdsecInfo(e) ? <CrowdSecBadge e={e} /> : <span className="text-nb-gray-500 text-sm">-</span>;
  const code = Number(e.status_code || 0);
  const ok = code >= 200 && code < 400;
  return (
    <span title={e.reason ? `Reason: ${e.reason}` : undefined} className="inline-flex items-center gap-3">
      <Badge tone={ok ? 'green' : 'red'}>{code || '-'}</Badge>
      <span className="font-mono text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">{formatDuration(e.duration_ms)}</span>
      <CrowdSecBadge e={e} />
    </span>
  );
}

export default function ReverseProxy() {
  const status = useReverseProxyStatus();
  // Access logs are LOCAL history, synced per account (main and each tenant independently).
  const [tab, setTab] = useUrlTab<Tab>(['services', 'infra', 'logs'], 'services');

  const services = status.data?.services || [];
  const clusters = status.data?.clusters || [];

  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm mb-4 text-nb-gray-400">
        <Globe size={14} /> Reverse Proxy
        <span className="text-nb-gray-300 dark:text-nb-gray-700">›</span>{' '}
        {tab === 'services' ? 'Services' : tab === 'infra' ? 'Clusters & Domains' : 'Access Logs'}
      </div>
      <PageHeader
        title={status.data?.available ? `${services.length} Service${services.length === 1 ? '' : 's'}` : 'Reverse Proxy'}
        description="Your NetBird Cloud ingress services, and access logs for every request that went through them."
      />

      {status.isLoading ? <LoadingState /> : !status.data?.available ? (
        <EmptyState title="Reverse Proxy Not Available" hint="This NetBird account has no reverse-proxy (ingress) feature - it's available on NetBird Cloud only." icon={<Globe size={22} />} />
      ) : (
        <>
          <div className="mb-5">
            <PillTabs
              items={[
                { key: 'services', label: <span className="inline-flex items-center gap-2"><Server size={14} /> Services</span> },
                { key: 'infra', label: <span className="inline-flex items-center gap-2"><NetworkIcon size={14} /> Clusters & Domains</span> },
                { key: 'logs', label: <span className="inline-flex items-center gap-2"><ScrollText size={14} /> Access Logs</span> },
              ]}
              value={tab}
              onChange={(k) => setTab(k as Tab)}
            />
          </div>
          {tab === 'services' ? <ServicesTab services={services} clusters={clusters} />
            : tab === 'infra' ? <InfraTab clusters={clusters} />
              : <AccessLogsTab />}
        </>
      )}
    </div>
  );
}

// ─── Services: local mirror of the Cloud ingress, official-dashboard columns ───
const MODE_LABEL: Record<string, string> = { http: 'HTTPS', tls: 'TLS Passthrough', tcp: 'TCP', udp: 'UDP' };

// Whole-history statistics for one service row: requests (+failed), users, transfer volumes.
function ServiceTrafficCell({ stats }: { stats?: ProxyServiceStats }) {
  if (!stats || !stats.requests) return <span className="text-nb-gray-500 text-sm">-</span>;
  return (
    <div className="whitespace-nowrap">
      <div className="text-sm text-nb-gray-800 dark:text-nb-gray-100">
        <span className="font-semibold">{stats.requests}</span> Request{stats.requests === 1 ? '' : 's'}
        {stats.failed > 0 && <span className="text-red-500 text-[0.78rem]"> · {stats.failed} Failed</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[0.74rem] text-nb-gray-500">
        <span className="inline-flex items-center gap-1"><ArrowDown size={11} className="text-sky-400" /> {formatBytes(stats.bytesDownload)}</span>
        <span className="inline-flex items-center gap-1"><ArrowUp size={11} className="text-netbird" /> {formatBytes(stats.bytesUpload)}</span>
        {stats.users > 0 && <span>{stats.users} User{stats.users === 1 ? '' : 's'}</span>}
      </div>
    </div>
  );
}

function AuthKindIcon({ kind }: { kind: string }) {
  const cls = 'text-nb-gray-400 shrink-0';
  return kind === 'netbird' ? <CircleUser size={14} className={cls} />
    : kind === 'sso' ? <UsersIcon size={14} className={cls} />
    : kind === 'password' ? <RectangleEllipsis size={14} className={cls} />
    : kind === 'pin' ? <Binary size={14} className={cls} />
    : kind === 'link' ? <Link2 size={14} className={cls} />
    : <FileCode2 size={14} className={cls} />;
}

function ServicesTab({ services, clusters }: { services: ProxyService[]; clusters: ProxyCluster[] }) {
  const clustersOnline = clusters.filter((c) => c.online).length;
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [exposing, setExposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const updateSvc = useUpdateProxyService();
  const deleteSvc = useDeleteProxyService();
  const confirm = useConfirm();
  const qc = useQueryClient();

  // Refresh = bust the backend's 60s status cache and pull the current state from NetBird NOW.
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      const fresh = await api.post('/api/reverse-proxy-status/refresh', {});
      qc.setQueryData(['reverse-proxy-status'], fresh);
    } catch { await qc.invalidateQueries({ queryKey: ['reverse-proxy-status'] }); }
    setRefreshing(false);
  };

  const toggleEnabled = async (s: ProxyService) => {
    try { await updateSvc.mutateAsync({ id: s.id, patch: { domain: s.domain, enabled: s.enabled === false } }); }
    catch (e) { await confirm({ title: 'Update Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };
  const onDelete = async (s: ProxyService) => {
    const ok = await confirm({
      title: 'Delete Service?',
      message: `"${s.domain || s.name}" will stop serving immediately and be removed from NetBird. Network resources this service targets are deleted with it (unless another service still uses them). This can't be undone.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try { await deleteSvc.mutateAsync(s.id); }
    catch (e) { await confirm({ title: 'Delete Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };
  // Whole-history totals per service, from the locally stored access logs.
  const statsQ = useProxyServiceStats();
  const statsById = useMemo(() => new Map((statsQ.data || []).map((s) => [s.serviceId, s])), [statsQ.data]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return services;
    return services.filter((s) =>
      (s.name || '').toLowerCase().includes(q) || (s.domain || '').toLowerCase().includes(q) ||
      (s.cluster || '').toLowerCase().includes(q) || (s.id || '').toLowerCase().includes(q) ||
      (s.targetList || []).some((t) => t.toLowerCase().includes(q)));
  }, [services, search]);

  const { sorted, state } = useTableSort(filtered, {
    domain: (s) => s.domain || s.name || '',
    type: (s) => s.mode || '',
    targets: (s) => s.targets || 0,
    auth: (s) => (s.authCount || 0) * 100 + (s.aclCount || 0),
    traffic: (s) => statsById.get(s.id)?.requests || 0,
    status: (s) => `${s.enabled === false ? 'z' : 'a'}${s.status || ''}`,
  }, { key: 'domain', dir: 'asc' });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25, [search]);

  const toggleOpen = (id: string) => setOpen((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const statusBadge = (s: ProxyService) => {
    const st = String(s.status || '').toLowerCase();
    if (s.enabled === false) return <Badge tone="gray">Disabled</Badge>;
    if (st === 'certificate_pending') return <Badge tone="orange">Issuing Certificate…</Badge>;
    if (st === 'pending') return <Badge tone="orange">Setting Up Service…</Badge>;
    if (st === 'tunnel_not_created') return <Badge tone="red">Tunnel Not Created</Badge>;
    if (st === 'error' || st === 'certificate_failed') return <Badge tone="red">Error</Badge>;
    return <Badge tone="green">Active</Badge>;
  };

  const authBadges = (s: ProxyService) => {
    if (isL4(s.mode)) {
      return (
        <span title="Auth methods are not supported for TCP/UDP and TLS passthrough services.">
          <Badge tone="gray" icon={<HelpCircle size={12} />}>N/A</Badge>
        </span>
      );
    }
    const lock = (
      <Badge tone="gray" icon={(s.authCount || 0) > 0 ? <LockKeyhole size={12} className="text-green-500" /> : <LockOpen size={12} className="text-red-500" />}>
        {s.authCount || 0}
      </Badge>
    );
    const shield = (
      <Badge tone="gray" icon={(s.aclCount || 0) > 0 ? <ShieldCheck size={12} className="text-green-500" /> : <ShieldOff size={12} className="text-red-500" />}>
        {s.aclCount || 0}
      </Badge>
    );
    return (
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {(s.authMethods || []).length ? (
          <HoverCard trigger={<span className="cursor-help">{lock}</span>}>
            <div className="flex flex-col gap-3 min-w-[260px]">
              {(s.authMethods || []).map((m, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-6">
                    <span className="inline-flex items-center gap-2 text-sm whitespace-nowrap text-nb-gray-700 dark:text-nb-gray-200"><AuthKindIcon kind={m.kind} /> {m.label}</span>
                    <span className="text-[0.8rem] text-green-500 whitespace-nowrap">
                      {m.groups && m.groups.length ? `${m.groups.length} Group${m.groups.length === 1 ? '' : 's'}`
                        : m.headers ? `${m.headers} Header${m.headers === 1 ? '' : 's'}`
                          : m.kind === 'sso' ? 'All Users' : m.kind === 'netbird' ? 'No Groups' : 'Enabled'}
                    </span>
                  </div>
                  {m.groups && m.groups.length > 0 && (
                    <div className="flex flex-col items-start gap-1.5 pl-6">
                      {m.groups.map((g) => (
                        <span key={g} className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800/60 bg-nb-gray-100 dark:bg-nb-gray-900 px-2 py-0.5 text-[0.76rem] text-nb-gray-700 dark:text-nb-gray-300">
                          <FolderGit2 size={11} className="shrink-0 text-nb-gray-400" /> {g}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </HoverCard>
        ) : lock}
        {(s.aclRules || []).length ? (
          <HoverCard trigger={<span className="cursor-help">{shield}</span>}>
            <div className="flex flex-col gap-2.5 min-w-[240px]">
              {(s.aclRules || []).map((r, i) => (
                <div key={i} className="flex items-start justify-between gap-4">
                  <span className={cn('inline-flex items-center gap-2 text-sm', r.allow === false ? 'text-red-500' : 'text-green-500')}>
                    {r.label.includes('Countr') ? <Flag size={14} /> : r.label === 'CrowdSec' ? <ShieldAlert size={14} /> : <NetworkIcon size={14} />}
                    <span className="text-nb-gray-700 dark:text-nb-gray-200">{r.label}</span>
                  </span>
                  <span className="text-[0.8rem] text-nb-gray-500 dark:text-nb-gray-300 text-right max-w-[200px] truncate" title={r.value}>{r.value}</span>
                </div>
              ))}
            </div>
          </HoverCard>
        ) : shield}
      </div>
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by URL, domain, or target…" kbd={false} />
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton active={!!search} onClear={() => setSearch('')} />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[0.8rem] text-nb-gray-500 hidden lg:inline">{clustersOnline} cluster{clustersOnline === 1 ? '' : 's'} online</span>
          <Button variant="secondary" className="!px-0 w-[42px]" title="Pull the current state from NetBird now" onClick={refreshNow} disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : undefined} />
          </Button>
          <Button variant="secondary" onClick={() => setExposing(true)} title="Routing peer + domain resource + service, in one step">
            <Container size={15} /> Expose Docker Container
          </Button>
          <Button variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> Add Service</Button>
        </div>
      </div>

      {adding && <AddServiceModal clusters={clusters} onClose={() => setAdding(false)} />}
      {exposing && <ExposeDockerModal clusters={clusters} onClose={() => setExposing(false)} />}
      {editingId && <EditServiceModal serviceId={editingId} clusters={clusters} onClose={() => setEditingId(null)} />}

      {!services.length ? (
        <EmptyState title="No Services Yet" hint="Expose your internal services securely through NetBird's reverse proxy with automatic TLS - start with Add Service or the Docker wizard." icon={<Server size={22} />} />
      ) : !sorted.length ? (
        <EmptyState title="No Matching Services" hint="Try a different search." icon={<Server size={22} />} />
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <THead>
                <SortTh label="Domain" sortKey="domain" state={state} />
                <SortTh label="Type" sortKey="type" state={state} />
                <SortTh label="Target(s)" sortKey="targets" state={state} />
                <SortTh label="Auth & Access" sortKey="auth" state={state} />
                <SortTh label="Traffic" sortKey="traffic" state={state} />
                <SortTh label="Status" sortKey="status" state={state} />
                <Th className="text-right">{''}</Th>
              </THead>
              <TBody>
                {pageRows.map((s) => {
                  const l4 = isL4(s.mode);
                  const domainLabel = `${s.domain || s.name}${l4 && s.listenPort ? `:${s.listenPort}` : ''}`;
                  const expandable = !l4 && (s.targetsDetail || []).length > 0;
                  const isOpen = open.has(s.id);
                  return (
                    <Fragment key={s.id}>
                    <Tr className={s.enabled === false ? 'opacity-50' : undefined}
                      onClick={expandable ? () => toggleOpen(s.id) : undefined}>
                      <Td>
                        <div className="flex items-center gap-2 min-w-0">
                          {expandable
                            ? (isOpen ? <ChevronDown size={16} className="text-nb-gray-400 shrink-0" /> : <ChevronRight size={16} className="text-nb-gray-400 shrink-0" />)
                            : <span className="w-4 shrink-0" />}
                          <div className="min-w-0">
                            {!l4 && s.domain ? (
                              <a href={`https://${s.domain}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1.5 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 hover:text-netbird truncate">
                                {domainLabel} <ExternalLink size={12} className="shrink-0 text-nb-gray-400" />
                              </a>
                            ) : (
                              <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 font-mono">{domainLabel}</span>
                            )}
                            <div className="mt-0.5 flex items-center gap-1.5 text-[0.74rem] text-nb-gray-500">
                              <Server size={11} className="shrink-0" /> {s.cluster || 'All'}
                              {(() => {
                                // Row-level marker: some paths of this service override its authentication.
                                const n = (s.targetsDetail || []).filter((t) => t.accessAction).length;
                                return n > 0 && <Badge tone="orange" className="ml-1">{n} Path Override{n === 1 ? '' : 's'}</Badge>;
                              })()}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td><Badge tone="gray">{MODE_LABEL[String(s.mode).toLowerCase()] || 'HTTPS'}</Badge></Td>
                      <Td>
                        <span title={(s.targetList || []).join('\n') || undefined}>
                          <Badge tone="gray" icon={<Server size={12} />}>{s.targets} Target{s.targets === 1 ? '' : 's'}</Badge>
                        </span>
                      </Td>
                      <Td>{authBadges(s)}</Td>
                      <Td><ServiceTrafficCell stats={statsById.get(s.id)} /></Td>
                      <Td>{statusBadge(s)}</Td>
                      <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <RowMenu width={190}>
                          {(close) => (
                            <>
                              <MenuItem icon={<Pencil size={14} />} onClick={() => { close(); setEditingId(s.id); }}>Edit Service</MenuItem>
                              <MenuItem icon={<Power size={14} />} onClick={() => { close(); toggleEnabled(s); }}>{s.enabled === false ? 'Enable' : 'Disable'}</MenuItem>
                              <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { close(); onDelete(s); }}>Delete</MenuItem>
                            </>
                          )}
                        </RowMenu>
                      </Td>
                    </Tr>
                    {expandable && isOpen && (
                      <tr className="border-b border-nb-gray-100 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-930/30">
                        <td colSpan={7} className="px-6 py-3">
                          <table className="w-full">
                            <thead>
                              <tr className="text-left">
                                {['Resource', 'Location', '', 'Destination', 'Active'].map((h, i) => (
                                  <th key={i} className="py-1.5 pr-4 text-[0.68rem] uppercase tracking-wider text-nb-gray-400 font-medium">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(s.targetsDetail || []).map((t, i) => (
                                <tr key={i} className={cn(!t.enabled && 'opacity-50')}>
                                  <td className="py-2 pr-4">
                                    <div className="flex items-center gap-2.5">
                                      <span className="h-8 w-8 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 flex items-center justify-center shrink-0"><Share2 size={14} className="text-nb-gray-400" /></span>
                                      <span className="min-w-0">
                                        <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 truncate">{t.name}</span>
                                        {t.sub && <span className="block text-[0.72rem] font-mono text-nb-gray-500">{t.sub}</span>}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="py-2 pr-4">
                                    {/* Like the official dashboard: the location pill opens the site at that path. */}
                                    <a href={`https://${s.domain}${t.path === '/' ? '' : t.path}`} target="_blank" rel="noreferrer"
                                      onClick={(ev) => ev.stopPropagation()} title={`Open https://${s.domain}${t.path === '/' ? '' : t.path}`}>
                                      <Badge tone="gray" className="font-mono hover:border-netbird/50 hover:text-netbird transition-colors">{t.path}</Badge>
                                    </a>
                                    {t.accessAction === 'bypass' && <Badge tone="orange" className="ml-1.5">Bypass Auth</Badge>}
                                    {t.accessAction === 'block' && <Badge tone="red" className="ml-1.5">Blocked</Badge>}
                                  </td>
                                  <td className="py-2 pr-4"><ArrowRight size={15} className="text-nb-gray-400" /></td>
                                  <td className="py-2 pr-4"><span className="font-mono text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-300">{t.destination || '-'}</span></td>
                                  <td className="py-2 pr-4">
                                    <Badge tone={t.enabled ? 'green' : 'gray'}>{t.enabled ? 'On' : 'Off'}</Badge>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </TBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden flex flex-col gap-2.5">
            {pageRows.map((s) => (
              <div key={s.id} className={cn('rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5', s.enabled === false && 'opacity-50')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{s.domain || s.name}</span>
                  {statusBadge(s)}
                </div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <Badge tone="gray">{MODE_LABEL[String(s.mode).toLowerCase()] || 'HTTPS'}</Badge>
                  <Badge tone="gray" icon={<Server size={12} />}>{s.targets} Target{s.targets === 1 ? '' : 's'}</Badge>
                  {authBadges(s)}
                </div>
                <div className="mt-2"><ServiceTrafficCell stats={statsById.get(s.id)} /></div>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="services" />
        </>
      )}
    </div>
  );
}

// ─── Infrastructure: proxy clusters + domain bases, pulled live from NetBird on demand ───
// Read-only inventory (clusters and domains are managed on NetBird's side); the Sync button
// busts the backend's 60s status cache so the view reflects NetBird RIGHT NOW.
function InfraTab({ clusters }: { clusters: ProxyCluster[] }) {
  const qc = useQueryClient();
  const domainsQ = useProxyDomains();
  const domains = domainsQ.data || [];
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      const fresh = await api.post('/api/reverse-proxy-status/refresh', {});
      qc.setQueryData(['reverse-proxy-status'], fresh);
    } catch { await qc.invalidateQueries({ queryKey: ['reverse-proxy-status'] }); }
    await qc.invalidateQueries({ queryKey: ['reverse-proxy-domains'] });
    setRefreshing(false);
  };

  const q = search.toLowerCase().trim();
  const fClusters = useMemo(() => !q ? clusters : clusters.filter((c) =>
    c.address.toLowerCase().includes(q) || c.type.toLowerCase().includes(q)), [clusters, q]);
  const fDomains = useMemo(() => !q ? domains : domains.filter((d) =>
    d.domain.toLowerCase().includes(q) || d.cluster.toLowerCase().includes(q) || d.type.includes(q)), [domains, q]);

  const { sorted: cSorted, state: cState } = useTableSort(fClusters, {
    address: (c) => c.address,
    type: (c) => c.type,
    status: (c) => (c.online ? 'a' : 'z'),
    proxies: (c) => c.connectedProxies,
    services: (c) => c.services,
  }, { key: 'address', dir: 'asc' });
  const { sorted: dSorted, state: dState } = useTableSort(fDomains, {
    domain: (d) => d.domain,
    type: (d) => d.type,
    validated: (d) => (d.validated ? 'a' : 'z'),
    cluster: (d) => d.cluster,
  }, { key: 'domain', dir: 'asc' });

  const clusterStatus = (c: ProxyCluster) => c.online
    ? <Badge tone="green">Online</Badge>
    : <Badge tone="red">Offline</Badge>;
  const domainStatus = (d: ProxyDomain) => d.validated
    ? <Badge tone="green">Validated</Badge>
    : <Badge tone="orange">Pending Validation</Badge>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search address or domain…" kbd={false} />
        <ClearFiltersButton active={!!search} onClear={() => setSearch('')} />
        <Button variant="secondary" className="ml-auto" title="Pull the current clusters and domains from NetBird now" onClick={refreshNow} disabled={refreshing}>
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : undefined} /> Sync From NetBird
        </Button>
      </div>

      {/* Clusters */}
      <div>
        <h3 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50 mb-2">Proxy Clusters</h3>
        {!cSorted.length ? (
          <EmptyState title={q ? 'No Matching Clusters' : 'No Clusters'} hint={q ? 'Try a different search.' : 'No proxy clusters are visible for this account.'} icon={<NetworkIcon size={22} />} />
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <THead>
                  <SortTh label="Address" sortKey="address" state={cState} />
                  <SortTh label="Type" sortKey="type" state={cState} />
                  <SortTh label="Status" sortKey="status" state={cState} />
                  <SortTh label="Connected Proxies" sortKey="proxies" state={cState} />
                  <SortTh label="Services" sortKey="services" state={cState} />
                </THead>
                <TBody>
                  {cSorted.map((c) => (
                    <Tr key={c.id}>
                      <Td><span className="font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-200">{c.address || '-'}</span></Td>
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <Badge tone={c.type === 'shared' ? 'gray' : 'cyan'}>{c.type === 'shared' ? 'Shared' : 'Dedicated'}</Badge>
                          {c.private && <Badge tone="orange">Private</Badge>}
                        </div>
                      </Td>
                      <Td>{clusterStatus(c)}</Td>
                      <Td><span className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{c.connectedProxies}</span></Td>
                      <Td><Badge tone="gray" icon={<Server size={11} />}>{c.services}</Badge></Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
            <div className="md:hidden flex flex-col gap-2.5">
              {cSorted.map((c) => (
                <div key={`m-${c.id}`} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-200 truncate">{c.address || '-'}</span>
                    {clusterStatus(c)}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge tone={c.type === 'shared' ? 'gray' : 'cyan'}>{c.type === 'shared' ? 'Shared' : 'Dedicated'}</Badge>
                    {c.private && <Badge tone="orange">Private</Badge>}
                    <Badge tone="gray" icon={<Server size={11} />}>{c.services} Service{c.services === 1 ? '' : 's'}</Badge>
                  </div>
                  <div className="mt-1.5 text-[0.76rem] text-nb-gray-500">{c.connectedProxies} connected prox{c.connectedProxies === 1 ? 'y' : 'ies'}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Domains */}
      <div>
        <h3 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50 mb-2">Domains</h3>
        {domainsQ.isLoading ? <LoadingState /> : !dSorted.length ? (
          <EmptyState title={q ? 'No Matching Domains' : 'No Domains'} hint={q ? 'Try a different search.' : 'No domain bases available - connect a proxy cluster or add a custom domain in NetBird.'} icon={<Globe size={22} />} />
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <THead>
                  <SortTh label="Domain" sortKey="domain" state={dState} />
                  <SortTh label="Type" sortKey="type" state={dState} />
                  <SortTh label="Status" sortKey="validated" state={dState} />
                  <SortTh label="Cluster" sortKey="cluster" state={dState} />
                </THead>
                <TBody>
                  {dSorted.map((d) => (
                    <Tr key={d.id || d.domain}>
                      <Td>
                        <span className="font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-200">{d.domain}</span>
                        {d.requireSubdomain && <span className="block text-[0.72rem] text-nb-gray-500">subdomains only</span>}
                      </Td>
                      <Td><Badge tone={d.type === 'custom' ? 'cyan' : 'gray'}>{d.type === 'custom' ? 'Custom' : 'Free'}</Badge></Td>
                      <Td>{domainStatus(d)}</Td>
                      <Td><span className="font-mono text-[0.8rem] text-nb-gray-500 dark:text-nb-gray-400">{d.cluster || '-'}</span></Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
            <div className="md:hidden flex flex-col gap-2.5">
              {dSorted.map((d) => (
                <div key={`m-${d.id || d.domain}`} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-200 truncate">{d.domain}</span>
                    {domainStatus(d)}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge tone={d.type === 'custom' ? 'cyan' : 'gray'}>{d.type === 'custom' ? 'Custom' : 'Free'}</Badge>
                    {d.requireSubdomain && <Badge tone="gray">Subdomains Only</Badge>}
                  </div>
                  {d.cluster && <div className="mt-1.5 font-mono text-[0.74rem] text-nb-gray-500 truncate">{d.cluster}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Access logs: official-dashboard columns over the LOCALLY stored history ───
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Filters button: Status + Location/IP (user, time range and method have their own controls). */
function LogFilters({ status, setStatus, location, setLocation }: {
  status: string; setStatus: (v: string) => void;
  location: string; setLocation: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = (status !== 'all' ? 1 : 0) + (location ? 1 : 0);
  const dot = (cls: string) => <span className={cn('h-2 w-2 rounded-full shrink-0', cls)} />;
  return (
    <div className="relative">
      <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
        <FilterIcon size={16} /> Filters
        {active > 0 && <span className="ml-0.5 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-netbird text-white text-[0.65rem] font-semibold">{active}</span>}
        <ChevronsUpDown size={14} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-2 flex flex-col gap-3">
            <div>
              <div className="px-1 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-nb-gray-400">Status</div>
              <div className="flex flex-col">
                {[
                  { v: 'all', label: 'All', d: 'bg-nb-gray-500' },
                  { v: 'success', label: 'Success', d: 'bg-green-500' },
                  { v: 'failed', label: 'Failed', d: 'bg-red-500' },
                ].map((o) => (
                  <button key={o.v} onClick={() => setStatus(o.v)}
                    className={cn('flex items-center gap-2.5 px-2 py-1.5 rounded text-sm text-left hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900', status === o.v && 'bg-nb-gray-100 dark:bg-nb-gray-900')}>
                    {dot(o.d)} {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="px-1 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-nb-gray-400">Location / IP</div>
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. 10.0.0.5 or Berlin" className="w-full h-9 text-[0.85rem]" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FilterChip({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-netbird/30 bg-netbird/5 px-2.5 py-1 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-200">
      {children}
      <button onClick={onClear} className="text-nb-gray-400 hover:text-red-500"><X size={12} /></button>
    </span>
  );
}

function AccessLogsTab() {
  // Summary (per-service aggregation) is the default; the raw request list is behind "Detailed" -
  // exactly like the main Traffic Events page.
  const [view, setView] = useState<'summary' | 'detailed'>('summary');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [search, setSearch] = useState('');
  const [statusF, setStatusF] = useState('all');
  const [methodF, setMethodF] = useState('all');
  const [userId, setUserId] = useState('');
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [locationF, setLocationF] = useState('');
  const dq = useDebounced(search);
  const dLoc = useDebounced(locationF);
  const filters = useMemo(() => ({
    status: statusF, method: methodF, userId, location: dLoc,
    from: range?.from ? range.from.toISOString() : undefined,
    to: range?.to ? range.to.toISOString() : undefined,
  }), [statusF, methodF, userId, dLoc, range]);
  const q = useProxyAccessLogs(page, perPage, dq, filters, view === 'detailed');
  const summaryQ = useProxyLogsSummary(dq, filters, view === 'summary');
  const logUsers = useProxyLogUsers().data;
  const userList = useMemo(() =>
    (logUsers || []).map((u) => ({ id: u.user_id, name: u.display_name || u.user_id, email: u.email || '' })),
  [logUsers]);
  useEffect(() => { setPage(1); }, [perPage, dq, statusF, methodF, userId, dLoc, range]);

  const logs = q.data?.logs || [];
  const anyFilter = !!search || statusF !== 'all' || methodF !== 'all' || !!userId || !!locationF || !!range;

  // Refresh = pull new logs from NetBird NOW (same sync the scheduler runs), then re-read.
  const [syncing, setSyncing] = useState(false);
  const refreshNow = async () => {
    setSyncing(true);
    try { await api.post('/api/reverse-proxy-logs/sync', {}); } catch { /* the refetch below still shows what's stored */ }
    await q.refetch();
    setSyncing(false);
  };

  // Standard table chrome: every data column sorts (client-side within the page).
  const { sorted, state } = useTableSort(logs, {
    time: (e) => e.timestamp || '',
    source: (e) => e.source_ip || '',
    request: (e) => `${e.host || ''}${e.path || ''}`,
    status: (e) => Number(e.status_code) || 0,
    bytes: (e) => (Number(e.bytes_download) || 0) + (Number(e.bytes_upload) || 0),
    user: (e) => e.userName || e.user_id || '',
  }, { key: 'time', dir: 'desc' });

  const loader = useSettledDelay((view === 'detailed' && q.isLoading) || (view === 'summary' && summaryQ.isLoading));
  if (loader.visible) return <LogLoader done={loader.done} label="Loading Access Logs…" />;
  if (view === 'detailed' && q.data && !q.data.available && !logs.length) {
    return <EmptyState title="Access Logs Not Available" hint="This NetBird account doesn't expose reverse-proxy access logs (Cloud ingress feature)." icon={<ScrollText size={22} />} />;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by IP, host, path, user…" kbd={false} />
        <Segmented
          options={[{ value: 'summary', label: 'Summary' }, { value: 'detailed', label: 'Detailed' }]}
          value={view}
          onChange={(v) => setView(v as 'summary' | 'detailed')}
        />
        <DateRangePicker value={range} onChange={setRange} />
        <UserSelect users={userList} value={userId} onChange={setUserId} />
        <ToolbarMenu icon={<Braces size={15} />} label={methodF === 'all' ? 'All Methods' : methodF} value={methodF}
          onChange={setMethodF} options={[{ value: 'all', label: 'All Methods' }, ...METHODS.map((m) => ({ value: m, label: m }))]} width={170} />
        <LogFilters status={statusF} setStatus={setStatusF} location={locationF} setLocation={setLocationF} />
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton active={anyFilter} onClear={() => { setSearch(''); setStatusF('all'); setMethodF('all'); setUserId(''); setLocationF(''); setRange(undefined); }} />
        <Button variant="secondary" className="ml-auto !px-0 w-[42px]" title="Pull new logs from NetBird now" onClick={refreshNow} disabled={syncing}>
          <RefreshCw size={16} className={(syncing || q.isFetching) ? 'animate-spin' : undefined} />
        </Button>
      </div>

      {(statusF !== 'all' || locationF) && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {statusF !== 'all' && <FilterChip onClear={() => setStatusF('all')}>Status: {statusF === 'success' ? 'Success' : 'Failed'}</FilterChip>}
          {locationF && <FilterChip onClear={() => setLocationF('')}>Location / IP: {locationF}</FilterChip>}
        </div>
      )}

      {view === 'summary' ? (
        <ProxySummaryTable
          rows={summaryQ.data?.rows || []}
          perPage={perPage}
          anyFilter={anyFilter}
          baseSearch={dq}
          baseFilters={filters}
          onDrill={(r) => { setSearch(r.serviceName); if (r.userId) setUserId(r.userId); setView('detailed'); }}
        />
      ) : !sorted.length ? (
        <EmptyState
          title={anyFilter ? 'No Matching Requests' : 'No Proxy Events Yet'}
          hint={anyFilter ? 'Try different filters.' : 'No proxy traffic yet. Events appear here once your reverse proxy services start serving requests.'}
          icon={<ScrollText size={22} />}
        />
      ) : (
        <>
          <div className="hidden md:block">
            <ProxyEventsTable logs={sorted} sortState={state} />
          </div>

          {/* Mobile cards */}
          <div className="md:hidden flex flex-col gap-2.5">
            {sorted.map((e, i) => (
              <div key={e.id || i} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.82rem] text-nb-gray-800 dark:text-nb-gray-200">{e.host || '-'}{e.path || ''}</span>
                  {!isL4(e.protocol) && <Badge tone={(Number(e.status_code) || 0) >= 200 && (Number(e.status_code) || 0) < 400 ? 'green' : 'red'}>{e.status_code || '-'}</Badge>}
                </div>
                <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[0.74rem] text-nb-gray-500">
                  <TimeCell ts={e.timestamp} />
                  <FlagIcon cc={e.country_code} />
                  <span className="font-mono">{e.source_ip || ''}</span>
                  {e.userName && <span>{e.userName}</span>}
                </div>
              </div>
            ))}
          </div>

          <Pagination page={page} totalPages={q.data?.total_pages || 1} onPage={setPage} total={q.data?.total || 0} totalCapped={q.data?.totalCapped} label="requests" />
        </>
      )}
    </div>
  );
}

// ─── Summary view: SERVICE + USER pairs, expandable to the pair's recent requests ───
// Mirrors the main Traffic Events summary: a compact 6-column table (no horizontal scroll),
// each row expands inline to the newest requests of that pair, with Load More + full drill-down.
function ProxySummaryTable({ rows, perPage, anyFilter, baseSearch, baseFilters, onDrill }: {
  rows: ProxyLogsSummaryRow[];
  perPage: number;
  anyFilter: boolean;
  baseSearch: string;
  baseFilters: ProxyLogFilters;
  onDrill: (r: ProxyLogsSummaryRow) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { sorted, state } = useTableSort(rows, {
    service: (r) => r.serviceName,
    user: (r) => r.userName || (r.userId ? r.userId : 'zzz'), // anonymous rows sort last
    requests: (r) => r.requests,
    down: (r) => r.bytesDownload,
    up: (r) => r.bytesUpload,
    lastSeen: (r) => r.lastSeen,
  }, { key: 'lastSeen', dir: 'desc' });

  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [rows, perPage]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const clamped = Math.min(page, totalPages);
  const pageRows = sorted.slice((clamped - 1) * perPage, clamped * perPage);
  const rowId = (r: ProxyLogsSummaryRow) => `${r.serviceId}|${r.userId}`;

  if (!sorted.length) {
    return (
      <EmptyState
        title={anyFilter ? 'No Matching Requests' : 'No Proxy Events Yet'}
        hint={anyFilter ? 'Try different filters.' : 'No proxy traffic yet. Events appear here once your reverse proxy services start serving requests.'}
        icon={<ScrollText size={22} />}
      />
    );
  }

  return (
    <>
      <div className="hidden md:block">
        <Table>
          <THead>
            <SortTh label="Service" sortKey="service" state={state} />
            <SortTh label="User" sortKey="user" state={state} />
            <SortTh label="Requests" sortKey="requests" state={state} />
            <SortTh label="Downloaded" sortKey="down" state={state} />
            <SortTh label="Uploaded" sortKey="up" state={state} />
            <SortTh label="Last Seen" sortKey="lastSeen" state={state} />
          </THead>
          <TBody>
            {pageRows.map((r) => {
              const id = rowId(r);
              const isOpen = open === id;
              return (
                <Fragment key={id}>
                <Tr onClick={() => setOpen(isOpen ? null : id)}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      {isOpen ? <ChevronDown size={15} className="text-nb-gray-400 shrink-0" /> : <ChevronRight size={15} className="text-nb-gray-400 shrink-0" />}
                      <span className="h-8 w-8 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 flex items-center justify-center shrink-0"><Globe size={14} className="text-nb-gray-400" /></span>
                      <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate max-w-[220px]" title={r.serviceName}>{r.serviceName}</span>
                    </div>
                  </Td>
                  <Td>
                    {!r.userId && !r.userName ? <span className="text-nb-gray-500 text-sm">-</span> : (
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center uppercase text-[0.75rem] font-medium bg-nb-gray-200 dark:bg-nb-gray-900"
                          style={{ color: avatarColor(r.userName || r.userId) }}>
                          {(r.userName || r.userId).charAt(0)}
                        </div>
                        <span className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate max-w-[180px]">{r.userName || r.userId}</span>
                      </div>
                    )}
                  </Td>
                  <Td>
                    <span className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">{r.requests}</span>{' '}
                    <span className="text-[0.74rem] text-nb-gray-500 whitespace-nowrap">
                      (<span className="text-green-600 dark:text-green-500">{r.success} OK</span>
                      {r.failed > 0 && <> · <span className="text-red-500">{r.failed} Failed</span></>})
                    </span>
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1 text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300 whitespace-nowrap">
                      <ArrowDown size={13} className="text-sky-400" /> {formatBytes(r.bytesDownload)}
                    </span>
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1 text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300 whitespace-nowrap">
                      <ArrowUp size={13} className="text-netbird" /> {formatBytes(r.bytesUpload)}
                    </span>
                  </Td>
                  <Td>
                    <div className="whitespace-nowrap">
                      <div className="text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200">{formatTimestamp(r.lastSeen)}</div>
                      <div className="text-[0.7rem] text-nb-gray-500">since {formatTimestamp(r.firstSeen)}</div>
                    </div>
                  </Td>
                </Tr>
                {isOpen && (
                  <tr className="border-b border-nb-gray-100 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-930/30">
                    <td colSpan={6} className="px-6 py-3">
                      <ProxyPairRequests row={r} baseSearch={baseSearch} baseFilters={baseFilters} onDrill={() => onDrill(r)} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </TBody>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-2.5">
        {pageRows.map((r) => (
          <div key={rowId(r)} onClick={() => onDrill(r)}
            className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{r.serviceName}</span>
              <span className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 shrink-0">{r.requests}</span>
            </div>
            {(r.userName || r.userId) && <div className="mt-1 text-[0.8rem] text-nb-gray-500 truncate">{r.userName || r.userId}</div>}
            <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[0.78rem] text-nb-gray-500">
              <span className="text-green-600 dark:text-green-500">{r.success} OK</span>
              {r.failed > 0 && <span className="text-red-500">{r.failed} Failed</span>}
              <span className="inline-flex items-center gap-1"><ArrowDown size={12} className="text-sky-400" /> {formatBytes(r.bytesDownload)}</span>
              <span className="inline-flex items-center gap-1"><ArrowUp size={12} className="text-netbird" /> {formatBytes(r.bytesUpload)}</span>
            </div>
          </div>
        ))}
      </div>

      <Pagination page={clamped} totalPages={totalPages} onPage={setPage} total={sorted.length} label="pairs" />
    </>
  );
}

/** A pair's newest requests, loaded lazily when its summary row is expanded - like the main
 *  summary's inline connections. "Load More" extends inline; "View Full Details" drills down. */
function ProxyPairRequests({ row, baseSearch, baseFilters, onDrill }: {
  row: ProxyLogsSummaryRow;
  baseSearch: string;
  baseFilters: ProxyLogFilters;
  onDrill: () => void;
}) {
  const [limit, setLimit] = useState(5);
  const pairFilters = useMemo<ProxyLogFilters>(() => ({
    ...baseFilters,
    serviceId: row.serviceId || undefined,
    userId: row.userId || '',
    userEmpty: !row.userId,
  }), [baseFilters, row.serviceId, row.userId]);
  const q = useProxyAccessLogs(1, limit, baseSearch, pairFilters);
  const logs = q.data?.logs || [];
  const total = q.data?.total || 0;

  if (q.isLoading) return <div className="py-4 text-sm text-nb-gray-500">Loading requests…</div>;
  if (!logs.length) return <div className="py-4 text-sm text-nb-gray-500">No requests found for this pair under the current filters.</div>;

  return (
    <div onClick={(e) => e.stopPropagation()}>
      {/* The SAME table as the Detailed view - no reinvented layout (like the main logs page). */}
      <ProxyEventsTable logs={logs} />
      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        <span className="text-[0.72rem] text-nb-gray-400">Showing {Math.min(limit, total)} of {total} requests</span>
        {total > logs.length && (
          <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + 10)} disabled={q.isFetching}>
            {q.isFetching ? 'Loading…' : 'Load More'}
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onDrill}>View Full Details <ArrowRight size={13} /></Button>
      </div>
    </div>
  );
}
