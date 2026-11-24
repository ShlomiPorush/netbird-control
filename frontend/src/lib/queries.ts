import { useQuery } from '@tanstack/react-query';
import type { CaCertInfo } from './types';
import { api, getTenantMode } from './api';
import type {
  Viewer, LogsResponse, AdminLogsResponse, AuditResponse, IpHistoryResponse, TrafficSummaryResponse, ReverseProxyStatus, ProxyLogsResponse, ProxyLogsSummaryResponse, ProxyServiceStats, ProxyDomain, EditableProxyService, ProxyTargetOptions, NbUser, Peer, PeerDetail, NbGroup, GroupDetail, UserDetail,
  Network, NetworkDetail, Policy, PolicyOptions, TemplatesResponse, GroupRef, FilterRulesResponse, AppConfig, NetbirdApiConfig, WebhookConfig, NetbirdWebhookStatus, TelegramConfig, SmtpConfig, ApproverConfig, AutoApprovalConfig, FeaturePermsConfig, RecurringAccessRule, SecurityConfig, EdrAutoBypassConfig, RetentionStatus, SearchResult, AccessProfile, AccessProfileUsage, NetworkDefaultProfiles, PostureCheck, Country, CityRef, Automation, AutomationRun, AutomationManaged, BlocklistEntry, TemporaryAccessGrant, AccessRequest, RequestTargetResult, SystemHealth, Recertification, RecertRoundSummary, RecertRoundDetail, ResourceConflict, OutboundEntry, OutboundBody, CleanupReport, DiagnosticsInfo, NbNotice, MspStatus, MspTenant, MspBillingPlans, TenantOverview, MspSwitcherItem, TenantDrift, TenantDefaultsResponse, NetbirdSettingsResponse, FleetReport, MspDigestConfig, InternalBackupStatus, InviteDefaultGroups, TrafficPullStatus, AuditPullStatus,
  AccessCheckOptions, UserAccessResult, WhoHasAccessResult, NetbirdCloudStatus,
} from './types';

export type LogParams = {
  page?: number;
  per_page?: number;
  search?: string;
  source?: string;
  destination?: string;
  type?: string;
  protocol?: string;
  user?: string;
  from?: string;
  to?: string;
  category?: string;
  sort?: string;
  dir?: string;
};

const REFRESH_MS = 10_000;

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Viewer>('/api/me'),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useVersion() {
  return useQuery({ queryKey: ['version'], queryFn: () => api.version(), staleTime: Infinity });
}

// Available to every user.
export function useAppConfig() {
  return useQuery({ queryKey: ['app-config'], queryFn: () => api.get<AppConfig>('/api/app-config'), staleTime: 5 * 60_000 });
}

// Admin only. Never includes the token.
export function useNetbirdApiConfig(enabled = true) {
  return useQuery({ queryKey: ['netbird-api'], queryFn: () => api.get<NetbirdApiConfig>('/api/integrations/netbird'), enabled });
}

// Admin only. Never includes the token.
export function useWebhookConfig(enabled = true) {
  return useQuery({ queryKey: ['webhook-config'], queryFn: () => api.get<WebhookConfig>('/api/integrations/webhook'), enabled });
}

// Admin only. Kept separate from the config query because it hits the NetBird API and can be slow /
// plan-gated; the UI shows it with its own loading state. Refetches so the badge reflects config changes.
export function useNetbirdWebhookStatus(enabled = true) {
  return useQuery({
    queryKey: ['webhook-nb-status'],
    queryFn: () => api.get<NetbirdWebhookStatus>('/api/integrations/webhook/nb-status'),
    enabled, staleTime: 30_000, refetchInterval: 60_000,
  });
}

// Admin only.
export function useTrafficPull(enabled = true) {
  return useQuery({ queryKey: ['traffic-pull'], queryFn: () => api.get<TrafficPullStatus>('/api/traffic-pull'), enabled });
}

// Admin only.
export function useAuditPull(enabled = true) {
  return useQuery({ queryKey: ['audit-pull'], queryFn: () => api.get<AuditPullStatus>('/api/audit-pull'), enabled });
}

// Admin only. Never includes the bot token.
export function useTelegramConfig(enabled = true) {
  return useQuery({ queryKey: ['telegram'], queryFn: () => api.get<TelegramConfig>('/api/integrations/telegram'), enabled });
}

// Admin only. Password never returned.
export function useSmtpConfig(enabled = true) {
  return useQuery({ queryKey: ['smtp'], queryFn: () => api.get<SmtpConfig>('/api/integrations/smtp'), enabled });
}

// Admin only.
export function useApproverConfig(enabled = true) {
  return useQuery({ queryKey: ['approver-config'], queryFn: () => api.get<ApproverConfig>('/api/approver-config'), enabled });
}

// Admin only.
export function useAutoApprovalConfig(enabled = true) {
  return useQuery({ queryKey: ['auto-approval-config'], queryFn: () => api.get<AutoApprovalConfig>('/api/auto-approval-config'), enabled });
}

export function useRecurringAccess(enabled = true) {
  return useQuery({ queryKey: ['recurring-access'], queryFn: () => api.get<RecurringAccessRule[]>('/api/recurring-access'), enabled });
}

// Admin only.
export function useSecurityConfig(enabled = true) {
  return useQuery({ queryKey: ['security-config'], queryFn: () => api.get<SecurityConfig>('/api/security-config'), enabled });
}

// Admin only. Per account - tenant-aware, like data retention.
export function useEdrAutoBypass(enabled = true) {
  return useQuery({ queryKey: ['edr-auto-bypass'], queryFn: () => api.get<EdrAutoBypassConfig>('/api/edr-auto-bypass'), enabled });
}

// Admin only. Tenant-aware - works in tenant mode too, where the rest of security-config stays main-only.
export function useRetention(enabled = true) {
  return useQuery({ queryKey: ['data-retention'], queryFn: () => api.get<RetentionStatus>('/api/data-retention'), enabled });
}

export function usePeerTags(enabled = true) {
  return useQuery({ queryKey: ['peer-tags'], queryFn: () => api.get<string[]>('/api/peer-tags'), enabled });
}

// Admin only.
export function useRecertification(enabled = true) {
  return useQuery({ queryKey: ['recertification'], queryFn: () => api.get<Recertification>('/api/recertification'), enabled });
}
export function useRecertRounds(enabled = true) {
  return useQuery({ queryKey: ['recert-rounds'], queryFn: () => api.get<RecertRoundSummary[]>('/api/recertification/rounds'), enabled });
}
export function useRecertRound(id: number | null) {
  return useQuery({
    queryKey: ['recert-round', id],
    queryFn: () => api.get<RecertRoundDetail>(`/api/recertification/rounds/${id!}`),
    enabled: id != null,
  });
}

// Access Check - who has access to what, read fresh from NetBird on every check (no polling).
export function useAccessCheckOptions(enabled = true) {
  return useQuery({ queryKey: ['access-check-options'], queryFn: () => api.get<AccessCheckOptions>('/api/access-check/options'), enabled, staleTime: 60_000 });
}
export type AccessCheckParams = { type: 'resource' | 'network'; id: string; protocol: string; port: string };
export function useUserAccessCheck(userId: string, p: AccessCheckParams | null) {
  return useQuery({
    queryKey: ['access-check-user', userId, p],
    queryFn: () => api.get<UserAccessResult>('/api/access-check/user', { user_id: userId, ...p! }),
    enabled: !!userId && !!p,
    retry: false,
    staleTime: 0,
  });
}
export function useWhoHasAccess(p: AccessCheckParams | null) {
  return useQuery({
    queryKey: ['access-check-target', p],
    queryFn: () => api.get<WhoHasAccessResult>('/api/access-check/target', { ...p! }),
    enabled: !!p,
    retry: false,
    staleTime: 0,
  });
}

export function useNetbirdCloudStatus() {
  return useQuery({
    queryKey: ['netbird-cloud-status'],
    queryFn: () => api.get<NetbirdCloudStatus>('/api/netbird-cloud-status'),
    refetchInterval: 60_000,
  });
}

// Admin only. Refreshes so a failing scheduler surfaces without a manual reload.
export function useSystemHealth(enabled = true) {
  return useQuery({
    queryKey: ['system-health'],
    queryFn: () => api.get<SystemHealth>('/api/system-health'),
    enabled,
    refetchInterval: 30000,
  });
}

// Admin only.
export function useFeaturePerms(enabled = true) {
  return useQuery({ queryKey: ['feature-permissions'], queryFn: () => api.get<FeaturePermsConfig>('/api/feature-permissions'), enabled });
}

// Results are permission-filtered.
export function useSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<{ results: SearchResult[] }>('/api/search', { q }),
    enabled: enabled && q.trim().length >= 1,
    placeholderData: (prev) => prev,
  });
}

// Live-poll the logs/events views. Refresh page 1 (the live view, newest first); pause on deeper
// pages so it doesn't shift rows out from under someone browsing history. Filtered views still
// auto-refresh (placeholderData keeps it smooth - no loading flash).
function logsAutoRefresh(params: LogParams): number | false {
  return params.page && params.page > 1 ? false : REFRESH_MS;
}

export function useLogs(params: LogParams, enabled = true) {
  return useQuery({
    queryKey: ['logs', params],
    // The signal aborts the request once its filters are replaced, and the server then stops
    // the database query, so typing a search never stacks full scans.
    queryFn: ({ signal }) => api.get<LogsResponse>('/api/logs', params, signal),
    refetchInterval: logsAutoRefresh(params),
    placeholderData: (prev) => prev,
    enabled,
  });
}

export function useAdminLogs(params: LogParams) {
  return useQuery({
    queryKey: ['admin-logs', params],
    queryFn: () => api.get<AdminLogsResponse>('/api/admin-logs', params),
    refetchInterval: logsAutoRefresh(params),
    placeholderData: (prev) => prev,
  });
}

export function useLogSummary(params: LogParams, enabled = true) {
  return useQuery({
    queryKey: ['logs-summary', params],
    queryFn: ({ signal }) => api.get<TrafficSummaryResponse>('/api/logs/summary', params, signal),
    refetchInterval: logsAutoRefresh(params),
    placeholderData: (prev) => prev,
    enabled,
  });
}

// Reverse-proxy access logs (which host/path each request hit). Paging + search are
// server-side - NetBird's search covers request id, host, path, source IP and user.
export interface ProxyLogFilters {
  status: string; method: string; userId: string; location: string; from?: string; to?: string;
  /** Pair drill-down (summary row expansion): exact service, and optionally anonymous-only. */
  serviceId?: string; userEmpty?: boolean;
}
export function useProxyAccessLogs(page: number, perPage: number, search: string, f: ProxyLogFilters, enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-logs', page, perPage, search, f],
    queryFn: () => api.get<ProxyLogsResponse>('/api/reverse-proxy-logs', {
      page: String(page), per_page: String(perPage),
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(f.status !== 'all' ? { status: f.status } : {}),
      ...(f.method !== 'all' ? { method: f.method } : {}),
      ...(f.userId ? { user_id: f.userId } : {}),
      ...(f.userEmpty ? { user_empty: '1' } : {}),
      ...(f.serviceId ? { service_id: f.serviceId } : {}),
      ...(f.location.trim() ? { location: f.location.trim() } : {}),
      ...(f.from ? { from: f.from } : {}),
      ...(f.to ? { to: f.to } : {}),
    }),
    enabled,
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
}

export function useProxyLogsSummary(search: string, f: ProxyLogFilters, enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-logs-summary', search, f],
    queryFn: () => api.get<ProxyLogsSummaryResponse>('/api/reverse-proxy-logs/summary', {
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(f.status !== 'all' ? { status: f.status } : {}),
      ...(f.method !== 'all' ? { method: f.method } : {}),
      ...(f.userId ? { user_id: f.userId } : {}),
      ...(f.userEmpty ? { user_empty: '1' } : {}),
      ...(f.serviceId ? { service_id: f.serviceId } : {}),
      ...(f.location.trim() ? { location: f.location.trim() } : {}),
      ...(f.from ? { from: f.from } : {}),
      ...(f.to ? { to: f.to } : {}),
    }),
    enabled,
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
}

// Auth secrets are stripped server-side.
export function useProxyServiceDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['reverse-proxy-service', id],
    queryFn: () => api.get<EditableProxyService>(`/api/reverse-proxy-services/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

export function useProxyTargetOptions(enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-target-options'],
    queryFn: () => api.get<ProxyTargetOptions>('/api/reverse-proxy-target-options'),
    enabled,
    staleTime: 60_000,
  });
}

export function useProxyDomains(enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-domains'],
    queryFn: () => api.get<ProxyDomain[]>('/api/reverse-proxy-domains'),
    enabled,
    staleTime: 60_000,
  });
}

// Whole-history totals per service (statistics on the Services tab rows).
export function useProxyServiceStats(enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-service-stats'],
    queryFn: () => api.get<ProxyServiceStats[]>('/api/reverse-proxy-logs/service-stats'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useProxyLogUsers(enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-log-users'],
    queryFn: () => api.get<{ user_id: string; display_name: string; email: string }[]>('/api/reverse-proxy-logs/users'),
    enabled,
    staleTime: 60_000,
  });
}

// Admin only; hidden on self-hosted.
export function useReverseProxyStatus(enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-status'],
    queryFn: () => api.get<ReverseProxyStatus>('/api/reverse-proxy-status'),
    refetchInterval: 60_000,
    enabled,
  });
}

// A restricted user gets only their own traffic.
export interface HourlyStat { hour: string; count: number }
export function useHourlyStats(hours = 24) {
  return useQuery({
    queryKey: ['stats-hourly', hours],
    queryFn: () => api.get<HourlyStat[]>('/api/stats/hourly', { hours }),
    refetchInterval: 60_000,
  });
}

// Admin only.
export function useIpHistory(params: { q?: string; at?: string; user?: string; sort?: string; dir?: string; page?: number; per_page?: number }) {
  return useQuery({
    queryKey: ['ip-history', params],
    queryFn: () => api.get<IpHistoryResponse>('/api/ip-history', params),
    placeholderData: (prev) => prev,
  });
}

// Audit-view gated.
export function useIpHistoryUsers(enabled = true) {
  return useQuery({ queryKey: ['ip-history-users'], queryFn: () => api.get<LogUser[]>('/api/ip-history/users'), enabled });
}

// Admin only.
export function useAuditLog(params: LogParams) {
  return useQuery({
    queryKey: ['audit', params],
    queryFn: () => api.get<AuditResponse>('/api/audit', params),
    refetchInterval: logsAutoRefresh(params),
    placeholderData: (prev) => prev,
  });
}

export interface OutboundResponse {
  rows: OutboundEntry[];
  total: number;
  /** See LogsResponse.totalCapped - the server stops counting at its cap. */
  totalCapped?: boolean;
  page: number;
  per_page: number;
  total_pages: number;
}
export function useOutboundLog(params: LogParams & { channel?: string; status?: string }) {
  return useQuery({
    queryKey: ['outbound-log', params],
    queryFn: () => api.get<OutboundResponse>('/api/outbound-log', params),
    refetchInterval: logsAutoRefresh(params),
    placeholderData: (prev) => prev,
  });
}
// The full rendered body of one sent message (preview modal). staleTime Infinity - a sent message
// never changes, so once fetched it is cached for the session.
export function useOutboundBody(id: number | null) {
  return useQuery({
    queryKey: ['outbound-body', id],
    queryFn: () => api.get<OutboundBody>(`/api/outbound-log/${id}/body`),
    enabled: id != null,
    staleTime: Infinity,
  });
}

// ─── MSP tenants (NetBird Cloud MSP portal) ───
// Availability of the whole feature - non-MSP accounts get { available: false } and the UI
// hides Tenants entirely. Cached long: activation status changes ~never.
export function useMspStatus(enabled = true) {
  return useQuery({
    queryKey: ['msp-status'],
    queryFn: () => api.get<MspStatus>('/api/msp/status'),
    enabled,
    staleTime: 5 * 60_000,
  });
}
export function useMspTenants(enabled = true) {
  return useQuery({
    queryKey: ['msp-tenants'],
    queryFn: () => api.get<MspTenant[]>('/api/msp/tenants'),
    enabled,
    refetchInterval: 60_000,
  });
}
export function useMspSwitcher(enabled = true) {
  return useQuery({
    queryKey: ['msp-switcher'],
    queryFn: () => api.get<MspSwitcherItem[]>('/api/msp/switcher'),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
// Settings Sync: the tenant's settings and webhook tokens compared against main's current config.
export function useTenantDrift(id: string | null) {
  return useQuery({
    queryKey: ['msp-tenant-drift', id],
    queryFn: () => api.get<TenantDrift>(`/api/msp/tenants/${encodeURIComponent(id!)}/drift`),
    enabled: id != null,
  });
}
// Admin, main account only. Only meaningful on MSP accounts.
export function useTenantDefaults(enabled = true) {
  return useQuery({
    queryKey: ['tenant-defaults'],
    queryFn: () => api.get<TenantDefaultsResponse>('/api/tenant-defaults'),
    enabled,
  });
}
// Admin. The CURRENT account's own settings (main, or the managed tenant's account), not the Tenant
// Defaults seed template. Separate query key per tenant so switching accounts never serves a stale
// settings object.
export function useNetbirdSettings() {
  return useQuery({
    queryKey: ['netbird-settings', getTenantMode() || 'main'],
    queryFn: () => api.get<NetbirdSettingsResponse>('/api/netbird-settings'),
  });
}
// Admin, main account only.
export function useFleetReport(enabled = true) {
  return useQuery({
    queryKey: ['msp-fleet-report'],
    queryFn: () => api.get<FleetReport>('/api/msp/fleet-report'),
    enabled,
    staleTime: 60_000,
  });
}
// Admin, main account only.
export function useMspDigest(enabled = true) {
  return useQuery({
    queryKey: ['msp-digest'],
    queryFn: () => api.get<MspDigestConfig>('/api/msp-digest'),
    enabled,
  });
}
// Backed by a ~10 min server cache; only fetched while the tenant modal's Plan tab is open.
export function useMspBillingPlans(enabled = true) {
  return useQuery({
    queryKey: ['msp-billing-plans'],
    queryFn: () => api.get<MspBillingPlans>('/api/msp/billing-plans'),
    enabled,
    staleTime: 10 * 60_000,
  });
}
export function useTenantOverview(id: string | undefined) {
  return useQuery({
    queryKey: ['msp-tenant-overview', id],
    queryFn: () => api.get<TenantOverview>(`/api/msp/tenants/${encodeURIComponent(id!)}/overview`),
    enabled: !!id,
  });
}

// Known-issue notices from NetBird's notification webhook (routing peers down;
// integration problems for admins). Shown on Troubleshoot and the dashboard.
export function useDiagNotices() {
  return useQuery({
    queryKey: ['diag-notices'],
    queryFn: () => api.get<{ notices: NbNotice[] }>('/api/diagnostics/notices'),
    refetchInterval: 60_000,
  });
}

// Troubleshoot page: browser-check hosts + "which device is this browser on" (IP match).
export function useDiagnosticsInfo() {
  return useQuery({
    queryKey: ['diagnostics-info'],
    queryFn: () => api.get<DiagnosticsInfo>('/api/diagnostics/info'),
    staleTime: 60_000,
  });
}

// Admin only.
export function useCleanupScan(staleDays: number) {
  return useQuery({
    queryKey: ['cleanup-scan', staleDays],
    queryFn: () => api.get<CleanupReport>('/api/cleanup-scan', { stale_days: staleDays }),
    staleTime: 60_000,
  });
}

export function useUsers(enabled = true) {
  return useQuery({ queryKey: ['users'], queryFn: () => api.get<NbUser[]>('/api/users'), enabled });
}

// Admin only.
export interface LogUser { user_id: string; display_name?: string; email?: string }
export function useLogUsers(enabled = true) {
  return useQuery({ queryKey: ['log-users'], queryFn: () => api.get<LogUser[]>('/api/logs/users'), enabled });
}

// The server returns all peers (each tagged with `kind`); the User Devices / Servers
// split is done client-side.
// `own: true` limits a NON-admin viewer to their own devices even when they hold
// View All Peers / Manage All Networks (self-service flows like Troubleshoot).
export function usePeers(enabled = true, own = false) {
  return useQuery({ queryKey: ['peers', own], queryFn: () => api.get<Peer[]>('/api/peers', own ? { own: 1 } : undefined), enabled });
}

export function usePeerDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['peer-detail', id],
    queryFn: () => api.get<PeerDetail>(`/api/peers/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

// Admin only.
export function useGroups(enabled = true) {
  return useQuery({ queryKey: ['groups'], queryFn: () => api.get<NbGroup[]>('/api/groups'), enabled });
}

// Admin only, per account. Fetched only while the modal is open, so non-admin pages never hit the endpoint.
export function useInviteDefaultGroups(enabled = true) {
  return useQuery({
    queryKey: ['invite-defaults'],
    queryFn: () => api.get<InviteDefaultGroups>('/api/users/invite-defaults'),
    enabled,
  });
}

export function useGroupDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['group-detail', id],
    queryFn: () => api.get<GroupDetail>(`/api/groups/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

export function useUserDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['user-detail', id],
    queryFn: () => api.get<UserDetail>(`/api/users/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

export function useNetworks() {
  return useQuery({ queryKey: ['networks'], queryFn: () => api.get<Network[]>('/api/networks') });
}

export function useNetworkDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['network-detail', id],
    queryFn: () => api.get<NetworkDetail>(`/api/networks/${encodeURIComponent(id!)}/detail`),
    enabled: !!id,
  });
}

export function usePolicyOptions(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['policy-options', id],
    queryFn: () => api.get<PolicyOptions>(`/api/networks/${encodeURIComponent(id!)}/policy-options`),
    enabled: !!id && enabled,
  });
}

// Admin only.
export function usePolicies(enabled = true) {
  return useQuery({ queryKey: ['policies'], queryFn: () => api.get<Policy[]>('/api/policies'), enabled });
}

export function useTemplates(enabled = true) {
  return useQuery({ queryKey: ['templates'], queryFn: () => api.get<TemplatesResponse>('/api/templates'), enabled });
}

export function useAdGroups(enabled = true) {
  return useQuery({ queryKey: ['ad-groups'], queryFn: () => api.get<GroupRef[]>('/api/ad-groups'), enabled });
}

export function useAccessProfiles(enabled = true) {
  return useQuery({ queryKey: ['access-profiles'], queryFn: () => api.get<AccessProfile[]>('/api/access-profiles'), enabled });
}

// Admin only. Any change elsewhere can add or end a use: the key sits under 'access-profiles', so what
// refreshes the profiles refreshes this, and staleTime 0 reads it again whenever its page opens.
export function useAccessProfileUsage(enabled = true) {
  return useQuery({ queryKey: ['access-profiles', 'usage'], queryFn: () => api.get<AccessProfileUsage>('/api/access-profiles/usage'), enabled, staleTime: 0 });
}

// Admin only.
export function useNetworkDefaultProfiles(enabled = true) {
  return useQuery({ queryKey: ['network-default-profiles'], queryFn: () => api.get<NetworkDefaultProfiles>('/api/network-default-profiles'), enabled });
}

export function usePostureChecks(enabled = true) {
  return useQuery({ queryKey: ['posture-checks'], queryFn: () => api.get<PostureCheck[]>('/api/posture-checks'), enabled });
}

export function useCountries(enabled = true) {
  return useQuery({ queryKey: ['countries'], queryFn: () => api.get<Country[]>('/api/locations/countries'), enabled, staleTime: Infinity });
}

export function useCities(countryCode: string | undefined) {
  return useQuery({
    queryKey: ['cities', countryCode],
    queryFn: () => api.get<CityRef[]>(`/api/locations/countries/${encodeURIComponent(countryCode!)}/cities`),
    enabled: !!countryCode,
    staleTime: Infinity,
  });
}

// Admin only.
export function useAutomations(enabled = true) {
  return useQuery({ queryKey: ['automations'], queryFn: () => api.get<Automation[]>('/api/automations'), enabled });
}

export function useAutomationRuns(id: number | undefined, enabled = true) {
  return useQuery({
    queryKey: ['automation-runs', id],
    queryFn: () => api.get<AutomationRun[]>(`/api/automations/${id}/runs`),
    enabled: !!id && enabled,
  });
}

export function useAutomationManaged(id: number | undefined, enabled = true) {
  return useQuery({
    queryKey: ['automation-managed', id],
    queryFn: () => api.get<AutomationManaged>(`/api/automations/${id}/managed`),
    enabled: !!id && enabled,
  });
}

// Readable by any editor, for inline checks.
export function useBlocklist(enabled = true) {
  return useQuery({ queryKey: ['blocklist'], queryFn: () => api.get<BlocklistEntry[]>('/api/blocklist'), enabled });
}

export function useFilterRules(enabled = true) {
  return useQuery({ queryKey: ['filter-rules'], queryFn: () => api.get<FilterRulesResponse>('/api/filter-rules'), enabled });
}

// Admin only. Polls so the countdown / auto-revoke stays live.
export function useTemporaryAccessGrants(enabled = true) {
  return useQuery({
    queryKey: ['temporary-access-grants'],
    queryFn: () => api.get<TemporaryAccessGrant[]>('/api/temporary-access'),
    enabled,
    refetchInterval: 30_000,
  });
}

// ── Access requests ──
export function useAccessRequests(status?: string, enabled = true) {
  return useQuery({
    queryKey: ['access-requests', status || 'all'],
    queryFn: () => api.get<AccessRequest[]>('/api/access-requests', status ? { status } : undefined),
    enabled,
    refetchInterval: 20_000,
  });
}
export function useMyAccessRequests(enabled = true) {
  return useQuery({
    queryKey: ['my-access-requests'],
    queryFn: () => api.get<AccessRequest[]>('/api/access-requests/mine'),
    enabled,
    refetchInterval: 20_000,
  });
}
export function usePendingRequestCount(enabled = true) {
  return useQuery({
    queryKey: ['pending-request-count'],
    queryFn: () => api.get<{ count: number }>('/api/access-requests/pending-count'),
    enabled,
    refetchInterval: 30_000,
  });
}
// From the latest stored NetBird billing event.
export function useBillingSummary(enabled = true) {
  return useQuery({
    queryKey: ['billing-summary'],
    queryFn: () => api.get<{ billedUsers: number | null; at: string | null }>('/api/billing-summary'),
    enabled,
    refetchInterval: 300_000,
  });
}

// Admins / networks.manage holders.
export function useResourceConflicts(enabled = true) {
  return useQuery({
    queryKey: ['resource-conflicts'],
    queryFn: () => api.get<{ conflicts: ResourceConflict[] }>('/api/resource-conflicts'),
    enabled,
    refetchInterval: 120_000,
  });
}

// Any logged-in user.
export function useRequestTargetSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['request-targets', q],
    queryFn: () => api.get<{ results: RequestTargetResult[] }>('/api/request-targets', { q }),
    enabled: enabled && q.trim().length >= 2,
    placeholderData: (prev) => prev,
  });
}

// Admin, main account only.
export function useInternalBackup(enabled = true) {
  return useQuery({ queryKey: ['internal-backup'], queryFn: () => api.get<InternalBackupStatus>('/api/internal-backup'), enabled });
}

// Certificate posture check: subject / validity / SHA-256 fingerprint of pasted CA certificates,
// parsed on the server (WebCrypto is unavailable on a plain-HTTP origin). Pure parsing - cached by
// content, so typing re-asks only for what changed.
export function useCaCertInspection(pems: string[]) {
  const list = pems.map((p) => p.trim());
  return useQuery({
    queryKey: ['ca-cert-inspect', list],
    queryFn: () => api.post<CaCertInfo[]>('/api/posture-checks/inspect-certificates', { pems: list }),
    enabled: list.some(Boolean),
    staleTime: Infinity,
  });
}
