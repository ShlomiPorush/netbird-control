import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Building2, Plus, Pencil, Trash2, Rows3, Copy as CopyIcon, Check, X, Globe, ArrowRightLeft,
  Users as UsersIcon, MonitorSmartphone, FolderGit2, ArrowRight, MinusCircle, Search as SearchIcon,
  Cog, Network as NetworkIcon, Eye, User as UserIcon, AlignLeft, LockKeyhole, KeyRound, ShieldCheck, GitCompareArrows,
  ClipboardList, RefreshCw, Mail, Send as SendIcon, AlertTriangle, CreditCard, Briefcase,
} from 'lucide-react';
import { useMspStatus, useMspTenants, useMspSwitcher, useGroups, useUsers, useTenantDrift, useFleetReport, useMspDigest, useMspBillingPlans } from '@/lib/queries';
import { useSaveTenant, useDeleteTenant, useVerifyTenantDomain, useSetTenantToken, useProvisionTenant, useApplyTenantDefaults, useSaveMspDigest, useSendMspDigest, useChangeTenantPlan } from '@/lib/mutations';
import { switchAccount, getTenantMode } from '@/lib/api';
import { useConfirm } from '@/contexts/ConfirmContext';
import { formatTimestamp } from '@/lib/logfmt';
import { avatarColor } from '@/lib/str';
import { cn } from '@/lib/cn';
import type { MspTenant, TenantGroup, NbUser, TenantReadiness, MspDigestConfig, MspBillingPlan } from '@/lib/types';
import {
  PageHeader, SearchInput, Badge, Button, IconButton, EmptyState, LoadingState, ClearFiltersButton,
  Table, THead, SortTh, Th, TBody, Tr, Td, Pagination, Modal, Field, Input, Select, Tabs, HoverCard, RowMenu, MenuItem,
} from '@/components/ui';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';

// Roles assignable to a tenant permission group - like the official selector with
// Owner/Billing Admin hidden. Icons match the official UserRoleSelector.
const TENANT_ROLES = [
  { value: 'admin', label: 'Admin', icon: Cog },
  { value: 'network_admin', label: 'Network Admin', icon: NetworkIcon },
  { value: 'auditor', label: 'Auditor', icon: Eye },
  { value: 'user', label: 'User', icon: UserIcon },
];

function statusBadge(status?: string) {
  const s = String(status || '').toLowerCase();
  if (s === 'active') return <Badge tone="green">Active</Badge>;
  if (s === 'pending') return <Badge tone="orange">Pending Verification</Badge>;
  if (s === 'invited') return <Badge tone="cyan">Invited</Badge>;
  if (s === 'existing') return <Badge tone="gray">Existing Account</Badge>;
  return <Badge tone="gray">{status || '-'}</Badge>;
}

// Any linked tenant is manageable - including pending-verification ones (NetBird allows
// verifying the domain later). Only 'invited' waits for the existing owner's approval.
const manageable = (t: MspTenant) => String(t.status || '').toLowerCase() !== 'invited';

/* Plan cell - official-dashboard parity: a colored dot + tier name; trials append the days
 * left; an exhausted trial on a free/trial tier shows the yellow Trial Expired badge.
 * Non-active tenants (invited/pending/existing) have no readable subscription → '-'. */
const PLAN_DOTS: Record<string, string> = {
  business: 'bg-netbird', enterprise: 'bg-netbird', team: 'bg-sky-500', free: 'bg-nb-gray-500', trial: 'bg-purple-400',
};
const PLAN_NAMES: Record<string, string> = {
  business: 'Business', enterprise: 'Enterprise', team: 'Team', free: 'Free', trial: 'Free Trial',
};
/* Shared plan renderer - a colored dot + tier name (+ trial suffix). Used by both the tenants
 * table (MspTenant.plan) and the Fleet Report (FleetReportTenant.plan); they share the shape. */
function PlanBadge({ plan, status }: { plan?: { tier: string; remainingTrialDays: number | null } | null; status: string }) {
  if (String(status).toLowerCase() !== 'active' || !plan) return <span className="text-nb-gray-500 text-sm">-</span>;
  const tier = (plan.tier || 'free').toLowerCase();
  const days = plan.remainingTrialDays;
  if ((tier === 'trial' || tier === 'free') && days === 0) {
    return <Badge tone="orange" icon={<AlertTriangle size={11} />}>Trial Expired</Badge>;
  }
  const suffix = tier === 'trial' && days != null
    ? (days === 1 ? ' (1 day left)' : days === 0 ? ' (Trial has expired)' : ` (${days} days left)`)
    : '';
  return (
    <span className="inline-flex items-center gap-2 text-sm text-nb-gray-700 dark:text-nb-gray-300 whitespace-nowrap">
      <span className={cn('h-2 w-2 rounded-full shrink-0', PLAN_DOTS[tier] || 'bg-nb-gray-500')} />
      {PLAN_NAMES[tier] || tier}{suffix}
    </span>
  );
}
function PlanCell({ tenant }: { tenant: MspTenant }) {
  return <PlanBadge plan={tenant.plan} status={tenant.status} />;
}

// Key-icon tone: green = credentials in place, amber = managed token expiring soon
// (rotation should prevent this - amber means it is failing), default = none.
const keyIconCls = (t: MspTenant) => {
  if (t.serviceUser?.expiresAt && new Date(t.serviceUser.expiresAt).getTime() < Date.now() + 30 * 86400_000) {
    return 'text-amber-500 hover:text-amber-400';
  }
  return t.hasApiToken ? 'text-green-500 hover:text-green-400' : undefined;
};

// The five onboarding checks behind a tenant's "N/5" readiness chip.
const READINESS_CHECKS: { key: keyof TenantReadiness; label: string }[] = [
  { key: 'verified', label: 'Domain Verified' },
  { key: 'serviceUser', label: 'Service User' },
  { key: 'webhookEvents', label: 'Events Webhook' },
  { key: 'webhookNotif', label: 'Notifications Webhook' },
  { key: 'telegram', label: 'Telegram' },
];

// Compact "N/5" chip (green at 5/5, amber otherwise) whose hover card lists every check.
function ReadinessChip({ readiness }: { readiness: TenantReadiness }) {
  const checks = READINESS_CHECKS.map((c) => ({ ...c, ok: !!readiness[c.key] }));
  const done = checks.filter((c) => c.ok).length;
  const all = done === READINESS_CHECKS.length;
  return (
    <HoverCard width={220} trigger={
      <span className={cn('inline-flex items-center rounded-md border px-2 py-1 text-[0.75rem] font-medium cursor-default',
        all ? 'bg-green-500/10 text-green-600 border-green-500/30 dark:text-green-500' : 'bg-netbird/10 text-netbird border-netbird/30')}>
        {done}/{READINESS_CHECKS.length}
      </span>
    }>
      <div className="flex flex-col gap-1.5">
        <div className="text-[0.68rem] font-medium uppercase tracking-wide text-nb-gray-400">Readiness</div>
        {checks.map((c) => (
          <div key={c.key} className="flex items-center gap-2 text-[0.82rem]">
            {c.ok
              ? <Check size={14} className="shrink-0 text-green-500" />
              : <X size={14} className="shrink-0 text-nb-gray-400" />}
            <span className={cn('truncate', c.ok ? 'text-nb-gray-700 dark:text-nb-gray-200' : 'text-nb-gray-500')}>{c.label}</span>
          </div>
        ))}
      </div>
    </HoverCard>
  );
}

export default function Tenants() {
  const status = useMspStatus();
  const available = !!status.data?.available;
  const { data, isLoading } = useMspTenants(available);
  // Switching uses the SWITCHER endpoint's item id (the official dashboard's switch value) -
  // a tenant row is matched to its switcher item by id / account id / domain.
  const switcher = useMspSwitcher(available).data || [];
  const switchIdFor = (t: MspTenant) => {
    const s = switcher.find((x) => x.id === t.id || x.accountId === t.id || (x.domain && x.domain === t.domain));
    return s ? s.id : t.id;
  };
  const del = useDeleteTenant();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const inTenantMode = !!getTenantMode();

  const [view, setView] = useState<'tenants' | 'fleet'>('tenants');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<{ tenant: MspTenant | null } | null>(null);
  const [dns, setDns] = useState<{ tenant: MspTenant; challenge?: string } | null>(null);
  const [tokenFor, setTokenFor] = useState<MspTenant | null>(null);
  const [driftFor, setDriftFor] = useState<MspTenant | null>(null);
  const tenants = data || [];

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return tenants;
    return tenants.filter((t) => t.name.toLowerCase().includes(q) || t.domain.toLowerCase().includes(q));
  }, [tenants, search]);
  const { sorted, state } = useTableSort(filtered, {
    name: (t) => t.name || t.domain,
    status: (t) => t.status,
    plan: (t) => t.plan?.tier || '',
    users: (t) => t.usage?.activeUsers ?? -1,
    peers: (t) => t.usage?.activePeers ?? -1,
    readiness: (t) => (t.readiness ? READINESS_CHECKS.filter((c) => t.readiness![c.key]).length : -1),
    created: (t) => t.createdAt || '',
  }, { key: 'name', dir: 'asc' });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25, [search]);

  // Enter tenant mode with a HARD reload into the tenant's home (see switchAccount) - the
  // atomic switch guarantees nothing from the previous account leaks into the views.
  const manage = (t: MspTenant) => {
    switchAccount({ id: switchIdFor(t) });
  };

  const onDelete = async (t: MspTenant) => {
    const ok = await confirm({
      title: 'Delete Tenant?',
      message: `"${t.name || t.domain}" will be removed from your MSP account. This does not delete the customer's NetBird account data, but you lose management access. This can't be undone here.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try { await del.mutateAsync(t.id); }
    catch (e) { await confirm({ title: 'Delete Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  if (status.isLoading) return <LoadingState />;

  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm mb-4 text-nb-gray-400">
        <Building2 size={14} /> Tenants
      </div>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <PageHeader
          title={available ? `${tenants.length} Tenant${tenants.length === 1 ? '' : 's'}` : 'Tenants'}
          description="Customer accounts managed under your MSP account - create, verify domain ownership, and manage each tenant's network from here."
        />
        {available && view === 'tenants' && (
          <Button variant="primary" className="self-start sm:shrink-0" onClick={() => setModal({ tenant: null })}
            disabled={inTenantMode} title={inTenantMode ? 'Exit tenant mode first' : undefined}>
            <Plus size={15} /> Add Tenant
          </Button>
        )}
      </div>

      {available && (
        <Tabs className="mt-4 mb-5" items={[
          { key: 'tenants', label: <span className="inline-flex items-center gap-2"><Building2 size={14} /> Tenants</span> },
          { key: 'fleet', label: <span className="inline-flex items-center gap-2"><ClipboardList size={14} /> Fleet Report</span> },
        ]} value={view} onChange={(k) => setView(k as 'tenants' | 'fleet')} />
      )}

      {!available ? (
        <EmptyState title="MSP Not Enabled" hint="This NetBird account is not an activated MSP. The MSP portal is a NetBird Cloud feature - contact NetBird to enable it." icon={<Building2 size={22} />} />
      ) : view === 'fleet' ? (
        <FleetReportTab />
      ) : isLoading ? <LoadingState /> : !tenants.length ? (
        <EmptyState title="No Tenants Yet" hint="Create your first customer tenant with Add Tenant. You'll verify domain ownership with a TXT record." icon={<Building2 size={22} />} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search name or domain…" />
            <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
            <ClearFiltersButton active={!!search} onClear={() => setSearch('')} />
            <IconButton title="Refresh" className="h-[42px] w-[42px] ml-auto" onClick={() => {
              qc.invalidateQueries({ queryKey: ['msp-tenants'] });
              qc.invalidateQueries({ queryKey: ['msp-switcher'] });
            }}>
              <RefreshCw size={15} className={cn(isLoading && 'animate-spin')} />
            </IconButton>
          </div>

          {!sorted.length ? (
            <EmptyState title="No Matching Tenants" hint="Try a different search." icon={<Building2 size={22} />} />
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <THead>
                    <SortTh label="Tenant" sortKey="name" state={state} />
                    <SortTh label="Status" sortKey="status" state={state} />
                    <SortTh label="Plan" sortKey="plan" state={state} />
                    <SortTh label="Users" sortKey="users" state={state} />
                    <SortTh label="Peers" sortKey="peers" state={state} />
                    <SortTh label="Readiness" sortKey="readiness" state={state} />
                    <SortTh label="Created" sortKey="created" state={state} />
                    <Th className="text-right">{''}</Th>
                  </THead>
                  <TBody>
                    {pageRows.map((t) => (
                      <Tr key={t.id} onClick={() => setModal({ tenant: t })}>
                        <Td>
                          <div className="flex items-center gap-2.5">
                            <span className="h-8 w-8 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 flex items-center justify-center shrink-0 uppercase text-[0.8rem] font-medium text-nb-gray-600 dark:text-nb-gray-300">
                              {(t.name || t.domain).slice(0, 2)}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{t.name || t.domain}</span>
                              <span className="block text-[0.74rem] font-mono text-nb-gray-500 truncate">{t.domain}</span>
                            </span>
                          </div>
                        </Td>
                        <Td>{statusBadge(t.status)}</Td>
                        <Td><PlanCell tenant={t} /></Td>
                        <Td>{t.usage ? <Badge tone="gray" icon={<UsersIcon size={11} />}>{t.usage.activeUsers}</Badge> : <span className="text-nb-gray-500 text-sm">-</span>}</Td>
                        <Td>{t.usage ? <Badge tone="gray" icon={<MonitorSmartphone size={11} />}>{t.usage.activePeers}</Badge> : <span className="text-nb-gray-500 text-sm">-</span>}</Td>
                        <Td>{t.readiness ? <ReadinessChip readiness={t.readiness} /> : <span className="text-nb-gray-500 text-sm">-</span>}</Td>
                        <Td><span className="text-sm text-nb-gray-500 whitespace-nowrap">{t.createdAt ? formatTimestamp(t.createdAt) : '-'}</span></Td>
                        <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                          {/* One visible primary action + everything else in the ⋯ menu - keeps
                              the row narrow enough that the table never scrolls horizontally. */}
                          <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            {manageable(t) && (
                              <Button variant="secondary" size="sm" onClick={() => manage(t)} disabled={inTenantMode}
                                title={inTenantMode ? 'Exit tenant mode first' : `Manage ${t.name || t.domain}'s network`}>
                                <ArrowRightLeft size={14} /> Manage
                              </Button>
                            )}
                            <RowMenu width={215}>
                              {(close) => (
                                <>
                                  {String(t.status).toLowerCase() === 'pending' && (
                                    <MenuItem icon={<Globe size={14} />} onClick={() => { close(); setDns({ tenant: t }); }}>Verify Domain</MenuItem>
                                  )}
                                  {manageable(t) && !inTenantMode && (
                                    <MenuItem icon={<GitCompareArrows size={14} />} onClick={() => { close(); setDriftFor(t); }}>Settings Sync</MenuItem>
                                  )}
                                  <MenuItem icon={<KeyRound size={14} className={keyIconCls(t)} />} onClick={() => { close(); setTokenFor(t); }}>Tenant API Access</MenuItem>
                                  <MenuItem icon={<Pencil size={14} />} onClick={() => { close(); setModal({ tenant: t }); }}>Edit</MenuItem>
                                  <MenuItem danger icon={<Trash2 size={14} />} onClick={() => { close(); onDelete(t); }}>Delete</MenuItem>
                                </>
                              )}
                            </RowMenu>
                          </div>
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
                <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="tenants" />
              </div>

              {/* Mobile cards */}
              <div className="md:hidden flex flex-col gap-2.5">
                {pageRows.map((t) => (
                  <div key={`m-${t.id}`} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{t.name || t.domain}</span>
                      {statusBadge(t.status)}
                    </div>
                    <div className="mt-0.5 font-mono text-[0.76rem] text-nb-gray-500 truncate">{t.domain}</div>
                    {t.plan && String(t.status).toLowerCase() === 'active' && <div className="mt-1.5"><PlanCell tenant={t} /></div>}
                    {(t.usage || t.readiness) && (
                      <div className="mt-2 flex items-center gap-1.5">
                        {t.usage && <Badge tone="gray" icon={<UsersIcon size={11} />}>{t.usage.activeUsers}</Badge>}
                        {t.usage && <Badge tone="gray" icon={<MonitorSmartphone size={11} />}>{t.usage.activePeers}</Badge>}
                        {t.readiness && <ReadinessChip readiness={t.readiness} />}
                      </div>
                    )}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {manageable(t) && <Button variant="secondary" size="sm" onClick={() => manage(t)} disabled={inTenantMode}><ArrowRightLeft size={14} /> Manage</Button>}
                      {String(t.status).toLowerCase() === 'pending' && <Button variant="secondary" size="sm" onClick={() => setDns({ tenant: t })}><Globe size={14} /> Verify</Button>}
                      {manageable(t) && !inTenantMode && <IconButton onClick={() => setDriftFor(t)} title="Settings Sync"><GitCompareArrows size={15} /></IconButton>}
                      <IconButton onClick={() => setTokenFor(t)} title="Tenant API Access" className={keyIconCls(t)}><KeyRound size={15} /></IconButton>
                      <IconButton onClick={() => setModal({ tenant: t })} title="Edit"><Pencil size={15} /></IconButton>
                      <IconButton onClick={() => onDelete(t)} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {modal && <TenantModal tenant={modal.tenant} onClose={() => setModal(null)}
        onCreatedWithChallenge={(t, challenge) => { setModal(null); setDns({ tenant: t, challenge }); }} />}
      {dns && <DomainVerifyModal tenant={dns.tenant} initialChallenge={dns.challenge} onClose={() => setDns(null)} />}
      {tokenFor && <TenantTokenModal tenant={tokenFor} onClose={() => setTokenFor(null)} />}
      {driftFor && <TenantDriftModal tenant={driftFor} onClose={() => setDriftFor(null)} />}
    </div>
  );
}

/* ─── Fleet Report - a management snapshot across every tenant (admin, main only) ─── */
// A small green/gray status dot with a descriptive title (webhook / Telegram cells).
function FleetDot({ on, title }: { on: boolean; title: string }) {
  return <span title={title} className={cn('inline-block h-2.5 w-2.5 rounded-full', on ? 'bg-green-500' : 'bg-nb-gray-300 dark:bg-nb-gray-700')} />;
}

// Service-user health: green OK, amber when the token expires within 30 days, gray when unset.
function ServiceUserCell({ ok, expiresAt }: { ok: boolean; expiresAt: string | null }) {
  const expiring = ok && !!expiresAt && new Date(expiresAt).getTime() < Date.now() + 30 * 86400_000;
  const title = expiresAt ? `Token expires ${formatTimestamp(expiresAt)}` : undefined;
  if (!ok) {
    return <span className="inline-flex items-center gap-1.5 text-[0.8rem] text-nb-gray-500"><span className="h-2 w-2 rounded-full bg-nb-gray-300 dark:bg-nb-gray-700" /> Not Set</span>;
  }
  if (expiring) {
    return <span title={title} className="inline-flex items-center gap-1.5 text-[0.8rem] text-amber-600 dark:text-amber-400"><span className="h-2 w-2 rounded-full bg-amber-500" /> Expiring</span>;
  }
  return <span title={title} className="inline-flex items-center gap-1.5 text-[0.8rem] text-green-600 dark:text-green-500"><Check size={13} className="shrink-0" /> OK</span>;
}

function FleetReportTab() {
  const { data, isLoading, isFetching, refetch } = useFleetReport(true);
  const [digestOpen, setDigestOpen] = useState(false);
  const rows = data?.tenants || [];
  const { sorted, state } = useTableSort(rows, {
    name: (t) => t.name || t.domain,
    status: (t) => t.status,
    plan: (t) => t.plan?.tier || '',
    users: (t) => t.users?.total ?? -1,
    billed: (t) => t.billedUsers ?? -1,
    peers: (t) => t.peers.total,
    online: (t) => t.peers.online,
    offline: (t) => t.peers.offline30d,
    outdated: (t) => t.versions.outdated,
    issues: (t) => t.knownIssues,
    lastEvent: (t) => t.lastEventAt || '',
  }, { key: 'name', dir: 'asc' });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25, []);

  if (isLoading) return <LoadingState />;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Same chrome as every other log toolbar: 42px controls, refresh as an icon button. */}
        <Button variant="secondary" className="h-[42px]" onClick={() => setDigestOpen(true)}>
          <Mail size={15} /> Digest
        </Button>
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        {data?.generatedAt && (
          <span className="text-[0.78rem] text-nb-gray-500">
            {total} tenant{total === 1 ? '' : 's'} - generated {formatTimestamp(data.generatedAt)}
          </span>
        )}
        <IconButton onClick={() => refetch()} title="Refresh" className="h-[42px] w-[42px] ml-auto">
          <RefreshCw size={15} className={cn(isFetching && 'animate-spin')} />
        </IconButton>
      </div>

      {!rows.length ? (
        <EmptyState title="No Tenants" hint="There are no tenants to report on yet." icon={<ClipboardList size={22} />} />
      ) : (
        <>
          {/* Related figures are merged into one cell each (a value + a muted sub-line) so the
              report stays a single readable screen instead of a wide horizontal scroll. */}
          <Table>
            <THead>
              <SortTh label="Tenant" sortKey="name" state={state} />
              <SortTh label="Status" sortKey="status" state={state} />
              <SortTh label="Plan" sortKey="plan" state={state} />
              <SortTh label="Users" sortKey="users" state={state} />
              <SortTh label="Peers" sortKey="peers" state={state} />
              <SortTh label="Clients" sortKey="outdated" state={state} />
              <SortTh label="Known Issues" sortKey="issues" state={state} />
              <Th>Integrations</Th>
              <SortTh label="Last Event" sortKey="lastEvent" state={state} />
            </THead>
            <TBody>
              {pageRows.map((t) => (
                <Tr key={t.id}>
                  <Td>
                    <span className="block text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{t.name || t.domain}</span>
                    <span className="block text-[0.74rem] font-mono text-nb-gray-500 truncate">{t.domain}</span>
                  </Td>
                  <Td>{statusBadge(t.status)}</Td>
                  <Td><PlanBadge plan={t.plan} status={t.status} /></Td>
                  {/* Users: active / total, with billed count on the sub-line. */}
                  <Td>
                    <span className="block text-sm text-nb-gray-700 dark:text-nb-gray-200 tabular-nums whitespace-nowrap">{t.users ? `${t.users.active} / ${t.users.total}` : '-'}</span>
                    <span className="block text-[0.72rem] text-nb-gray-500 whitespace-nowrap">{t.billedUsers != null ? `${t.billedUsers} billed` : 'billing -'}</span>
                  </Td>
                  {/* Peers: total, with online + 30d-stale on the sub-line. */}
                  <Td>
                    <span className="block text-sm text-nb-gray-700 dark:text-nb-gray-200 tabular-nums">{t.peers.total}</span>
                    <span className="block text-[0.72rem] whitespace-nowrap">
                      <span className="text-nb-gray-500">{t.peers.online} online</span>
                      {t.peers.offline30d > 0 && <span className="text-amber-600 dark:text-amber-400"> · {t.peers.offline30d} stale</span>}
                    </span>
                  </Td>
                  {/* Clients: outdated count, with the latest version on the sub-line. */}
                  <Td>
                    <span className="block text-sm text-nb-gray-700 dark:text-nb-gray-200 tabular-nums">{t.versions.outdated > 0 ? `${t.versions.outdated} outdated` : 'up to date'}</span>
                    {t.versions.latest && <span className="block text-[0.72rem] text-nb-gray-500 whitespace-nowrap">latest v{t.versions.latest}</span>}
                  </Td>
                  <Td>{t.knownIssues > 0
                    ? <Badge tone="orange" icon={<AlertTriangle size={11} />}>{t.knownIssues}</Badge>
                    : <span className="text-nb-gray-500 text-sm">-</span>}</Td>
                  {/* Integrations: the four readiness dots merged - events + notifications webhooks,
                      Telegram, and the managed service user (green ok / amber expiring). */}
                  <Td>
                    <div className="flex items-center gap-2">
                      <FleetDot on={t.webhookEvents} title={`Events webhook ${t.webhookEvents ? 'configured' : 'not configured'}`} />
                      <FleetDot on={t.webhookNotif} title={`Notifications webhook ${t.webhookNotif ? 'configured' : 'not configured'}`} />
                      <FleetDot on={t.telegram} title={`Telegram ${t.telegram ? 'configured' : 'not configured'}`} />
                      <ServiceUserCell ok={t.serviceUser.ok} expiresAt={t.serviceUser.expiresAt} />
                    </div>
                  </Td>
                  <Td><span className="text-sm text-nb-gray-500 whitespace-nowrap">{t.lastEventAt ? formatTimestamp(t.lastEventAt) : '-'}</span></Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="tenants" />
        </>
      )}

      {digestOpen && <DigestModal onClose={() => setDigestOpen(false)} />}
    </div>
  );
}

/* ─── Weekly Digest settings - a labeled toggle switch (main only kill switch is server-side). ─── */
function DigestToggle({ title, help, checked, onChange }: { title: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">{title}</div>
        {help && <p className="text-[0.72rem] text-nb-gray-500 mt-0.5">{help}</p>}
      </div>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cn('relative h-5 w-9 rounded-full transition-colors shrink-0 mt-0.5', checked ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700')}>
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </div>
  );
}

// A tag/chip input (type + Enter adds a chip, click a chip to remove) - the TenantDefaults pattern.
function DigestTagInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => { const v = draft.trim(); if (v && !values.includes(v)) onChange([...values, v]); setDraft(''); };
  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((g) => (
            <button type="button" key={g} onClick={() => onChange(values.filter((x) => x !== g))}
              className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 bg-nb-gray-100 px-2.5 py-1 text-[0.75rem] text-nb-gray-600 transition-colors hover:border-nb-gray-300 hover:text-nb-gray-800 dark:border-nb-gray-800/50 dark:bg-nb-gray-900 dark:text-nb-gray-300 dark:hover:text-nb-gray-100">
              {g}<X size={12} className="shrink-0" />
            </button>
          ))}
        </div>
      )}
      <Input value={draft} placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        onBlur={add} />
    </div>
  );
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function DigestModal({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useMspDigest(true);
  const save = useSaveMspDigest();
  const send = useSendMspDigest();
  const confirm = useConfirm();
  const [form, setForm] = useState<MspDigestConfig | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [sendMsg, setSendMsg] = useState('');

  useEffect(() => { if (data && !form) setForm(data); }, [data, form]);

  const onSave = async () => {
    if (!form) return;
    setError(''); setSendMsg('');
    try { await save.mutateAsync(form); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    catch (e) { setError((e as Error).message); }
  };
  const onSend = async () => {
    const ok = await confirm({
      title: 'Send Digest Now?',
      message: 'Send the MSP digest immediately to the configured Telegram and emails.',
      confirmText: 'Send',
    });
    if (!ok) return;
    setError(''); setSendMsg('');
    try {
      const r = await send.mutateAsync();
      setSendMsg(`Sent: Telegram ${r.telegram ? 'yes' : 'no'}, ${r.emails} email${r.emails === 1 ? '' : 's'}`);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} icon={<Mail size={18} />} size="md"
      title="Weekly Digest"
      subtitle="A weekly MSP digest summarizing every tenant - sent to main's Telegram and/or emails."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          <Button variant="secondary" size="sm" onClick={onSend} disabled={!form || send.isPending || save.isPending}>
            <SendIcon size={14} /> {send.isPending ? 'Sending…' : 'Send Now'}
          </Button>
          <Button variant="primary" size="sm" onClick={onSave} disabled={!form || save.isPending}>{save.isPending ? '…' : 'Save'}</Button>
        </>
      }>
      {isLoading || !form ? <LoadingState /> : (
        <div className="flex flex-col gap-4">
          <DigestToggle title="Enable Weekly Digest"
            help="A weekly MSP digest summarizing every tenant - sent to main's Telegram and/or the emails below. Disabled by default."
            checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Day">
              <Select value={String(form.day)} onChange={(e) => setForm({ ...form, day: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
              </Select>
            </Field>
            <Field label="Hour">
              <Select value={String(form.hour)} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={String(h)}>{String(h).padStart(2, '0')}:00</option>)}
              </Select>
            </Field>
          </div>
          <DigestToggle title="Send To Telegram"
            help="Deliver the digest to this main account's Telegram."
            checked={form.telegram} onChange={(v) => setForm({ ...form, telegram: v })} />
          <Field label="Emails" hint="Recipients for the digest email. Type an address and press Enter to add it.">
            <DigestTagInput values={form.emails} onChange={(v) => setForm({ ...form, emails: v })} placeholder="ops@example.com" />
          </Field>
          {saved && <p className="text-sm text-green-600 dark:text-green-500">Saved</p>}
          {sendMsg && <p className="text-sm text-nb-gray-600 dark:text-nb-gray-300">{sendMsg}</p>}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

/* ─── Create / edit tenant - official layout: General / Permissions (/ Plan) tabs ─── */
type TenantTab = 'general' | 'permissions' | 'plan';

function TenantModal({ tenant, onClose, onCreatedWithChallenge }: {
  tenant: MspTenant | null;
  onClose: () => void;
  onCreatedWithChallenge: (t: MspTenant, challenge: string) => void;
}) {
  const save = useSaveTenant();
  const confirm = useConfirm();
  const isNew = !tenant;
  const [tab, setTab] = useState<TenantTab>('general');
  const [name, setName] = useState(tenant?.name || '');
  const [domain, setDomain] = useState(tenant?.domain || '');
  const [groups, setGroups] = useState<TenantGroup[]>(tenant?.groups || []);
  // "Initial Setup" toggles (create only). Defaults replicate today's behavior + notifications:
  // seed/provision/notifications on, events off (needs a NetBird Business plan).
  const [setup, setSetup] = useState({ seed: true, provision: true, notifications: true, events: false });
  const [error, setError] = useState('');
  const [dnsOpen, setDnsOpen] = useState(false);

  const domainValid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain.trim().toLowerCase());
  // CREATE: Permissions tab / Continue stay locked until the name + a valid domain are filled.
  const canContinue = !!name.trim() && domainValid;
  const domainVerified = !!tenant?.activatedAt || String(tenant?.status).toLowerCase() === 'active';
  // Plan tab, like the official trigger: edit mode only, and only for an ACTIVE tenant - a
  // pending/invited account has no readable subscription to change.
  const showPlan = !isNew && String(tenant?.status).toLowerCase() === 'active';

  const submit = async () => {
    if (!name.trim()) { setError('Name is required.'); setTab('general'); return; }
    if (isNew && !domainValid) { setError('Please enter a valid domain, e.g. netbird.io'); setTab('general'); return; }
    if (!groups.length) { setError('At least one permission group is required.'); setTab('permissions'); return; }
    setError('');
    try {
      const out = await save.mutateAsync({
        id: tenant?.id,
        payload: { name: name.trim(), ...(isNew ? { domain: domain.trim().toLowerCase(), setup } : {}), groups: groups.map((g) => ({ id: g.id, role: g.role })) },
      });
      // Warn (non-blocking) when a REQUESTED initial-setup step failed. null = skipped/not requested
      // (no warning); false = attempted and failed. All-ok / all-skipped shows nothing. Runs before
      // the DNS-challenge handoff so the message is not lost, then the challenge flow continues.
      if (isNew && out.setup) {
        const s = out.setup;
        const failed: string[] = [];
        if (s.provisioned === false) failed.push('Create Managed Service User');
        if (s.seeded === false) failed.push('Sync Settings From Defaults');
        if (s.notifications === false) failed.push('Configure Account Notifications In NetBird');
        if (s.events === false) failed.push('Configure Activity Events In NetBird');
        if (failed.length) {
          await confirm({
            title: 'Tenant Created - Setup Incomplete',
            message: (
              <span>
                The tenant was created, but these setup steps did not complete: {failed.join(', ')}. You can re-run them from the tenant row or Settings - Apply Defaults, the key icon to Provision, and the Settings - Webhook buttons.
              </span>
            ),
            confirmText: 'Got It',
            danger: false,
          });
        }
      }
      if (isNew && out.dnsChallenge) {
        onCreatedWithChallenge({ id: out.id || '', name: name.trim(), domain: domain.trim().toLowerCase(), status: 'pending', activatedAt: '', createdAt: '', groups, usage: null }, out.dnsChallenge);
        return;
      }
      onClose();
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <>
    <Modal open onClose={onClose} icon={<UserIcon size={18} />}
      widthClass={tab === 'plan' ? 'max-w-[820px]' : tab === 'permissions' ? 'max-w-[660px]' : 'max-w-[576px]'}
      title={isNew ? 'Add Tenant' : 'Update Tenant'}
      subtitle={isNew
        ? <span className="text-netbird">Add a new tenant account to your organization.</span>
        : `${tenant?.name || ''} (${tenant?.domain || ''})`}
      tabs={<Tabs bordered={false} items={[
        { key: 'general', label: <span className="inline-flex items-center gap-2"><AlignLeft size={14} /> General</span> },
        { key: 'permissions', label: <span className={cn('inline-flex items-center gap-2', isNew && !canContinue && 'opacity-50')}><LockKeyhole size={14} /> Permissions</span> },
        ...(showPlan ? [{ key: 'plan', label: <span className="inline-flex items-center gap-2"><CreditCard size={14} /> Plan</span> }] : []),
      ]} value={tab} onChange={(k) => { if (isNew && k === 'permissions' && !canContinue) return; setTab(k as TenantTab); }} />}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          {/* The Plan tab has no form to save - its own Upgrade buttons are the action (official parity). */}
          {tab === 'plan' ? null : isNew && tab === 'general' ? (
            <Button variant="primary" size="sm" onClick={() => setTab('permissions')} disabled={!canContinue}>Continue</Button>
          ) : (
            <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending}>{save.isPending ? '…' : isNew ? 'Create Tenant' : 'Save Changes'}</Button>
          )}
        </>
      }>
      <div className="flex flex-col gap-4">
        {tab === 'general' && (
          <>
            <Field label="Name" hint="Set an easily recognizable name for the tenant.">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." maxLength={80} />
            </Field>
            {isNew ? (
              <Field label="Domain" hint="Enter the primary domain of the tenant.">
                <div className="relative">
                  <Globe size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-nb-gray-400" />
                  <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.de" className="pl-9 w-full" />
                </div>
                {domain.trim() && !domainValid && (
                  <p className="text-[0.72rem] text-red-500">Please enter a valid domain, e.g. netbird.io</p>
                )}
              </Field>
            ) : null}
            {isNew && (
              // Optional post-create steps. Defaults replicate today's behavior + notifications; each
              // step is best-effort server-side and can be re-run later from the tenant row / Settings.
              <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-4 py-3.5">
                <div className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">Initial Setup</div>
                <p className="text-[0.72rem] text-nb-gray-500 mt-0.5">Runs automatically right after the tenant is created.</p>
                <div className="mt-3 flex flex-col gap-3.5">
                  <DigestToggle title="Sync Settings From Defaults"
                    help="Copy your default filter rules, blocklist, retention, and NetBird account settings."
                    checked={setup.seed} onChange={(v) => setSetup((s) => ({ ...s, seed: v }))} />
                  <DigestToggle title="Create Managed Service User"
                    help="Provision a managed service user and API token for automated management."
                    checked={setup.provision} onChange={(v) => setSetup((s) => ({ ...s, provision: v }))} />
                  <DigestToggle title="Configure Account Notifications In NetBird"
                    help="Point NetBird's account notifications at this dashboard's receiver."
                    checked={setup.notifications} onChange={(v) => setSetup((s) => ({ ...s, notifications: v }))} />
                  <DigestToggle title="Configure Activity Events In NetBird"
                    help="Requires a NetBird Business plan (event streaming)."
                    checked={setup.events} onChange={(v) => setSetup((s) => ({ ...s, events: v }))} />
                </div>
              </div>
            )}
            {!isNew && (
              <Field label="Domain" hint="Primary domain of the tenant.">
                <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/40 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{tenant?.domain}</div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className={cn('h-2 w-2 rounded-full shrink-0', domainVerified ? 'bg-green-500' : 'bg-amber-500')} />
                        <span className={cn('text-[0.78rem]', domainVerified ? 'text-green-600 dark:text-green-500' : 'text-amber-600 dark:text-amber-400')}>
                          {domainVerified ? 'Ownership Verified' : 'Pending Verification'}
                        </span>
                      </div>
                    </div>
                    {!domainVerified && (
                      <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setDnsOpen(true)}>
                        <ShieldCheck size={14} /> Verify Domain
                      </Button>
                    )}
                  </div>
                </div>
              </Field>
            )}
          </>
        )}

        {tab === 'permissions' && <PermissionsTab groups={groups} setGroups={setGroups} />}

        {/* Mounted only while open, so the plan catalog is fetched on demand. */}
        {tab === 'plan' && tenant && <PlanTab tenant={tenant} />}

        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
    {dnsOpen && tenant && <DomainVerifyModal tenant={tenant} onClose={() => setDnsOpen(false)} />}
    </>
  );
}

/* ─── Plan tab (edit mode, active tenants) - the official MSP plan cards ───
 * REAL BILLING: Upgrade subscribes the tenant to a paid plan charged to the MSP account, so every
 * click goes through an explicit confirmation naming the tenant, the plan and the price. */
const PLAN_TILES: Record<string, { icon: typeof UsersIcon; cls: string }> = {
  team: { icon: UsersIcon, cls: 'bg-gradient-to-b from-sky-500 to-sky-300' },
  business: { icon: Briefcase, cls: 'bg-gradient-to-b from-netbird to-netbird-300' },
};
// EUR trails the amount, USD leads it - like the official card.
const money = (amount: number, currency: string) => (currency === 'eur' ? `${amount}€` : `$${amount}`);

function PlanTab({ tenant }: { tenant: MspTenant }) {
  const plans = useMspBillingPlans(true);
  const change = useChangeTenantPlan();
  const confirm = useConfirm();
  // The modal holds a snapshot of the tenant row, so the newly purchased tier is tracked locally;
  // the list behind it is refreshed by the mutation's invalidation.
  const [tier, setTier] = useState(String(tenant.plan?.tier || 'free').toLowerCase());
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState('');
  const [failed, setFailed] = useState('');

  const currency = plans.data?.currency || 'usd';
  const items = plans.data?.plans || [];

  const upgrade = async (plan: MspBillingPlan) => {
    const price = plan.priceMonthly != null ? money(plan.priceMonthly, currency) : 'the listed price';
    const ok = await confirm({
      title: `Upgrade To ${plan.name}`,
      message: (
        <span>
          This subscribes <span className="font-medium">{tenant.name}</span> to the {plan.name} plan at {price} per user / month,
          billed to your MSP account. This is a real billing change.
        </span>
      ),
      confirmText: 'Upgrade Plan',
      danger: true,
    });
    if (!ok) return;
    setBusy(plan.tier); setDone(''); setFailed('');
    try {
      await change.mutateAsync({ id: tenant.id, priceId: plan.priceId });
      setTier(plan.tier);
      setDone(`${tenant.name} is now on the ${plan.name} plan.`);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  if (plans.isLoading) return <LoadingState label="Loading Plans…" />;
  if (plans.error) {
    return <EmptyState icon={<CreditCard size={28} />} title="Plans Unavailable" hint={(plans.error as Error).message} />;
  }
  if (!items.length) {
    return <EmptyState icon={<CreditCard size={28} />} title="No Plans Available" hint="NetBird returned no upgradeable plans for this account." />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {items.map((p) => (
          <PlanCard key={p.name} plan={p} currency={currency} isCurrent={tier === p.tier}
            busy={busy === p.tier} disabled={!!busy || !p.priceId} onUpgrade={() => upgrade(p)} />
        ))}
      </div>
      {done && <p className="text-sm text-green-600 dark:text-green-500">{done}</p>}
      {failed && <p className="text-sm text-red-500">{failed}</p>}
    </div>
  );
}

function PlanCard({ plan, currency, isCurrent, busy, disabled, onUpgrade }: {
  plan: MspBillingPlan; currency: string; isCurrent: boolean; busy: boolean; disabled: boolean; onUpgrade: () => void;
}) {
  const tile = PLAN_TILES[plan.tier] || PLAN_TILES.team;
  const TileIcon = tile.icon;
  return (
    <div className="flex flex-col justify-between rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50/60 dark:bg-nb-gray-900/40 p-5">
      <div>
        <div className="flex items-center gap-3">
          <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-white', tile.cls)}>
            <TileIcon size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-[0.95rem] font-medium text-nb-gray-900 dark:text-nb-gray-100">{plan.name}</div>
            {plan.description && (
              <div className="truncate text-[0.8rem] text-nb-gray-500" title={plan.description}>{plan.description}</div>
            )}
          </div>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-nb-gray-900 dark:text-white">
            {plan.priceMonthly != null ? money(plan.priceMonthly, currency) : '-'}
          </span>
          <span className="text-sm text-nb-gray-500 dark:text-nb-gray-300">per user / month</span>
        </div>
        <div className="mt-4 flex flex-col gap-1 text-sm">
          <div className="flex items-center gap-2 text-netbird">
            <UsersIcon size={16} className="shrink-0" />
            <span className="text-nb-gray-700 dark:text-nb-gray-200">Unlimited Users</span>
          </div>
          <div className="flex items-center gap-2 text-netbird">
            <MonitorSmartphone size={16} className="shrink-0" />
            <span className="text-nb-gray-700 dark:text-nb-gray-200">100 machines + 10 per user</span>
          </div>
        </div>
        {!!plan.features.length && (
          <ul className="mt-4 mb-5 flex flex-col gap-1.5">
            {plan.features.map((f, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-nb-gray-700 dark:text-nb-gray-200">
                <Check size={16} className="shrink-0 text-netbird" />{f}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Button variant={isCurrent || plan.tier === 'team' ? 'secondary' : 'primary'} size="sm" className="w-full"
        disabled={isCurrent || disabled} onClick={onUpgrade}>
        {busy ? '…' : isCurrent ? 'Current Plan' : `Upgrade To ${plan.name}`}
      </Button>
    </div>
  );
}

/* ─── Permissions tab - official layout: Add Group button + per-group role rows ─── */
function PermissionsTab({ groups, setGroups }: { groups: TenantGroup[]; setGroups: (g: TenantGroup[]) => void }) {
  const allGroups = useGroups().data || [];
  const users = useUsers().data || [];
  const nameOf = (id: string) => allGroups.find((g) => g.id === id)?.name || id;
  const usersOf = (gid: string) => users.filter((u) => (u.groups || []).some((g) => g.id === gid));

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">Permissions (Required)</div>
          <p className="mt-0.5 text-[0.8rem] text-nb-gray-500">Add user groups to grant them access to this tenant.</p>
        </div>
        <AddGroupButton
          options={allGroups.filter((g) => !groups.some((x) => x.id === g.id)).map((g) => ({ id: g.id, name: g.name }))}
          onAdd={(id) => setGroups([...groups, { id, role: 'admin' }])}
        />
      </div>

      {groups.length > 0 && (
        <div className="mt-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-920/30 py-1.5">
          {groups.map((g) => {
            const role = TENANT_ROLES.find((r) => r.value === g.role) || TENANT_ROLES[0];
            const members = usersOf(g.id);
            return (
              <div key={g.id} className="flex items-center justify-between gap-3 py-2 px-4">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-flex items-center h-7 gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800/50 bg-nb-gray-100 dark:bg-nb-gray-900 px-2 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-300 min-w-0">
                    <FolderGit2 size={12} className="shrink-0 text-nb-gray-400" />
                    <span className="truncate max-w-[160px]">{nameOf(g.id)}</span>
                  </span>
                  <ArrowRight size={14} className="shrink-0 text-nb-gray-400" />
                  <MemberCluster members={members} />
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <ToolbarMenu icon={<role.icon size={14} />} label={role.label} value={g.role} align="end" width={170} portal
                    options={TENANT_ROLES.map((r) => ({ value: r.value, label: r.label }))}
                    onChange={(v) => setGroups(groups.map((x) => (x.id === g.id ? { ...x, role: v } : x)))} />
                  <IconButton onClick={() => setGroups(groups.filter((x) => x.id !== g.id))} title="Remove group">
                    <MinusCircle size={15} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* Avatar cluster + "N User(s)" that reveals the group's members on hover (portal - never clipped
 * by the modal's scroll container). Plain text when the group has no members. */
function MemberCluster({ members }: { members: NbUser[] }) {
  const cluster = (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <span className="flex -space-x-1.5">
        {members.slice(0, 3).map((u) => (
          <span key={u.id} title={u.name || u.email}
            className="h-5 w-5 rounded-full ring-2 ring-white dark:ring-nb-gray-950 bg-nb-gray-200 dark:bg-nb-gray-900 flex items-center justify-center uppercase text-[0.58rem] font-medium"
            style={{ color: avatarColor(u.name || u.email || '?') }}>
            {(u.name || u.email || '?').charAt(0)}
          </span>
        ))}
      </span>
      <span className="text-[0.8rem] text-nb-gray-500 whitespace-nowrap">{members.length} User{members.length === 1 ? '' : '(s)'}</span>
    </span>
  );
  if (!members.length) return cluster;
  const shown = members.slice(0, 12);
  return (
    <HoverCard width={260} trigger={cluster}>
      <div className="flex flex-col gap-1.5">
        {shown.map((u) => (
          <div key={u.id} className="flex items-center gap-2 min-w-0">
            <span className="h-6 w-6 shrink-0 rounded-full bg-nb-gray-200 dark:bg-nb-gray-900 flex items-center justify-center uppercase text-[0.6rem] font-medium"
              style={{ color: avatarColor(u.name || u.email || '?') }}>
              {(u.name || u.email || '?').charAt(0)}
            </span>
            <div className="min-w-0">
              <div className="text-[0.8rem] text-nb-gray-800 dark:text-nb-gray-100 truncate">{u.name || u.email || 'Unknown'}</div>
              {u.email && u.name && <div className="text-[0.72rem] text-nb-gray-500 truncate">{u.email}</div>}
            </div>
          </div>
        ))}
        {members.length > shown.length && (
          <div className="text-[0.72rem] text-nb-gray-500 pt-0.5">+{members.length - shown.length} more</div>
        )}
      </div>
    </HoverCard>
  );
}

/* Small anchored "Add Group" picker (button → searchable dropdown), like the official one. */
function AddGroupButton({ options, onAdd }: { options: { id: string; name: string }[]; onAdd: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const btnRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useEffect(() => { if (!open) setSearch(''); }, [open]);
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ left: Math.max(8, r.right - 300), top: r.bottom + 6 });
    };
    measure();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('resize', measure);
    document.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('resize', measure); document.removeEventListener('mousedown', onDown); };
  }, [open]);
  const q = search.toLowerCase().trim();
  const rows = options.filter((o) => !q || o.name.toLowerCase().includes(q));
  return (
    <>
      <div ref={btnRef} className="shrink-0">
        <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)}><Plus size={14} /> Add Group</Button>
      </div>
      {open && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', left: pos.left, top: pos.top, width: 300, zIndex: 1200 }}
          className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-nb-gray-200 dark:border-nb-gray-800">
            <SearchIcon size={14} className="shrink-0 text-nb-gray-400" />
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search groups..."
              className="w-full bg-transparent text-sm text-nb-gray-800 dark:text-nb-gray-200 placeholder:text-nb-gray-400 outline-none" />
          </div>
          <div className="nb-scroll max-h-[220px] overflow-y-auto p-1.5 flex flex-col gap-0.5">
            {rows.length ? rows.map((o) => (
              <button key={o.id} type="button" onClick={() => { onAdd(o.id); setOpen(false); }}
                className="flex items-center gap-2 w-full px-2 py-[7px] rounded-md text-left text-sm text-nb-gray-700 dark:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800/20 transition-colors">
                <FolderGit2 size={13} className="shrink-0 text-nb-gray-400" />
                <span className="truncate">{o.name}</span>
              </button>
            )) : <div className="px-3 py-4 text-center text-xs text-nb-gray-500">{q ? 'No matching groups.' : 'All groups already added.'}</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/* ─── Tenant API Access - the app-managed service user + token ───
 * Primary path: Provision Automatically (creates a service user named like the app inside
 * the tenant + a 365-day token, rotated by the scheduler). Manual paste stays as fallback. */
function TenantTokenModal({ tenant, onClose }: { tenant: MspTenant; onClose: () => void }) {
  const msp = useMspStatus().data;
  const provision = useProvisionTenant();
  const save = useSetTenantToken();
  const [token, setToken] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [provisioned, setProvisioned] = useState<{ serviceUser: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');

  const canProvision = !!msp?.hasProvisioningToken;
  const su = tenant.serviceUser;
  const daysLeft = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 86400_000));

  const doProvision = async () => {
    setError('');
    try { setProvisioned(await provision.mutateAsync(tenant.id)); }
    catch (e) { setError((e as Error).message); }
  };
  const saveManual = async (clear = false) => {
    setError('');
    try {
      await save.mutateAsync({ id: tenant.id, token: clear ? '' : token.trim() });
      onClose();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} icon={<KeyRound size={18} />} size="md"
      title="Tenant API Access"
      subtitle={`${tenant.name || tenant.domain} - the credentials used for all management calls to this tenant.`}
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-4">
        {provisioned ? (
          <div className="flex items-start gap-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3.5">
            <Check size={20} className="text-green-500 shrink-0" />
            <div className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
              <div className="font-semibold text-nb-gray-800 dark:text-nb-gray-100">Provisioned</div>
              <div className="mt-0.5 text-[0.8rem] text-nb-gray-500">
                Service user “{provisioned.serviceUser}” is set up in the tenant; its token is stored and expires {formatTimestamp(provisioned.expiresAt)} (auto-rotated before that).
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Current state - the VISIBLE record of the managed service user. */}
            {su ? (
              <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-940 divide-y divide-nb-gray-100 dark:divide-nb-gray-900/70">
                <InfoRow label="Service User" value={su.name} />
                <InfoRow label="Last Rotated" value={su.rotatedAt ? formatTimestamp(su.rotatedAt) : '-'} />
                <InfoRow label="Token Expires" value={su.expiresAt ? `${formatTimestamp(su.expiresAt)} (${daysLeft(su.expiresAt)} days)` : '-'}
                  warn={!!su.expiresAt && daysLeft(su.expiresAt) < 30} />
              </div>
            ) : (
              <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800/70 bg-nb-gray-100/60 dark:bg-nb-gray-900/70 px-4 py-3 text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300">
                No managed service user yet. Provisioning creates a service user named like this app inside the
                tenant, issues it a 365-day token and stores it here - rotation is automatic from then on.
                {tenant.hasApiToken && ' (A manually pasted token is currently in use.)'}
              </div>
            )}

            <div className="flex items-center gap-2.5">
              <Button variant="primary" onClick={doProvision}
                disabled={provision.isPending || !canProvision}
                title={canProvision ? undefined : 'Set the MSP Provisioning Token first (Settings - NetBird API)'}>
                <KeyRound size={15} /> {provision.isPending ? 'Provisioning…' : su ? 'Rotate Now' : 'Provision Automatically'}
              </Button>
              {!canProvision && (
                <span className="text-[0.78rem] text-amber-600 dark:text-amber-400">
                  Requires the MSP Provisioning Token (Settings → NetBird API).
                </span>
              )}
            </div>

            {/* Manual fallback - collapsed by default. */}
            <button type="button" onClick={() => setManualOpen((o) => !o)}
              className="self-start text-[0.8rem] text-nb-gray-500 hover:text-netbird transition-colors">
              {manualOpen ? 'Hide manual token' : 'Manual Token (Advanced)'}
            </button>
            {manualOpen && (
              <div className="flex flex-col gap-3">
                <Field label="Access Token" hint="A PAT created inside the tenant (Team → Service Users). Write-only; NOT auto-rotated - prefer provisioning.">
                  <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={tenant.hasApiToken ? '•••• configured' : 'nbp_...'} />
                </Field>
                <div className="flex items-center gap-2.5">
                  <Button variant="secondary" size="sm" onClick={() => saveManual(false)} disabled={save.isPending || !token.trim()}>Save Token</Button>
                  {tenant.hasApiToken && (
                    <Button variant="secondary" size="sm" className="text-red-500" onClick={() => saveManual(true)} disabled={save.isPending}>Clear Token</Button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

function InfoRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="text-[0.82rem] font-medium text-nb-gray-800 dark:text-nb-gray-100 shrink-0">{label}</span>
      <span className={cn('min-w-0 truncate text-[0.82rem]', warn ? 'text-amber-600 dark:text-amber-400' : 'text-nb-gray-500 dark:text-nb-gray-400')}>{value}</span>
    </div>
  );
}

/* ─── Settings Sync (drift) - compare a tenant's Event Filtering + Blocklist + Data Retention
 * (and webhook token status) against MAIN's current config, and one-click apply main's config
 * to the tenant. Webhook tokens are compared but never overwritten by Apply. ─── */
function TenantDriftModal({ tenant, onClose }: { tenant: MspTenant; onClose: () => void }) {
  const drift = useTenantDrift(tenant.id);
  const apply = useApplyTenantDefaults();
  const confirm = useConfirm();
  const [error, setError] = useState('');

  const items = drift.data?.items || [];
  const inSync = items.length > 0 && items.every((i) => i.match);

  const doApply = async () => {
    const ok = await confirm({
      title: 'Apply Tenant Defaults?',
      message: `This applies the Tenant Defaults profile (Settings - Tenant Defaults) to ${tenant.name || tenant.domain}, REPLACING its Event Filtering, Blocklist and Data Retention, and the tenant's NetBird account settings (login expiration, peer approval, groups propagation and more). The tenant's own entries for those are overwritten. Webhook tokens are NOT touched. This can't be undone.`,
      confirmText: 'Apply',
    });
    if (!ok) return;
    setError('');
    try {
      await apply.mutateAsync(tenant.id);
      await drift.refetch();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} icon={<GitCompareArrows size={18} />} size="md"
      title="Settings Sync"
      subtitle={`${tenant.name || tenant.domain} - this tenant's configuration compared with the Tenant Defaults profile.`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          <Button variant="primary" size="sm" onClick={doApply} disabled={apply.isPending || drift.isLoading}>
            {apply.isPending ? 'Applying…' : 'Apply Defaults'}
          </Button>
        </>
      }>
      <div className="flex flex-col gap-4">
        {drift.isLoading ? (
          <LoadingState />
        ) : drift.isError ? (
          <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800/70 bg-nb-gray-100/60 dark:bg-nb-gray-900/70 px-4 py-3 text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300">
            Couldn't load the comparison: {(drift.error as Error).message}
          </div>
        ) : (
          <>
            <div className={cn('flex items-center gap-2 text-[0.82rem]', inSync ? 'text-green-600 dark:text-green-500' : 'text-amber-600 dark:text-amber-400')}>
              {inSync
                ? <><Check size={15} className="shrink-0" /> In sync with the defaults.</>
                : <><span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" /> Some settings differ from the defaults.</>}
            </div>

            <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-940 overflow-hidden">
              <div className="grid grid-cols-[1.5fr_1fr_1fr] gap-3 px-4 py-2 border-b border-nb-gray-100 dark:border-nb-gray-900/70 text-[0.68rem] font-medium uppercase tracking-wide text-nb-gray-400">
                <span>Setting</span><span>Default</span><span>Tenant</span>
              </div>
              <div className="nb-scroll divide-y divide-nb-gray-100 dark:divide-nb-gray-900/70 max-h-[360px] overflow-y-auto">
                {items.map((row) => {
                  // Token rows show Configured/Not Configured (main is '-'); NetBird rows (key 'nb.*')
                  // carry real On/Off values - never treat them as token rows even when main is '-'.
                  const isToken = !row.key.startsWith('nb.') && (row.key.toLowerCase().includes('token') || row.main === '-');
                  return (
                    <div key={row.key} className="grid grid-cols-[1.5fr_1fr_1fr] gap-3 px-4 py-2.5 items-center">
                      <span className="flex items-center gap-2 min-w-0">
                        {row.match
                          ? <Check size={15} className="shrink-0 text-green-500" />
                          : <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />}
                        <span className="truncate text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200" title={row.label}>{row.label}</span>
                      </span>
                      <span className="truncate text-[0.8rem] text-nb-gray-500" title={row.main}>{row.main || '-'}</span>
                      <span className={cn('truncate text-[0.8rem]', row.match ? 'text-nb-gray-500 dark:text-nb-gray-400' : 'text-amber-600 dark:text-amber-400')}
                        title={isToken ? undefined : row.tenant}>
                        {isToken ? (row.match ? 'Configured' : 'Not Configured') : (row.tenant || '-')}
                      </span>
                    </div>
                  );
                })}
                {!items.length && (
                  <div className="px-4 py-4 text-center text-xs text-nb-gray-500">Nothing to compare.</div>
                )}
              </div>
            </div>

            <p className="text-[0.78rem] text-nb-gray-500">
              Apply replaces this tenant's Event Filtering, Blocklist, Data Retention and NetBird account
              settings with the Tenant Defaults profile. Webhook tokens are shown for reference only and are never overwritten.
            </p>
            {error && <p className="text-sm text-red-500">{error}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ─── Domain ownership verification - official layout: numbered steps, TXT card, support box ─── */
function DomainVerifyModal({ tenant, initialChallenge, onClose }: {
  tenant: MspTenant;
  initialChallenge?: string;
  onClose: () => void;
}) {
  const verify = useVerifyTenantDomain();
  const [challenge, setChallenge] = useState(initialChallenge || '');
  const alreadyVerified = !!tenant.activatedAt || String(tenant.status).toLowerCase() === 'active';
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const fetchedRef = useRef(false);

  // On open, if we weren't handed a challenge, fetch it once so the Host/Value TXT rows are
  // populated immediately (a not-yet-verified domain returns its challenge). Guarded so it
  // fires a single time regardless of re-renders.
  useEffect(() => {
    if (fetchedRef.current || initialChallenge || alreadyVerified) return;
    fetchedRef.current = true;
    (async () => {
      try {
        const out = await verify.mutateAsync(tenant.id);
        if (out.verified) setVerified(true);
        else if (out.dnsChallenge) setChallenge(out.dnsChallenge);
      } catch { /* silent - the user can retry with the action button */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = async () => {
    setError('');
    try {
      const out = await verify.mutateAsync(tenant.id);
      if (out.verified) { setVerified(true); return; }
      if (out.dnsChallenge) setChallenge(out.dnsChallenge);
      setError("DNS record not found. DNS changes may take some time to apply - please try again later.");
    } catch (e) { setError((e as Error).message); }
  };

  const mark = (t: string) => (
    <span className="inline-flex items-center rounded border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 px-1.5 py-0.5 font-mono text-[0.74rem] text-nb-gray-700 dark:text-nb-gray-200">{t}</span>
  );

  return (
    <Modal open onClose={onClose} icon={<Globe size={18} />} size="md"
      title="Verify Domain Ownership"
      subtitle={tenant.domain}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>{verified ? 'Close' : 'Verify Later'}</Button>
          {!verified && <Button variant="primary" size="sm" onClick={check} disabled={verify.isPending}>{verify.isPending ? 'Verifying…' : 'Check Again'}</Button>}
        </>
      }>
      {verified ? (
        <div className="flex items-start gap-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3.5">
          <Check size={20} className="text-green-500 shrink-0" />
          <div className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
            <div className="font-semibold text-nb-gray-800 dark:text-nb-gray-100">Domain Verified</div>
            <div className="mt-0.5 text-[0.8rem] text-nb-gray-500">The tenant is being activated - it may take a moment to show as Active.</div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {/* Numbered steps with a connecting line, like the official modal. */}
          <div className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-nb-gray-300 dark:border-nb-gray-700 text-[0.72rem] text-nb-gray-600 dark:text-nb-gray-300">1</span>
              <span className="w-px flex-1 bg-nb-gray-200 dark:bg-nb-gray-800 my-1" />
            </div>
            <p className="pb-4 text-sm text-nb-gray-700 dark:text-nb-gray-200">
              Sign in to your domain name provider (e.g. cloudflare.com or godaddy.com)
            </p>
          </div>
          <div className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-nb-gray-300 dark:border-nb-gray-700 text-[0.72rem] text-nb-gray-600 dark:text-nb-gray-300">2</span>
            <p className="pb-4 text-sm text-nb-gray-700 dark:text-nb-gray-200">
              Copy the {mark('TXT record')} below and add it to your DNS configuration for {mark(tenant.domain)}
            </p>
          </div>

          {/* The TXT record card - label left, value right, copy icon. */}
          <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-940 divide-y divide-nb-gray-100 dark:divide-nb-gray-900/70">
            <TxtRow label="Host" value={tenant.domain} />
            <TxtRow label="Value" value={challenge ? `nb-verification=${challenge}` : ''} placeholder={verify.isPending ? 'Loading…' : '(no challenge returned - try Check Again)'} />
          </div>

          <p className="mt-4 text-[0.8rem] text-nb-gray-500">
            Note: DNS changes may take some time to apply. If NetBird doesn't find the record immediately, please wait and try again.
          </p>

          {error && <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function TxtRow({ label, value, placeholder }: { label: string; value: string; placeholder?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-[0.85rem] font-semibold text-nb-gray-800 dark:text-nb-gray-100 shrink-0">{label}</span>
      <span className={cn('min-w-0 flex items-center gap-2 font-mono text-[0.8rem]', value ? 'text-nb-gray-500 dark:text-nb-gray-400' : 'text-nb-gray-400 italic')}>
        <span className="truncate" title={value || undefined}>{value || placeholder}</span>
        {value && (
          <button type="button" onClick={copy} title={`Copy ${label}`} className="shrink-0 text-nb-gray-400 hover:text-netbird transition-colors">
            {copied ? <Check size={14} className="text-green-500" /> : <CopyIcon size={14} />}
          </button>
        )}
      </span>
    </div>
  );
}
