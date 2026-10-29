import { useQuery } from '@tanstack/react-query';
import type { CaCertInfo } from './types';
import { api, getTenantMode } from './api';
import type {
  Viewer, LogsResponse, AdminLogsResponse, AuditResponse, IpHistoryResponse, TrafficSummaryResponse, ReverseProxyStatus, ProxyLogsResponse, ProxyLogsSummaryResponse, ProxyServiceStats, ProxyDomain, EditableProxyService, ProxyTargetOptions, NbUser, Peer, PeerDetail, NbGroup, GroupDetail, UserDetail,
  Network, NetworkDetail, Policy, PolicyOptions, TemplatesResponse, GroupRef, FilterRulesResponse, AppConfig, NetbirdApiConfig, WebhookConfig, NetbirdWebhookStatus, TelegramConfig, SmtpConfig, ApproverConfig, AutoApprovalConfig, FeaturePermsConfig, RecurringAccessRule, SecurityConfig, EdrAutoBypassConfig, RetentionStatus, SearchResult, AccessProfile, NetworkDefaultProfiles, PostureCheck, Country, CityRef, Automation, AutomationRun, AutomationManaged, BlocklistEntry, TemporaryAccessGrant, AccessRequest, RequestTargetResult, SystemHealth, Recertification, RecertRoundSummary, RecertRoundDetail, ResourceConflict, OutboundEntry, OutboundBody, CleanupReport, DiagnosticsInfo, NbNotice, MspStatus, MspTenant, MspBillingPlans, TenantOverview, MspSwitcherItem, TenantDrift, TenantDefaultsResponse, NetbirdSettingsResponse, FleetReport, MspDigestConfig, InternalBackupStatus, InviteDefaultGroups, TrafficPullStatus, AuditPullStatus,
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

// App display name (configurable in Settings). Available to every user.
export function useAppConfig() {
  return useQuery({ queryKey: ['app-config'], queryFn: () => api.get<AppConfig>('/api/app-config'), staleTime: 5 * 60_000 });
}

// NetBird Management API connection (admin only). Never includes the token.
export function useNetbirdApiConfig(enabled = true) {
  return useQuery({ queryKey: ['netbird-api'], queryFn: () => api.get<NetbirdApiConfig>('/api/integrations/netbird'), enabled });
}

// Incoming-webhook endpoint + auth status (admin only). Never includes the token.
export function useWebhookConfig(enabled = true) {
  return useQuery({ queryKey: ['webhook-config'], queryFn: () => api.get<WebhookConfig>('/api/integrations/webhook'), enabled });
}

// Live "is it actually configured in NetBird" status for the Webhook page badges (admin only). Kept
// separate from the config query because it hits the NetBird API and can be slow / plan-gated; the UI
// shows it with its own loading state. Refetches periodically so the badge reflects config changes.
export function useNetbirdWebhookStatus(enabled = true) {
  return useQuery({
    queryKey: ['webhook-nb-status'],
    queryFn: () => api.get<NetbirdWebhookStatus>('/api/integrations/webhook/nb-status'),
    enabled, staleTime: 30_000, refetchInterval: 60_000,
  });
}

// Traffic Events API pull - the per-account opt-in plus its last-run status (admin only).
export function useTrafficPull(enabled = true) {
  return useQuery({ queryKey: ['traffic-pull'], queryFn: () => api.get<TrafficPullStatus>('/api/traffic-pull'), enabled });
}

// Audit Events API pull - the per-account opt-in plus its last-run status (admin only).
export function useAuditPull(enabled = true) {
  return useQuery({ queryKey: ['audit-pull'], queryFn: () => api.get<AuditPullStatus>('/api/audit-pull'), enabled });
}

// Telegram notification config (admin only). Never includes the bot token.
export function useTelegramConfig(enabled = true) {
  return useQuery({ queryKey: ['telegram'], queryFn: () => api.get<TelegramConfig>('/api/integrations/telegram'), enabled });
}

// SMTP email settings (admin only). Password never returned.
export function useSmtpConfig(enabled = true) {
  return useQuery({ queryKey: ['smtp'], queryFn: () => api.get<SmtpConfig>('/api/integrations/smtp'), enabled });
}

// Who may approve access requests - Entra groups + Telegram approvers (admin only).
export function useApproverConfig(enabled = true) {
  return useQuery({ queryKey: ['approver-config'], queryFn: () => api.get<ApproverConfig>('/api/approver-config'), enabled });
}

// Auto-approval rules - trusted groups + per-target self-service (admin only).
export function useAutoApprovalConfig(enabled = true) {
  return useQuery({ queryKey: ['auto-approval-config'], queryFn: () => api.get<AutoApprovalConfig>('/api/auto-approval-config'), enabled });
}

// Recurring access rules (weekday + daily-window schedules that spawn temp grants).
export function useRecurringAccess(enabled = true) {
  return useQuery({ queryKey: ['recurring-access'], queryFn: () => api.get<RecurringAccessRule[]>('/api/recurring-access'), enabled });
}

// Security & alerts settings - session limits, escalation, review digest, anomalies (admin only).
export function useSecurityConfig(enabled = true) {
  return useQuery({ queryKey: ['security-config'], queryFn: () => api.get<SecurityConfig>('/api/security-config'), enabled });
}

// Automatic EDR bypass rules (admin only). Per account - tenant-aware, like data retention.
export function useEdrAutoBypass(enabled = true) {
  return useQuery({ queryKey: ['edr-auto-bypass'], queryFn: () => api.get<EdrAutoBypassConfig>('/api/edr-auto-bypass'), enabled });
}

// Per-account data-retention window (admin only). Tenant-aware - works in tenant mode too, where
// the rest of security-config stays main-only.
export function useRetention(enabled = true) {
  return useQuery({ queryKey: ['data-retention'], queryFn: () => api.get<RetentionStatus>('/api/data-retention'), enabled });
}

// Distinct device tags in use (Peers tag filter + tag editor suggestions).
export function usePeerTags(enabled = true) {
  return useQuery({ queryKey: ['peer-tags'], queryFn: () => api.get<string[]>('/api/peer-tags'), enabled });
}

// Access recertification - the open review round + last completed summary (admin only).
export function useRecertification(enabled = true) {
  return useQuery({ queryKey: ['recertification'], queryFn: () => api.get<Recertification>('/api/recertification'), enabled });
}
// Completed review rounds history + one round's full who-decided-what report.
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

// System Health - scheduler status, DB size, integrations (admin only). Refreshes every 30s
// while the tab is open so a failing scheduler surfaces without a manual reload.
export function useSystemHealth(enabled = true) {
  return useQuery({
    queryKey: ['system-health'],
    queryFn: () => api.get<SystemHealth>('/api/system-health'),
    enabled,
    refetchInterval: 30000,
  });
}

// Feature permissions - per-capability users + groups (admin only).
export function useFeaturePerms(enabled = true) {
  return useQuery({ queryKey: ['feature-permissions'], queryFn: () => api.get<FeaturePermsConfig>('/api/feature-permissions'), enabled });
}

// Global search (⌘K palette) - permission-filtered networks/resources/peers/groups/users/policies.
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
    queryFn: () => api.get<LogsResponse>('/api/logs', params),
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

// Traffic summary - the filtered events aggregated per source→destination pair.
export function useLogSummary(params: LogParams, enabled = true) {
  return useQuery({
    queryKey: ['logs-summary', params],
    queryFn: () => api.get<TrafficSummaryResponse>('/api/logs/summary', params),
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

// Proxy logs aggregated per service (Summary view) - same filters as the detailed list.
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

// One service for the Edit modal (auth secrets stripped server-side).
export function useProxyServiceDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['reverse-proxy-service', id],
    queryFn: () => api.get<EditableProxyService>(`/api/reverse-proxy-services/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

// Flat peers + resources inventory for the unified target picker.
export function useProxyTargetOptions(enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-target-options'],
    queryFn: () => api.get<ProxyTargetOptions>('/api/reverse-proxy-target-options'),
    enabled,
    staleTime: 60_000,
  });
}

// Custom domains available as bases for new reverse-proxy services.
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

// Distinct users seen in the stored proxy logs (user dropdown on the Reverse Proxy page).
export function useProxyLogUsers(enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-log-users'],
    queryFn: () => api.get<{ user_id: string; display_name: string; email: string }[]>('/api/reverse-proxy-logs/users'),
    enabled,
    staleTime: 60_000,
  });
}

// Reverse-proxy (Cloud ingress) clusters + services status (admin only; hidden on self-hosted).
export function useReverseProxyStatus(enabled = true) {
  return useQuery({
    queryKey: ['reverse-proxy-status'],
    queryFn: () => api.get<ReverseProxyStatus>('/api/reverse-proxy-status'),
    refetchInterval: 60_000,
    enabled,
  });
}

// Events-per-hour for the dashboard chart (a restricted user gets only their own traffic).
export interface HourlyStat { hour: string; count: number }
export function useHourlyStats(hours = 24) {
  return useQuery({
    queryKey: ['stats-hourly', hours],
    queryFn: () => api.get<HourlyStat[]>('/api/stats/hourly', { hours }),
    refetchInterval: 60_000,
  });
}

// IP-assignment history (admin only) - who held a NetBird IP at a given time.
export function useIpHistory(params: { q?: string; at?: string; user?: string; sort?: string; dir?: string; page?: number; per_page?: number }) {
  return useQuery({
    queryKey: ['ip-history', params],
    queryFn: () => api.get<IpHistoryResponse>('/api/ip-history', params),
    placeholderData: (prev) => prev,
  });
}

// Distinct users in the IP history, for the page's user filter (audit-view gated).
export function useIpHistoryUsers(enabled = true) {
  return useQuery({ queryKey: ['ip-history-users'], queryFn: () => api.get<LogUser[]>('/api/ip-history/users'), enabled });
}

// Audit log of changes made through this app (admin only).
export function useAuditLog(params: LogParams) {
  return useQuery({
    queryKey: ['audit', params],
    queryFn: () => api.get<AuditResponse>('/api/audit', params),
    refetchInterval: logsAutoRefresh(params),
    placeholderData: (prev) => prev,
  });
}

// Outbound log - everything the app itself sent out (email / Telegram).
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
// The switchable accounts - what the tenant switcher lists and what "Manage" switches into.
export function useMspSwitcher(enabled = true) {
  return useQuery({
    queryKey: ['msp-switcher'],
    queryFn: () => api.get<MspSwitcherItem[]>('/api/msp/switcher'),
    enabled,
    staleTime: 60_000,
  });
}
// Settings Sync: a tenant's Event Filtering + Blocklist + Data Retention + webhook tokens
// compared against main's current config. Enabled only when a tenant id is selected.
export function useTenantDrift(id: string | null) {
  return useQuery({
    queryKey: ['msp-tenant-drift', id],
    queryFn: () => api.get<TenantDrift>(`/api/msp/tenants/${encodeURIComponent(id!)}/drift`),
    enabled: id != null,
  });
}
// Tenant Defaults (admin, main only): the saved profile new tenants are seeded with, plus main's
// current live settings for the "Load Current Main Values" prefill. Only meaningful on MSP accounts.
export function useTenantDefaults(enabled = true) {
  return useQuery({
    queryKey: ['tenant-defaults'],
    queryFn: () => api.get<TenantDefaultsResponse>('/api/tenant-defaults'),
    enabled,
  });
}
// Live NetBird Settings (admin): the CURRENT account's own NetBird settings - main in main mode, the
// managed tenant's account in tenant mode. Distinct from Tenant Defaults (the seed template for new
// tenants). Separate query key per tenant so switching accounts never serves a stale settings object.
export function useNetbirdSettings() {
  return useQuery({
    queryKey: ['netbird-settings', getTenantMode() || 'main'],
    queryFn: () => api.get<NetbirdSettingsResponse>('/api/netbird-settings'),
  });
}
// Fleet Report (admin, main only): a management snapshot across every tenant - peers, versions,
// known issues, integration and service-user status. Manual refetch from the tab; short stale time.
export function useFleetReport(enabled = true) {
  return useQuery({
    queryKey: ['msp-fleet-report'],
    queryFn: () => api.get<FleetReport>('/api/msp/fleet-report'),
    enabled,
    staleTime: 60_000,
  });
}
// Weekly MSP digest config (admin, main only). Disabled by default (kill switch).
export function useMspDigest(enabled = true) {
  return useQuery({
    queryKey: ['msp-digest'],
    queryFn: () => api.get<MspDigestConfig>('/api/msp-digest'),
    enabled,
  });
}
// The MSP's upgradeable plan catalog (Team / Business) in its own billing currency. Backed by a
// ~10 min server cache; only fetched while the tenant modal's Plan tab is open.
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

// Report-only hygiene sweep for the Cleanup page (admin only).
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

// Distinct users for the Activity user filter dropdown (admin only).
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

// Expanded detail for one peer (peer detail page).
export function usePeerDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['peer-detail', id],
    queryFn: () => api.get<PeerDetail>(`/api/peers/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

// All NetBird groups with usage counts (admin only).
export function useGroups(enabled = true) {
  return useQuery({ queryKey: ['groups'], queryFn: () => api.get<NbGroup[]>('/api/groups'), enabled });
}

// Default Auto-Assigned Groups for invitations (admin only, per account) - prefills the invite
// modal. Fetched only while the modal is open, so non-admin pages never hit the endpoint.
export function useInviteDefaultGroups(enabled = true) {
  return useQuery({
    queryKey: ['invite-defaults'],
    queryFn: () => api.get<InviteDefaultGroups>('/api/users/invite-defaults'),
    enabled,
  });
}

// Expanded detail for one group (group detail page).
export function useGroupDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['group-detail', id],
    queryFn: () => api.get<GroupDetail>(`/api/groups/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

// Expanded detail for one user (user detail page).
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

// All access-control policies (admin-only overview page).
export function usePolicies(enabled = true) {
  return useQuery({ queryKey: ['policies'], queryFn: () => api.get<Policy[]>('/api/policies'), enabled });
}

export function useTemplates(enabled = true) {
  return useQuery({ queryKey: ['templates'], queryFn: () => api.get<TemplatesResponse>('/api/templates'), enabled });
}

export function useAdGroups(enabled = true) {
  return useQuery({ queryKey: ['ad-groups'], queryFn: () => api.get<GroupRef[]>('/api/ad-groups'), enabled });
}

// Access Profiles (group + shared policy bundles).
export function useAccessProfiles(enabled = true) {
  return useQuery({ queryKey: ['access-profiles'], queryFn: () => api.get<AccessProfile[]>('/api/access-profiles'), enabled });
}

// Per-network default Access Profiles (admin only).
export function useNetworkDefaultProfiles(enabled = true) {
  return useQuery({ queryKey: ['network-default-profiles'], queryFn: () => api.get<NetworkDefaultProfiles>('/api/network-default-profiles'), enabled });
}

// Posture checks (proxied from NetBird).
export function usePostureChecks(enabled = true) {
  return useQuery({ queryKey: ['posture-checks'], queryFn: () => api.get<PostureCheck[]>('/api/posture-checks'), enabled });
}

// Country list for the geo-location posture check editor.
export function useCountries(enabled = true) {
  return useQuery({ queryKey: ['countries'], queryFn: () => api.get<Country[]>('/api/locations/countries'), enabled, staleTime: Infinity });
}

// Cities for a chosen country (geo-location editor).
export function useCities(countryCode: string | undefined) {
  return useQuery({
    queryKey: ['cities', countryCode],
    queryFn: () => api.get<CityRef[]>(`/api/locations/countries/${encodeURIComponent(countryCode!)}/cities`),
    enabled: !!countryCode,
    staleTime: Infinity,
  });
}

// Automations (admin only).
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

// Address blocklist (readable by any editor for inline checks).
export function useBlocklist(enabled = true) {
  return useQuery({ queryKey: ['blocklist'], queryFn: () => api.get<BlocklistEntry[]>('/api/blocklist'), enabled });
}

export function useFilterRules(enabled = true) {
  return useQuery({ queryKey: ['filter-rules'], queryFn: () => api.get<FilterRulesResponse>('/api/filter-rules'), enabled });
}

// Temporary access grants (admin only). Polls so the countdown / auto-revoke stays live.
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
// Pending-request count for the admin nav badge.
export function usePendingRequestCount(enabled = true) {
  return useQuery({
    queryKey: ['pending-request-count'],
    queryFn: () => api.get<{ count: number }>('/api/access-requests/pending-count'),
    enabled,
    refetchInterval: 30_000,
  });
}
// Billed-users count from the latest stored NetBird billing event (admin dashboard tile).
export function useBillingSummary(enabled = true) {
  return useQuery({
    queryKey: ['billing-summary'],
    queryFn: () => api.get<{ billedUsers: number | null; at: string | null }>('/api/billing-summary'),
    enabled,
    refetchInterval: 300_000,
  });
}

// Same-address resources with overlapping audiences (unpredictable access) - admins /
// networks.manage holders. Drives the network-page warning banner + Needs Attention.
export function useResourceConflicts(enabled = true) {
  return useQuery({
    queryKey: ['resource-conflicts'],
    queryFn: () => api.get<{ conflicts: ResourceConflict[] }>('/api/resource-conflicts'),
    enabled,
    refetchInterval: 120_000,
  });
}

// Typeahead search for request targets (any logged-in user).
export function useRequestTargetSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['request-targets', q],
    queryFn: () => api.get<{ results: RequestTargetResult[] }>('/api/request-targets', { q }),
    enabled: enabled && q.trim().length >= 2,
    placeholderData: (prev) => prev,
  });
}

// Internal envelope-encrypted backup status (admin, main account only): folder writability,
// whether a keypair is configured, the schedule, and the list of backup files (newest first).
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
