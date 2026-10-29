// API response shapes - mirror the existing Express endpoints (backend unchanged).

export interface Viewer {
  authEnabled: boolean;
  isAdmin: boolean;
  /** May approve/deny access requests (admin, or a member of an Entra approver group). */
  canApprove?: boolean;
  /** May scan/delete stored events matching the filters (EVENT_PURGE_ADMINS allow-list). */
  canPurge?: boolean;
  /** Fine-grained feature permissions (Settings → Permissions); admins have all of them. */
  perms?: Record<string, boolean>;
  user_id?: string | null;
  name?: string;
  email?: string;
  role?: string;
  netbirdConfigured?: boolean;
}

// Fine-grained feature permissions: who (users and/or groups) gets each capability.
// Security & alerts settings (Settings → Security). All numeric limits: 0 = disabled.
export interface SecurityConfig {
  sessionIdleHours: number;
  sessionMaxHours: number;
  adminSessionMaxHours: number;
  requestReminderMinutes: number;
  requestExpireHours: number;
  reviewEnabled: boolean;
  reviewDay: number;   // 0=Sunday … 6=Saturday
  reviewHour: number;  // 0-23
  reviewEmails: string[];
  anomalyEnabled: boolean;
  /** Telegram alert when a background job fails repeatedly (and when it recovers). */
  schedAlertsEnabled: boolean;
  workDays: number[]; // 0=Sunday … 6=Saturday
  workStart: number;
  workEnd: number;
  trafficMult: number;
  trafficFloorMb: number;
  /** Event retention in days - admin-controlled. 0 = keep forever. */
  retentionDays: number;
  /** Periodic access recertification (keep/revoke attestation of standing access). */
  recertEnabled: boolean;
  recertIntervalDays: number;
}

// ─── Automatic EDR bypass by OS (GET/PUT /api/edr-auto-bypass) ───
// Per account (a tenant's rules act on the tenant's own devices). The five platforms a rule can
// target; matching is case-insensitive against the device's SELF-REPORTED OS string.
export type EdrBypassOs = 'ios' | 'android' | 'linux' | 'windows' | 'macos';
export interface EdrAutoBypassRule {
  os: EdrBypassOs;
  /** null = unlimited (enters every recertification round); 1-365 = a timed bypass in days. */
  durationDays: number | null;
}
export interface EdrAutoBypassConfig {
  /** Master kill switch - off by default. */
  enabled: boolean;
  rules: EdrAutoBypassRule[];
}

// Per-account data-retention window (GET/PUT /api/data-retention). Tenant-aware: main reads the
// security blob's retentionDays, a managed tenant its own retention_days:<tenant> setting.
export interface RetentionStatus {
  days: number;
  warnDays: number;
  last: { at: string; events?: number; adminEvents?: number; error?: string } | null;
}

// ─── Automation dry-run: the full sync decision walk, zero writes ───
export interface DryRunAction {
  action: string;
  key: string;
  name: string;
  address: string;
  description?: string;
  note: string;
  /** The CURRENT resource behind this item, when one exists. */
  current?: { id: string; name: string; address: string; enabled?: boolean };
}
export interface DryRunResult {
  ok: boolean;
  itemsFound: number;
  validCount: number;
  floor: number;
  managed: number;
  belowFloor: boolean;
  warn?: string;
  summary: Record<string, number>;
  actions: DryRunAction[];
  /** True when the plan exceeded the row cap (summary still counts everything). */
  truncated?: boolean;
}

// ─── Access recertification ───
export type RecertItemStatus = 'pending' | 'kept' | 'revoked';
export interface RecertItem {
  id: number;
  kind: string;
  kindLabel: string;
  label: string;
  /** Full decision context - what this access grants, device details, schedule, etc. */
  info: string;
  status: RecertItemStatus;
  decidedBy: string;
  decidedAt: string | null;
}
export interface Recertification {
  enabled: boolean;
  intervalDays: number;
  open: { id: number; startedAt: string; dueAt: string; items: RecertItem[] } | null;
  lastCompleted: { id: number; startedAt: string; completedAt: string; kept: number; revoked: number } | null;
}
/** One row in the completed-rounds history. */
export interface RecertRoundSummary {
  id: number;
  startedAt: string;
  completedAt: string;
  kept: number;
  revoked: number;
}
/** A full round report - who decided what, when. */
export interface RecertRoundDetail {
  id: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  items: RecertItem[];
}

// ─── MSP tenants (NetBird Cloud MSP portal) ───
export interface MspStatus {
  available: boolean;
  name?: string;
  domain?: string;
  status?: string;
  /** True when the MSP provisioning token (a user PAT for creating tenant service users) is set. */
  hasProvisioningToken?: boolean;
}
export interface TenantGroup { id: string; role: string; name?: string }
export interface TenantUsage { activeUsers: number; totalUsers: number; activePeers: number; totalPeers: number }
export interface MspTenant {
  id: string;
  name: string;
  domain: string;
  status: 'existing' | 'invited' | 'pending' | 'active' | string;
  activatedAt: string;
  createdAt: string;
  groups: TenantGroup[];
  usage: TenantUsage | null;
  /** Subscription plan (official-dashboard parity): tier + remaining trial days (null = unknown). */
  plan?: { tier: string; remainingTrialDays: number | null } | null;
  /** True when a per-tenant API token is stored (write-only - the token itself never returns). */
  hasApiToken?: boolean;
  /** The managed service user the app created inside the tenant (null = not provisioned). */
  serviceUser?: { name: string; rotatedAt: string; expiresAt: string } | null;
  /** Onboarding checklist - which management prerequisites are in place. Absent on older backends. */
  readiness?: TenantReadiness;
}
/** The five onboarding checks surfaced as the tenant's "N/5" readiness chip. */
export interface TenantReadiness {
  verified: boolean;
  serviceUser: boolean;
  webhookEvents: boolean;
  webhookNotif: boolean;
  telegram: boolean;
}
/** One upgradeable plan of GET /api/msp/billing-plans (Team / Business only, like the official). */
export interface MspBillingPlan {
  name: string;
  tier: 'team' | 'business' | string;
  /** Whole currency units per user / month; null when the plan has no price in the active currency. */
  priceMonthly: number | null;
  priceId: string;
  description: string;
  features: string[];
}
/** GET /api/msp/billing-plans - the MSP's plan catalog in its own billing currency. */
export interface MspBillingPlans {
  currency: string;
  plans: MspBillingPlan[];
}
/** One tenant row of the Fleet Report (GET /api/msp/fleet-report). */
export interface FleetReportTenant {
  id: string;
  name: string;
  domain: string;
  status: string;
  peers: { total: number; online: number; offline30d: number };
  versions: { latest: string | null; outdated: number };
  knownIssues: number;
  /** Users active/total from the tenant's billing usage (null when no working context). */
  users: { active: number; total: number } | null;
  /** Billed users from the tenant's latest billing event / usage (null when unknown). */
  billedUsers: number | null;
  /** Subscription plan - same shape/mapping as MspTenant.plan (null when no working context). */
  plan: { tier: string; remainingTrialDays: number | null } | null;
  webhookEvents: boolean;
  webhookNotif: boolean;
  telegram: boolean;
  serviceUser: { ok: boolean; expiresAt: string | null };
  lastEventAt: string | null;
}
/** GET /api/msp/fleet-report (admin, main only) - a management snapshot across every tenant. */
export interface FleetReport {
  generatedAt: string;
  tenants: FleetReportTenant[];
}
/** Weekly MSP digest config (GET/PUT /api/msp-digest). Disabled by default (kill switch). */
export interface MspDigestConfig {
  enabled: boolean;
  day: number;  // 0=Sunday … 6=Saturday
  hour: number; // 0-23
  telegram: boolean;
  emails: string[];
}
/** Result of POST /api/msp-digest/send - what the immediate send actually reached. */
export interface MspDigestSendResult { telegram: boolean; emails: number }
export interface TenantOverview {
  usage: TenantUsage | null;
  subscription: { active: boolean; planTier: string; remainingTrialSec: number } | null;
}
/** A switchable account from NetBird's MSP switcher - its `id` is the account-switch value. */
export interface MspSwitcherItem {
  id: string;
  accountId: string;
  name: string;
  domain: string;
  status: string;
}
/** One Settings Sync comparison row (tenant vs main). For token rows match=configured, main='-'. */
export interface TenantDriftItem {
  key: string;
  label: string;
  match: boolean;
  main: string;
  tenant: string;
}
export interface TenantDrift {
  tenant: string;
  items: TenantDriftItem[];
}
/** Result of replacing a tenant's Event Filtering + Blocklist + Data Retention + NetBird account settings with main's. */
export interface ApplyTenantDefaultsResult { rules: number; blocklist: number; retentionDays: number; nbSettings: boolean; mfa?: boolean; copiedRules?: boolean; copiedBlocklist?: boolean }
/**
 * The flat NetBird account-settings field shape, shared by the Tenant Defaults profile (the seed
 * template for NEW tenants) and the LIVE NetBird Settings editor (the current account's ACTUAL
 * settings). The `enabled` master toggle and the seeding-only `ipv6_disable` convenience are NOT part
 * of this base - they belong to the Tenant Defaults profile only.
 */
export interface NetbirdNbSettings {
  peer_approval_enabled: boolean;
  user_approval_required: boolean;
  mfa_enabled: boolean; mfa_remember_browser: boolean;  // cloud MFA via /api/service/mfa (not settings)
  peer_login_expiration_enabled: boolean; peer_login_expiration: number; // seconds
  peer_inactivity_expiration_enabled: boolean;  // duration fixed server-side (600s) - no picker
  groups_propagation_enabled: boolean;
  jwt_groups_enabled: boolean; jwt_groups_claim_name: string; jwt_allow_groups: string[];
  regular_users_view_blocked: boolean;
  dns_domain: string; network_range: string; network_range_v6: string;
  routing_peer_dns_resolution_enabled: boolean;
  network_traffic_logs_enabled: boolean;
  network_traffic_packet_counter_enabled: boolean;  // kernel traffic reporting (forced off when events off)
  auto_update_version: string;   // 'disabled' | 'latest' | explicit version like '0.52.2'
  auto_update_always: boolean;
  peer_expose_enabled: boolean;
  lazy_connection_enabled: boolean;
  /** NetBird v0.81+. Live: null = this account's NetBird doesn't expose it. Defaults: null = not managed. */
  peer_hostname_collision_rejected?: boolean | null;
}
/** The Tenant Defaults profile - what new tenants are seeded with and what "Apply Defaults" applies. */
export interface TenantDefaultsProfile {
  nb: NetbirdNbSettings & {
    enabled: boolean;
    dns_domain: string; network_range: string; network_range_v6: string;  // '' = do not set on tenants
    ipv6_disable: boolean;  // true = clear tenants' IPv6 Enabled Groups (the official disable mechanism)
  };
  retentionDays: number | null;
  copyFilterRules: boolean;
  copyBlocklist: boolean;
}
/**
 * GET/PUT /api/netbird-settings - the CURRENT account's LIVE NetBird settings (main OR a managed
 * tenant). Same fields as the Tenant Defaults profile minus the master toggle, copy flags, retention
 * and the ipv6_disable seeding convenience. The infra fields (DNS domain / IP ranges) are editable
 * but re-allocate peer IPs, so the editor warns before a live change.
 */
export interface NetbirdSettingsResponse {
  nb: NetbirdNbSettings;
  /** False when the configured NetBird API base does not serve the cloud MFA service. */
  mfaSupported: boolean;
}
/** GET /api/tenant-defaults - the saved profile (if any) plus main's current live settings for prefill. */
export interface TenantDefaultsResponse {
  /** False when the configured NetBird API base does not serve the cloud MFA service. */
  mfaSupported?: boolean;
  configured: boolean;
  profile: TenantDefaultsProfile | null;
  mainCurrent: TenantDefaultsProfile;
}
/**
 * One-click NetBird auto-setup result, shared by the Account Notifications and the Activity Events
 * (Event Streaming) flows: the ingest token was handled + the NetBird integration created/updated.
 * `rotatedToken` is false only when the main account's events token is env-managed and reused as-is.
 */
export interface AutoConfigureNbResult { configured: true; created: boolean; url: string; rotatedToken: boolean }

// ─── System Health (admin) ───
// Telegram send-queue snapshot: counters since boot + whether the queue is currently
// paused by a rate limit (429) and retrying.
export interface TelegramQueueStats {
  queued: number;
  paused: boolean;
  pausedUntil: string | null;
  sent: number;
  failed: number;
  retries: number;
  lastSentAt: string | null;
  lastErrorAt: string | null;
  lastError: string;
}
export interface SchedulerHealth {
  runs: number;
  failures: number;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string;
  lastMs: number;
}
export interface SystemHealth {
  version: string;
  node: string;
  uptimeSec: number;
  authEnabled: boolean;
  schedulers: Record<string, SchedulerHealth>;
  integrations: {
    netbird: { configured: boolean; lastOkAt: string | null; readonly: boolean };
    telegram: { enabled: boolean; hasToken: boolean; queue: TelegramQueueStats };
    smtp: { enabled: boolean };
  };
  db: {
    events: { rows: number; bytes: number; oldest: string | null };
    adminEvents: { rows: number; bytes: number; oldest: string | null };
    audit: { rows: number; bytes: number };
    ipAssignments: { rows: number; bytes: number };
  };
  activeGrants: number;
  pendingRequests: number;
  scheduledBypasses: number;
  bypassedPeers: number;
  retention: {
    days: number;
    warnDays: number;
    last: { at: string; events?: number; adminEvents?: number; error?: string } | null;
  };
}

export type FeaturePermKey = 'activity.all' | 'peers.all' | 'audit.view' | 'temp.manage' | 'networks.manage' | 'proxy.manage' | 'troubleshoot.all' | 'tenants.support';
export interface FeaturePermUser { id: string; email: string; name: string }
export interface FeaturePermEntry { users: FeaturePermUser[]; groupIds: string[] }
export type FeaturePermsConfig = Record<string, FeaturePermEntry>;

export interface UserRef { display_name?: string; email?: string }

// Global search (⌘K command palette) result.
export interface SearchResult {
  type: 'network' | 'resource' | 'peer' | 'group' | 'user' | 'policy' | 'profile' | 'proxy';
  id: string;
  title: string;
  subtitle?: string;
  to: string;
}

// Stored events that match the filters (the admin "purge garbage" tool).
export interface MatchingEvent {
  id: string;
  timestamp: string;
  message?: string;
  source_name?: string;
  source_addr?: string;
  destination_name?: string;
  destination_addr?: string;
  direction?: string;
}
export interface MatchingEventsResult { total: number; scanned: number; sample: MatchingEvent[] }

// A same-address resource cluster whose audiences overlap - those users get unpredictable access.
export interface ResourceConflict {
  networkId: string;
  networkName: string;
  /** All networks involved - more than one = a cross-network conflict (merge not possible). */
  networks: { id: string; name: string }[];
  crossNetwork: boolean;
  address: string;
  resources: { id: string; name: string; networkId?: string; networkName?: string }[];
  /** Number of affected users; -1 = everyone (both sides open to the All group). */
  overlapCount: number;
  overlapUsers: string[];
  sharedGroups: string[];
  note: string;
}

export interface AppConfig { appName: string; timeZone: string; dateFormat: string; hour12: boolean; showResourceGroups: boolean; policyNameTemplate: string; policyNameTemplateShared: string; proxyDefaultDomain: string }

export interface NetbirdApiConfig { url: string; hasToken: boolean; urlFromEnv: boolean; tokenFromEnv: boolean }
export interface WebhookConfig {
  endpoint: string;
  hasToken: boolean;
  tokenFromEnv: boolean;
  authEnabled: boolean;
  /** The account-notifications webhook has its own, deliberately independent token. */
  hasNotifToken: boolean;
  notifAuthEnabled: boolean;
  /** Freshness HINT only (tooltip): most recent activity event / account notification received (null = none).
   * NOT the on/off signal - traffic can also arrive via the API pull. Use NetbirdWebhookStatus for on/off. */
  eventsLastAt: string | null;
  notifLastAt: string | null;
}

/** One feature's live state in NetBird, or null when it could not be determined (API not configured,
 * plan lacks the feature, or a transient error) - the UI shows "Unknown" rather than guessing. */
export type NetbirdFeatureStatus = { configured: boolean; enabled: boolean } | null;

/** Live "is it actually set up in NetBird" status for the Webhook page badges. The honest on/off
 * signal - read from NetBird's own integration state, independent of whether any rows have arrived. */
export interface NetbirdWebhookStatus {
  /** The Generic HTTP event-streaming integration (Activity Events). */
  eventStreaming: NetbirdFeatureStatus;
  /** The account-notifications webhook channel. */
  notifications: NetbirdFeatureStatus;
}

/** Opt-in polling of NetBird's Traffic Events API - config + last-run status, per account. */
export interface TrafficPullStatus {
  enabled: boolean;
  /** ISO timestamp of the last completed pull, or null when it has never run. */
  lastRunAt: string | null;
  /** Events stored by that last pull (already-known flows are deduplicated away). */
  lastCount: number;
  /** NetBird answered that the endpoint is not available on this account's plan. */
  unsupported: boolean;
  lastError: string | null;
}

/** Opt-in polling of NetBird's Audit Events API - config + last-run status, per account. */
export interface AuditPullStatus {
  enabled: boolean;
  /** ISO timestamp of the last completed pull, or null when it has never run. */
  lastRunAt: string | null;
  /** Events stored by that last pull (already-known events are deduplicated away). */
  lastCount: number;
  /** NetBird answered that the endpoint is not available on this account's plan. */
  unsupported: boolean;
  lastError: string | null;
}

export interface TelegramCategory { enabled?: boolean; topic?: string }
export interface AdminEventType { message: string; count: number; category?: string }
export interface TelegramConfig {
  enabled: boolean;
  chatId: string;
  categories: Record<string, TelegramCategory>;
  netbirdEvents: string[];
  hasToken: boolean;
  tokenFromEnv: boolean;
  webhookConfigured: boolean;
  eventTypes?: AdminEventType[];
  /** Main only: mirror managed tenants' activity to main's Telegram, tagged with the tenant name.
   * Absent in tenant mode and on older backends. */
  tenantActivity?: boolean;
}
export interface TelegramInput {
  enabled?: boolean;
  chatId?: string;
  categories?: Record<string, TelegramCategory>;
  netbirdEvents?: string[];
  token?: string;
  /** Main only: mirror managed tenants' activity to main's Telegram (see TelegramConfig). */
  tenantActivity?: boolean;
}

// SMTP email notifications. envManaged = configured via env vars (the UI is read-only then).
export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  hasPass: boolean;
  envManaged: boolean;
  /** Email a device's owner when it fails compliance on a login attempt. */
  complianceBlockedEmail?: boolean;
}
export interface SmtpConfigInput {
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  pass?: string;
  complianceBlockedEmail?: boolean;
}

// Who may approve access requests - in-app (Entra groups) and via Telegram.
// One Telegram approver: a Telegram user id mapped to a system user, so a Telegram approval is
// attributed to the real person. name/email are a snapshot of the chosen user (for display/audit).
export interface TelegramApprover {
  telegramId: string;
  userId: string;
  name?: string;
  email?: string;
}
/** Time-boxed approval rights ("I'm away - X approves instead"). Active from <= today <= until. */
export interface ApproverDelegate {
  user: { id: string; email: string; name: string };
  from: string;   // YYYY-MM-DD, inclusive
  until: string;  // YYYY-MM-DD, inclusive
}
export interface ApproverConfig {
  groupIds: string[];
  telegramChatId: string;
  telegramApprovers: TelegramApprover[];
  delegates: ApproverDelegate[];
  webhookConfigured?: boolean;
}
export interface ApproverConfigInput {
  groupIds: string[];
  telegramChatId: string;
  telegramApprovers: TelegramApprover[];
  delegates?: ApproverDelegate[];
}

export interface LogEvent {
  id?: number | string;
  flow_id?: string;
  timestamp?: string;
  message?: string;
  direction?: string;
  type?: string;
  protocol?: string | number;
  icmp_type?: number;
  icmp_code?: number;
  destination_port?: number | string;
  source_id?: string;
  source_type?: string;
  destination_id?: string;
  source_addr?: string;
  source_name?: string;
  source_dns_label?: string;
  source_geo_country?: string;
  source_geo_city?: string;
  destination_addr?: string;
  destination_name?: string;
  destination_dns_label?: string;
  destination_type?: string;
  destination_geo_country?: string;
  destination_geo_city?: string;
  rx_bytes?: number | string;
  tx_bytes?: number | string;
  reporter_id?: string;
  reporter_name?: string;
  user_id?: string;
  raw_json?: unknown;
  [key: string]: unknown;
}

export interface LogsResponse {
  events: LogEvent[];
  total: number;
  /** The server stopped counting at its cap - `total` is a floor, rendered as "50,000+". */
  totalCapped?: boolean;
  total_pages: number;
  users?: Record<string, UserRef>;
}

export interface AdminEvent {
  id?: number | string;
  timestamp?: string;
  message?: string;
  initiator_id?: string;
  user_id?: string;
  meta?: Record<string, unknown>;
  reference?: string;
  raw_json?: unknown;
  [key: string]: unknown;
}

export interface AdminLogsResponse {
  events: AdminEvent[];
  total: number;
  /** See LogsResponse.totalCapped. */
  totalCapped?: boolean;
  total_pages: number;
  users?: Record<string, UserRef>;
  /** The NetBird user id behind the APP's own API token - events it initiated are app-driven. */
  appUserId?: string;
}

export interface AuditEvent {
  id: number;
  timestamp: string;
  actor_id?: string;
  actor_email?: string;
  actor_name?: string;
  action: string;
  target?: string;
  meta?: Record<string, unknown> | null;
}

// One email / Telegram message the app actually sent (Admin → Notifications).
export interface OutboundEntry {
  id: number;
  timestamp: string;
  channel: 'email' | 'telegram';
  recipient: string;
  feature: string;
  subject: string;
  ok: boolean;
  error: string;
}

// The full rendered body of one sent message - fetched on demand for the preview modal.
export interface OutboundBody {
  id: number;
  channel: 'email' | 'telegram';
  subject: string;
  recipient: string;
  body: string;
}

// ─── Connectivity diagnostics (Troubleshoot page) ───
export interface DiagCheck {
  key: string;
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
  detail: string;
  /** ISO timestamp the row refers to (last seen / expiry) - formatted client-side. */
  at?: string;
}
export interface DiagnosticsInfo {
  hosts: { management: string; signal: string; stun: string };
  ip: string;
  matches: { id: string; name: string; connected: boolean; os: string }[];
}
export interface DeviceDiagnosis {
  peer: {
    id: string; name: string; ip: string; os: string; connected: boolean; last_seen: string;
    kind: string; owner_email: string; approval_required: boolean; force_approved: boolean; login_expired: boolean;
  };
  checks: DiagCheck[];
  recentEvents: { timestamp: string; message: string }[];
}
export interface TargetDiagnosis {
  target: { type: string; id: string; name: string; address?: string; network?: string; networkId?: string; resourceType?: string } | null;
  findings: DiagCheck[];
}
/** A still-relevant NetBird account notification (routing peer down / integration issue). */
export interface NbNotice {
  id: number;
  kind: 'routing' | 'integration';
  event: string;
  message: string;
  peerName: string;
  at: string;
}

// Report-only hygiene sweep (Cleanup page). Nothing here deletes anything.
export type CleanupCategory = 'orphaned-policy' | 'ineffective-policy' | 'empty-group' | 'unreachable-resource' | 'stale-peer';
export interface CleanupOrphanedPolicy { id: string; name: string; enabled: boolean; missing: { kind: 'group' | 'resource'; id: string }[] }
export interface CleanupIneffectivePolicy { id: string; name: string; enabled: boolean; reason: string }
export interface CleanupEmptyGroup { id: string; name: string; issued: string }
export interface CleanupUnreachableResource { id: string; name: string; address: string; networkId: string; network: string }
export interface CleanupStalePeer { id: string; name: string; os: string; kind: string; owner: string; lastSeen: string; days: number }
/** A finding an admin marked "known and fine" - excluded from the lists and the weekly digest. */
export type CleanupIgnored =
  | ({ category: 'orphaned-policy' } & CleanupOrphanedPolicy)
  | ({ category: 'ineffective-policy' } & CleanupIneffectivePolicy)
  | ({ category: 'empty-group' } & CleanupEmptyGroup)
  | ({ category: 'unreachable-resource' } & CleanupUnreachableResource)
  | ({ category: 'stale-peer' } & CleanupStalePeer);
export interface CleanupReport {
  orphanedPolicies: CleanupOrphanedPolicy[];
  ineffectivePolicies: CleanupIneffectivePolicy[];
  emptyGroups: CleanupEmptyGroup[];
  unreachableResources: CleanupUnreachableResource[];
  stalePeers: CleanupStalePeer[];
  ignored: CleanupIgnored[];
  staleDays: number;
  scannedAt: string;
}

// Reverse-proxy (NetBird Cloud ingress) status - clusters + the services published on them.
export interface ProxyCluster {
  id: string;
  address: string;
  type: string; // 'shared' | 'account'
  online: boolean;
  connectedProxies: number;
  private: boolean;
  services: number;
}
export interface ProxyService {
  id: string;
  name: string;
  domain: string;
  enabled: boolean;
  status: string;
  cluster: string;
  mode: string;
  targets: number;
  /** "host:port" per target (Reverse Proxy page tooltip). */
  targetList?: string[];
  /** Full target rows for the expandable Targets sub-table. */
  targetsDetail?: { name: string; sub: string; path: string; destination: string; enabled: boolean; accessAction?: 'bypass' | 'block' }[];
  /** Enabled auth methods for the lock badge's hover card. */
  authMethods?: { kind: string; label: string; groups?: string[]; headers?: number }[];
  /** Access-control rules for the shield badge's hover card. */
  aclRules?: { label: string; allow?: boolean; value: string }[];
  listenPort?: number;
  /** Enabled auth methods (+header auths +NetBird-only) - drives the lock badge. */
  authCount?: number;
  /** Access-control rules (+CrowdSec) - drives the shield badge. */
  aclCount?: number;
}
export interface ReverseProxyStatus {
  available: boolean;
  clusters: ProxyCluster[];
  services: ProxyService[];
}

// A domain base for new services: free (cluster) or validated custom - each carries the
// cluster that serves it, which the create flow derives (like the official dashboard).
export interface ProxyDomain {
  id: string;
  domain: string;
  type: 'free' | 'custom';
  validated: boolean;
  cluster: string;
  requireSubdomain: boolean;
}

// One target as sent to create/update. type: peer/host/domain/subnet (id) or 'cluster' (host).
export interface ProxyTargetInput {
  type: 'peer' | 'host' | 'domain' | 'subnet' | 'cluster' | 'container';
  id?: string;
  host?: string;
  /** Container targets only: the network whose routing peer resolves the container's DNS name. */
  networkId?: string;
  /** Container targets only: the container's DNS name - a domain resource is created/reused for it. */
  containerDomain?: string;
  port: number;
  protocol: string;
  path?: string;
  enabled?: boolean;
  skipTlsVerify?: boolean;
  /** Keep the original request path when forwarding (official "Preserve Full Path"). */
  preservePath?: boolean;
  /** NetBird v0.81+ per-path access; omitted = leave the stored value as it is. */
  accessAction?: 'inherit' | 'bypass' | 'block';
}
export interface CreateProxyServiceInput {
  name?: string;
  domain: string;
  cluster: string;
  enabled?: boolean;
  targets: ProxyTargetInput[];
  passHostHeader?: boolean;
  rewriteRedirects?: boolean;
}
// Flat inventory for the unified target picker.
export interface ProxyTargetOptions {
  peers: { id: string; name: string; ip: string; dns: string; os: string }[];
  resources: { id: string; name: string; address: string; type: string; network: string }[];
}

// Expose a Docker container: [routing peer] + domain resource + service, rolled back on failure.
export interface ExposeDockerInput {
  networkId: string;
  containerDomain: string;
  resourceName?: string;
  routerPeerId?: string;
  port: number;
  protocol?: string;
  path?: string;
  preservePath?: boolean;
  serviceDomain: string;
  serviceName?: string;
  cluster: string;
  passHostHeader?: boolean;
  rewriteRedirects?: boolean;
}

// A service as served to the Edit modal - auth secrets stripped ("set" flags only).
export interface EditableProxyTarget {
  target_type: string;
  target_id: string;
  host: string;
  port: number;
  protocol: string;
  path: string;
  enabled: boolean;
  direct: boolean;
  skipTlsVerify?: boolean;
  preservePath?: boolean;
  accessAction?: 'inherit' | 'bypass' | 'block';
}
export interface EditableProxyService {
  id: string;
  name: string;
  domain: string;
  mode: string;
  cluster: string;
  enabled: boolean;
  listenPort: number;
  private: boolean;
  passHostHeader?: boolean;
  rewriteRedirects?: boolean;
  accessGroups: string[];
  targets: EditableProxyTarget[];
  auth: {
    password: { enabled: boolean; set: boolean };
    pin: { enabled: boolean; set: boolean };
    sso: { enabled: boolean; groups: string[] };
    link: { enabled: boolean };
    headers: { enabled: boolean; header: string }[];
  };
  access: { allowedCidrs: string[]; blockedCidrs: string[]; allowedCountries: string[]; blockedCountries: string[]; crowdsec: string };
}
export interface UpdateProxyServiceInput {
  /** For the audit label only. */
  domain?: string;
  name?: string;
  enabled?: boolean;
  targets?: (Partial<EditableProxyTarget> & { type?: string; id?: string })[];
  private?: boolean;
  passHostHeader?: boolean;
  rewriteRedirects?: boolean;
  accessGroups?: string[];
  auth?: {
    password?: { enabled: boolean; value?: string };
    pin?: { enabled: boolean; value?: string };
    sso?: { enabled: boolean; groups: string[] };
    link?: { enabled: boolean };
    /** Full replacement list. Blank value on an existing header = keep its current secret. */
    headers?: { enabled: boolean; header: string; value?: string }[];
  };
  access?: { allowedCidrs?: string[]; blockedCidrs?: string[]; allowedCountries?: string[]; blockedCountries?: string[]; crowdsec?: string };
}

// One reverse-proxy ACCESS log entry - the documented GET /api/events/proxy shape, plus
// backend-added serviceName / userName so the UI never shows opaque ids.
export interface ProxyAccessLog {
  id?: string;
  service_id?: string;
  timestamp?: string;
  protocol?: string;
  method?: string;
  host?: string;
  path?: string;
  duration_ms?: number;
  status_code?: number;
  source_ip?: string;
  reason?: string;
  user_id?: string;
  auth_method_used?: string;
  country_code?: string;
  city_name?: string;
  subdivision_code?: string;
  bytes_upload?: number;
  bytes_download?: number;
  metadata?: Record<string, string>;
  serviceName: string;
  userName: string;
}
// One row of the proxy-logs Summary view: the filtered logs aggregated per SERVICE + USER.
export interface ProxyLogsSummaryRow {
  serviceId: string;
  serviceName: string;
  userId: string;
  userName: string;
  requests: number;
  success: number;
  failed: number;
  sources: number;
  bytesDownload: number;
  bytesUpload: number;
  firstSeen: string;
  lastSeen: string;
}
export interface ProxyLogsSummaryResponse { rows: ProxyLogsSummaryRow[] }

// Whole-history totals per service (statistics shown on each Services-tab row).
export interface ProxyServiceStats {
  serviceId: string;
  requests: number;
  failed: number;
  users: number;
  bytesDownload: number;
  bytesUpload: number;
  lastSeen: string;
}

export interface ProxyLogsResponse {
  available: boolean;
  /** Always true - the app ingests NetBird's 7-day window into its own DB. */
  storedLocally?: boolean;
  lastSync?: string | null;
  logs: ProxyAccessLog[];
  page: number;
  per_page: number;
  total: number;
  /** See LogsResponse.totalCapped. */
  totalCapped?: boolean;
  total_pages: number;
}

// One aggregated "conversation" row in the traffic Summary view (per source→destination pair).
export interface TrafficSummaryRow {
  sourceName: string;
  /** Display label (ingress "proxy-<id>" peers resolved to readable names); filter by sourceName. */
  sourceLabel?: string;
  destinationLabel?: string;
  sourceId: string | null;
  sourceDns: string;
  sourceHost: string;
  destinationName: string;
  destinationId: string | null;
  destinationDns: string;
  destinationType: string;
  destinationHost: string;
  userId: string;
  sourceGeo: string;
  destinationGeo: string;
  connections: number;
  eventCount: number;
  rx: number;
  tx: number;
  firstSeen: string;
  lastSeen: string;
  ports: string[];
  protocols: number[];
}
export interface TrafficSummaryResponse {
  rows: TrafficSummaryRow[];
  users?: Record<string, UserRef>;
  total: number;
  /** See LogsResponse.totalCapped. */
  totalCapped?: boolean;
  page: number;
  per_page: number;
  total_pages: number;
}

// One interval of "this NetBird IP belonged to this peer/user" (forensic IP↔user history).
export interface IpAssignment {
  id: number;
  ip: string;
  connectionIp: string;
  peerId: string;
  peerName: string;
  dnsLabel: string;
  region: string;
  countryCode: string;
  userId: string;
  userName: string;
  userEmail: string;
  firstSeen: string;
  lastSeen: string;
  releasedAt: string | null;
}
export interface IpHistoryResponse {
  rows: IpAssignment[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface AuditResponse {
  events: AuditEvent[];
  total: number;
  /** See LogsResponse.totalCapped. */
  totalCapped?: boolean;
  total_pages: number;
}

export interface NbUser {
  id: string;
  name?: string;
  email?: string;
  role?: string;
  status?: string;
  is_blocked?: boolean;
  is_service_user?: boolean;
  pending_approval?: boolean;
  last_login?: string;
  groups?: GroupRef[]; // auto-assigned groups (resolved to {id,name})
}

/** Payload for POST /api/users/invite - NetBird Cloud mails the invitation itself. */
export interface InviteUserInput {
  name: string;
  email: string;
  role: string;
  /** Groups auto-assigned to peers this user adds (may be empty). */
  autoGroups: string[];
}

/** Default Auto-Assigned Groups the invite modal pre-selects (NetBird group ids, per account). */
export interface InviteDefaultGroups {
  groups: string[];
}

/** Result of POST /api/setup-keys - `key` is the plaintext secret, returned ONCE (never stored). */
export interface SetupKeyResult {
  key: string;
  name: string;
  expires: string;
}

// Body for creating a setup key. Add Peer sends only { name } (the backend defaults the rest to
// the official one-off install key); the group Setup Keys modal sends the full field set.
export interface CreateSetupKeyInput {
  name?: string;
  type?: 'reusable' | 'one-off';
  expiresInDays?: number; // 0 = never expires
  usageLimit?: number;    // reusable only; 0 = unlimited
  ephemeral?: boolean;
  autoGroups?: string[];
  allowExtraDnsLabels?: boolean;
}

export interface NbGroup {
  id: string;
  name: string;
  issued: string;
  users_count: number;
  peers_count: number;
  resources_count: number;
  policies_count: number;
  routes_count: number;
  nameservers_count: number;
  zones_count: number;
  setup_keys_count: number;
}

// A peer as shown inside group/user detail pages.
export interface DetailPeer {
  id: string;
  name: string;
  ip?: string;
  dns_label?: string;
  os?: string;
  version?: string;
  connected?: boolean;
  last_seen?: string;
  owner_email?: string;
}

export interface GroupMemberUser {
  id: string;
  name?: string;
  email?: string;
  role?: string;
  status?: string;
  is_blocked?: boolean;
  last_login?: string;
}

export interface GroupResourceRef {
  id: string;
  name?: string;
  address?: string;
  type?: string;
  enabled?: boolean;
  network_id?: string;
  network_name?: string;
}

export interface PolicyGroupRef {
  id: string;
  name: string;
  peers_count: number;
  resources_count: number;
}

export interface GroupPolicy {
  id: string;
  name: string;
  enabled: boolean;
  action: string;
  protocol: string;
  ports: string[];
  bidirectional: boolean;
  sources: PolicyGroupRef[];
  destinations: PolicyGroupRef[];
}

export interface GroupRoute {
  id: string;
  network_id: string;
  network?: string;
  description?: string;
  enabled: boolean;
  masquerade: boolean;
  metric: number | null;
}

export interface GroupNameserver {
  id: string;
  name: string;
  enabled: boolean;
  primary: boolean;
  domains: string[];
  nameservers: string[];
}

export interface GroupZone {
  id: string;
  name: string;
  domain: string;
  enabled: boolean;
}

export interface GroupSetupKey {
  id: string;
  name: string;
  state: string;
  valid: boolean;
  revoked: boolean;
  type: string;
  used_times: number;
  usage_limit: number | null;
  ephemeral: boolean;
  expires: string | null;
}

export interface GroupDetail {
  id: string;
  name: string;
  issued: string;
  users: GroupMemberUser[];
  peers: DetailPeer[];
  resources: GroupResourceRef[];
  policies: GroupPolicy[];
  routes: GroupRoute[];
  nameservers: GroupNameserver[];
  zones: GroupZone[];
  setupKeys: GroupSetupKey[];
  users_count: number;
  peers_count: number;
  resources_count: number;
  policies_count: number;
  routes_count: number;
  nameservers_count: number;
  zones_count: number;
  setup_keys_count: number;
}

export interface UserDetail {
  id: string;
  name?: string;
  email?: string;
  role?: string;
  status?: string;
  last_login?: string;
  is_blocked?: boolean;
  is_service_user?: boolean;
  // Whether NetBird serves the cloud MFA reset endpoint on this API base; false disables Reset MFA.
  mfa_supported?: boolean;
  groups: GroupRef[];
  peers: DetailPeer[];
}

export interface PeerNetworkAddress {
  /** Interface address with prefix, e.g. 192.168.0.11/24. */
  ip: string;
  mac: string;
}

export type PeerKind = 'user-device' | 'server';

export interface Peer {
  id: string;
  name?: string;
  ip?: string;
  connection_ip?: string;
  /** Local interfaces (IP + MAC) the peer reports - NetBird v0.81+, empty on older servers. */
  network_addresses?: PeerNetworkAddress[];
  dns_label?: string;
  kind?: PeerKind;
  /** NetBird user id of the owner (empty for setup-key/server peers). */
  user_id?: string;
  owner_name?: string;
  owner_email?: string;
  groups?: string[];
  groupRefs?: { id: string; name: string; peers_count: number }[];
  group_count?: number;
  disapproval_reason?: string;
  connected?: boolean;
  last_seen?: string;
  last_login?: string;
  version?: string;
  ui_version?: string;
  hostname?: string;
  os?: string;
  country?: string;
  country_code?: string;
  city?: string;
  geo?: string;
  // Compliance / posture-relevant flags.
  login_expired?: boolean;
  login_expiration_enabled?: boolean;
  inactivity_expiration_enabled?: boolean;
  /** When the peer's SSO session expires (last_login + the account's expiration setting). */
  session_expires_at?: string | null;
  approval_required?: boolean;
  force_approved?: boolean;
  /** Scheduled auto-revoke of an approved bypass (null/absent = unlimited). */
  bypass_expires_at?: string | null;
  /** Temporary device - deleted automatically when the bypass expires. */
  bypass_temp_device?: boolean;
  /** Operational metadata (app-side): free-form tags + a note. */
  tags?: string[];
  note?: string;
}

export interface GroupRef { id: string; name: string }

// Recurring access: a standing weekday + daily-window schedule that spawns a normal
// temporary grant at each window start (expires at the window end on its own).
export interface RecurringAccessRule {
  id: number;
  userId: string;
  userLabel: string;
  userEmail?: string;
  targets: GrantTarget[];
  days: number[]; // 0=Sunday … 6=Saturday, app time zone
  startTime: string; // HH:MM
  endTime: string;   // HH:MM
  /** Optional end date (YYYY-MM-DD, inclusive) - past it the rule stops and is auto-disabled. */
  validUntil?: string;
  enabled: boolean;
  note?: string;
  createdBy?: string;
  activeGrantId?: number | null;
  createdAt?: string;
}
export type RecurringAccessInput = Omit<RecurringAccessRule, 'id' | 'createdBy' | 'activeGrantId' | 'createdAt'>;

export interface PeerDetail {
  id: string;
  name: string;
  hostname?: string;
  dns_label?: string;
  ip?: string;
  ipv6?: string;
  connection_ip?: string;
  /** Local interfaces (IP + MAC) the peer reports - NetBird v0.81+, empty on older servers. */
  network_addresses?: PeerNetworkAddress[];
  connected: boolean;
  created_at?: string;
  last_seen?: string;
  last_login?: string;
  login_expired?: boolean;
  login_expiration_enabled?: boolean;
  inactivity_expiration_enabled?: boolean;
  /** When the peer's SSO session expires (last_login + the account's expiration setting). */
  session_expires_at?: string | null;
  os?: string;
  version?: string;
  ui_version?: string;
  kernel_version?: string;
  serial_number?: string;
  city_name?: string;
  country_code?: string;
  ssh_enabled?: boolean;
  ephemeral?: boolean;
  approval_required?: boolean;
  force_approved?: boolean;
  bypass_expires_at?: string | null;
  bypass_temp_device?: boolean;
  tags?: string[];
  note?: string;
  disapproval_reason?: string;
  raw?: Record<string, unknown>;
  groups: GroupRef[];
  user_id?: string;
  owner_name?: string;
  owner_email?: string;
  kind?: PeerKind;
}

export interface NetworkGrant {
  id: string;
  name: string;
  /** 'source' = grantable-only: editors may pick it as a policy source; no network rights. */
  access: 'edit' | 'view' | 'source';
  // Edit grants only: whether the group is auto-added as a source of NEW policies (default true).
  policySource?: boolean;
}

export interface Network {
  id: string;
  name?: string;
  description?: string;
  canEdit?: boolean;
  canView?: boolean;
  grants?: NetworkGrant[];
  resources?: number;
  policies?: number;
  routingPeers?: number;
  /** Per-network opt-out of the duplicate/overlapping-address guard. */
  allowDuplicates?: boolean;
}

export interface ResourcePolicy {
  id: string;
  name?: string;
  enabled?: boolean;
  protocol?: string;
  ports?: string[];
  sources?: GroupRef[];
  description?: string;
  bidirectional?: boolean;
  postureChecks?: string[];
  inherited?: boolean; // true = applies via a group the resource belongs to (read-only)
  /** Direct policy the resource editor can't reproduce exactly (several rules, SSH, Drop, ...). */
  notReproducible?: boolean;
  viaGroup?: string;
}

export interface Resource {
  id: string;
  name?: string;
  address?: string;
  type?: string;
  description?: string;
  enabled?: boolean;
  groups?: GroupRef[];
  policies?: ResourcePolicy[];
}

export interface Router {
  id?: string;
  enabled?: boolean;
  masquerade?: boolean;
  metric?: number;
  peer?: string;
  /** Raw NetBird peer id (when the router is a single peer) - for linking to the peer page. */
  peerId?: string;
  peerGroups?: string[];
  /** Group ids + names (when the router is peer group(s)) - for linking to the group pages. */
  peerGroupRefs?: { id: string; name: string }[];
}

export interface PolicyResourceRef { id: string; name: string; type?: string }
export interface PolicyRule {
  action?: string;
  protocol?: string;
  ports?: string[];
  bidirectional?: boolean;
  enabled?: boolean;
  sources?: PolicyGroupRef[];
  destinations?: PolicyGroupRef[];
  destinationResource?: PolicyResourceRef | null; // single-resource target (vs group destinations)
  /** The rule holds fields the single-rule editor can't show (SSH authorized groups, source resource, ...). */
  unmodeled?: boolean;
}

export interface Policy {
  id?: string;
  name?: string;
  enabled?: boolean;
  description?: string;
  postureChecks?: string[];
  rules?: PolicyRule[];
  /** Set when a shared Access Profile owns this policy - it's managed from the profile. */
  profileName?: string;
}

// Tidy Names: align existing resource-policy names with the admin's naming template.
export interface TidyNameItem {
  id: string;
  currentName: string;
  proposedName: string;
  resourceName: string;
  protocol: string;
  /** The policy's resource has 2+ policies - named by the shared template ({service}). */
  shared?: boolean;
  changed: boolean;
}
export interface TidyNamesPlan {
  template: string;
  /** Template for shared (multi-policy) resources - default '{service}'. */
  sharedTemplate?: string;
  items: TidyNameItem[];
  excluded: number;
  /** Dropped because two policies of one resource would get the same name. */
  excludedCollisions?: number;
}
export interface TidyNamesResult { renamed: number; failed: number; errors: { id: string; name: string; error: string }[] }

// Payload for the admin policy editor (create/update). Sources/destinations are group ids.
export interface PolicyEditInput {
  name: string;
  description?: string;
  enabled: boolean;
  sources: string[];
  destinations: string[];
  destinationResource?: PolicyResourceRef; // preserved so editing never wipes a resource target
  preserveRules?: boolean; // keep the policy's existing (multi/resource) rules verbatim on save
  rulesFromPolicyId?: string; // Duplicate: create with this policy's rules copied verbatim (server-side)
  protocol: string;
  ports: string[];
  bidirectional: boolean;
  postureChecks: string[];
}

export interface NetworkDetail {
  id: string;
  name?: string;
  description?: string;
  resources: Resource[];
  routers: Router[];
  policies: Policy[];
  allowDuplicates?: boolean;
}

export interface PolicyOptions {
  canChoose: boolean;
  groups: GroupRef[];
  defaultIds: string[];
  defaultProfileIds?: number[]; // network's default Access Profiles (pre-selected on new resources)
}

// { networkId: [profileId, ...] } - per-network default Access Profiles.
export type NetworkDefaultProfiles = Record<string, number[]>;

export interface Template {
  id: number | string;
  name: string;
  protocol: string;
  ports: string[];
  description?: string;
}

// A named {source groups + protocol/ports} bundle = one group + one policy under the
// hood. Assign resources to it; they inherit the shared policy.
export interface AccessProfile {
  id: number;
  name: string;
  shared: boolean;       // true = group-backed shared policy; false = Direct (protocol/ports preset)
  groupId: string;
  sources: GroupRef[];
  protocol: string;
  ports: string[];
  postureChecks: string[]; // posture-check ids attached to the shared policy
  resourceCount: number;
}

export interface AccessProfileInput {
  name: string;
  shared: boolean;
  sources: string[];
  protocol: string;
  ports: string[];
  postureChecks: string[];
}

// ─── Posture Checks (mirror the NetBird Management API) ───
export interface OsVersionCheck {
  android?: { min_version: string };
  darwin?: { min_version: string };
  ios?: { min_version: string };
  linux?: { min_kernel_version: string };
  windows?: { min_kernel_version: string };
}
export interface GeoLocation { country_code: string; city_name?: string }
export interface GeoLocationCheck { action: 'allow' | 'deny'; locations: GeoLocation[] }
export interface PeerNetworkRangeCheck { action: 'allow' | 'deny'; ranges: string[] }
export interface ProcessItem { linux_path?: string; mac_path?: string; windows_path?: string }
export interface ProcessCheck { processes: ProcessItem[] }

export interface PostureChecks {
  nb_version_check?: { min_version: string };
  os_version_check?: OsVersionCheck;
  geo_location_check?: GeoLocationCheck;
  peer_network_range_check?: PeerNetworkRangeCheck;
  process_check?: ProcessCheck;
  /** NetBird v0.81+: the peer must hold a certificate issued by one of these CAs (PEM). */
  certificate_check?: { ca_certificates: string[] };
}

/** Server-side parse of one pasted CA certificate (POST /api/posture-checks/inspect-certificates). */
export interface CaCertInfo {
  ok: boolean;
  error?: string;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  expired?: boolean;
  isCA?: boolean;
  fingerprint256?: string;
}

export interface PostureCheck {
  id: string;
  name: string;
  description?: string;
  checks: PostureChecks;
}

export interface PostureCheckInput {
  name: string;
  description?: string;
  checks: PostureChecks;
}

export interface Country { country_code: string; country_name: string }
export interface CityRef { city_name: string; geoname_id?: number }

// ─── Automations (external HTTP source → auto-provisioned resources) ───
export interface Automation {
  id: number;
  name: string;
  enabled: boolean;
  endpointUrl: string;
  authType: 'none' | 'bearer' | 'header';
  authHeader: string;
  hasSecret: boolean;
  sourceFormat: 'json' | 'text';
  namePrefix: string;
  itemsPath: string;
  addressField: string;
  nameField: string;
  descriptionField: string;
  keyField: string;
  networkId: string;
  profileIds: number[];
  intervalMinutes: number;
  removalMode: 'disable' | 'none' | 'delete';
  minItems: number;
  lastRunAt: string | null;
  lastStatus: string;
  lastError: string;
}

export interface AutomationInput {
  name: string;
  enabled: boolean;
  endpointUrl: string;
  authType: string;
  authHeader: string;
  secret?: string;
  sourceFormat: string;
  namePrefix: string;
  itemsPath: string;
  addressField: string;
  nameField: string;
  descriptionField: string;
  keyField: string;
  networkId: string;
  profileIds: number[];
  intervalMinutes: number;
  removalMode: string;
  minItems: number;
}

export interface AutomationRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string;
  created: number;
  updated: number;
  adopted: number;
  disabled: number;
  skipped: number;
  conflicts: number;
  blocked: number;
  failed: number;
  error: string;
  errors: string[];
}

export interface AutomationTestPreviewItem {
  key: string; address: string; name: string; description: string; valid: boolean; reason?: string;
  blocked?: boolean; blockedBy?: string;
}
export interface AutomationTestResult {
  ok?: boolean;
  stage?: string;
  error?: string;
  httpStatus?: number;
  rawSnippet?: string;
  itemsFound?: number;
  total?: number;
  valid?: number;
  invalid?: number;
  blocked?: number;
  duplicates?: { keys: number; addresses: number };
  availableFields?: string[];
  preview?: AutomationTestPreviewItem[];
}

export interface AutomationManagedRow {
  key: string; address: string; resourceId: string; status: string;
  lastSeenAt: string | null; orphan: boolean; liveEnabled: boolean | null; name: string;
}
export interface AutomationManaged {
  networkKnown: boolean;
  resources: AutomationManagedRow[];
}

export type BlocklistEnforce = 'none' | 'disable' | 'delete';
export interface BlocklistEntry {
  id: number; value: string; note: string; scope: 'all' | 'only' | 'except'; networks: string[];
  enforce: BlocklistEnforce; enabled: boolean;
  /** 'block' = classic; 'limit' = inside this range only CIDRs at least as narrow as maxPrefix may be added. */
  mode: 'block' | 'limit';
  maxPrefix?: number;
}
export interface BlocklistInput { value: string; note: string; scope: string; networks: string[]; enforce: BlocklistEnforce; enabled?: boolean; mode?: 'block' | 'limit'; maxPrefix?: number }
// Bulk add (addresses picked from a network's resources) - shared note/scope/networks/enforce.
export interface BulkBlocklistInput { values: string[]; note: string; scope: string; networks: string[]; enforce: BlocklistEnforce }
export interface BulkBlocklistResult { added: number; skipped: number }

export interface BlockedResourceMatch {
  resourceId: string; resourceName: string; address: string; enabled: boolean;
  networkId: string; networkName: string; matchedValue: string; action: 'disable' | 'delete'; entryId: number;
}
export interface BlockedMatchesResult { matches: BlockedResourceMatch[]; entries: number }
export interface EnforceBlocklistResult {
  disabled: number; deleted: number; skipped: number; failed: number; total: number;
  errors?: { resourceId: string; networkId: string; error: string }[];
}

// ── Temporary access grants ──
export type GrantTargetType = 'resource' | 'network' | 'group' | 'profile' | 'peer';
/** Protocol/port scope for a grant target. [] = all ports of that protocol. */
export interface TargetAccessSpec { tcp?: string[]; udp?: string[]; icmp?: boolean }
export interface GrantTarget {
  type: GrantTargetType;
  id: string;
  name: string;
  networkId?: string;      // resource targets
  resourceType?: string;   // resource targets → NetBird destinationResource type
  groupId?: string;        // profile targets → the profile's destination group
  /** Port-policy sub-entry: the grant opens ONLY these protocols/ports of the resource. */
  access?: TargetAccessSpec;
}
export type GrantStatus = 'active' | 'expired' | 'revoked' | 'error';
export interface TemporaryAccessGrant {
  id: number;
  userId: string;
  userLabel: string;
  groupId: string;
  policyIds: string[];
  targets: GrantTarget[];
  note: string;
  issuedAt: string;
  expiresAt: string;
  status: GrantStatus;
  lastError: string;
  createdBy: string;
  revokedBy: string;
  revokedAt: string | null;
}
export interface TemporaryAccessGrantInput {
  userId: string;
  userLabel?: string;
  targets: GrantTarget[];
  durationMinutes?: number;
  expiresAt?: string;
  note?: string;
}
export interface ExtendGrantInput { durationMinutes?: number; expiresAt?: string }

// ── Access requests ──
export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
export interface AccessRequest {
  id: number;
  requesterId: string;
  requesterEmail: string;
  requesterName: string;
  targets: GrantTarget[];
  /** What was actually granted (the approver may add/remove targets); null until approved. */
  approvedTargets?: GrantTarget[] | null;
  reason: string;
  requestedMinutes: number;
  /** Minutes actually granted on approval (0 = unlimited bypass); null until approved / legacy rows. */
  approvedMinutes?: number | null;
  // 'access' = temporary access to targets; 'bypass' = approve the requester's own device.
  kind: 'access' | 'bypass';
  /** Bypass only: the device is temporary - deleted automatically when the bypass expires. */
  tempDevice?: boolean;
  /** Bypass only: an extension request for an active timed bypass (approval moves the expiry). */
  extendBypass?: boolean;
  status: AccessRequestStatus;
  createdAt: string;
  decidedBy: string;
  decidedAt: string | null;
  decisionNote: string;
  /** How the decision was made: 'App' / 'Telegram' / 'Auto-approval' ('' on legacy rows). */
  decidedVia?: string;
  grantId: number | null;
}
export interface CreateAccessRequestInput {
  targets: GrantTarget[];
  reason: string;
  requestedMinutes?: number;
  kind?: 'access' | 'bypass';
  /** Bypass only: delete the device automatically when the approved period ends. */
  tempDevice?: boolean;
}
// A submission may split into an auto-approved part and a pending part.
export interface CreateAccessRequestResult {
  id: number;
  ids: number[];
  autoApproved: number;
  pending: number;
}

// Auto-approval: which requests skip human review (trusted Entra groups + per-target self-service).
// Each entry/rule carries its OWN duration cap (0 = honor the requested length).
export interface AutoApprovalTrusted {
  groupIds: string[];
  maxMinutes: number;
  /** false = paused: stays configured but never auto-approves. */
  enabled?: boolean;
  // Critical targets this entry must NOT auto-approve - they fall back to human review.
  excludedTargets: AutoApprovalRuleTarget[];
  /** Network scoping: 'all' = any network · 'allow' = only inside `networks` · 'block' = anywhere except `networks`. */
  networkMode?: 'all' | 'allow' | 'block';
  networks?: { id: string; name: string }[];
}
export interface AutoApprovalRuleTarget {
  type: GrantTargetType;
  id: string;
  name: string;
}
// Exact protocols/ports an auto-approved grant opens (one temp policy per protocol - NetBird
// can't mix TCP/UDP/ICMP in one rule). Key present = protocol allowed ([] = all its ports);
// key absent = protocol not allowed. null/undefined = mirror the target's existing exposure.
export interface AutoApprovalAccess { tcp?: string[]; udp?: string[]; icmp?: boolean }
export interface AutoApprovalRule {
  targets: AutoApprovalRuleTarget[];
  groupIds: string[];
  maxMinutes: number;
  access?: AutoApprovalAccess | null;
  /** false = paused: stays configured but never auto-approves. */
  enabled?: boolean;
}
export interface AutoApprovalConfig {
  trusted: AutoApprovalTrusted[];
  rules: AutoApprovalRule[];
}
export interface AutoApprovalConfigInput {
  trusted: AutoApprovalTrusted[];
  rules: AutoApprovalRule[];
}
export interface RequestTargetResult {
  type: GrantTargetType;
  id: string;
  name: string;
  subtitle?: string;
  networkId?: string;
  resourceType?: string;
  groupId?: string;
  /** Present on port-policy sub-entries (one per port policy of the resource). */
  access?: TargetAccessSpec;
}

export interface AutomationRunResult {
  status?: string;
  created?: number;
  updated?: number;
  adopted?: number;
  disabled?: number;
  skipped?: number;
  conflicts?: number;
  blocked?: number;
  failed?: number;
  profiled?: number;
  error?: string;
}

export interface TemplatesResponse {
  templates: Template[];
}

// Policy entry as edited in the resource modal and POSTed to the backend.
export interface PolicyInput {
  sources: string[];
  protocol: string;
  ports: string[];
  /** Optional richer fields (per-resource policies edited via the shared policy modal). */
  name?: string;
  description?: string;
  enabled?: boolean;
  bidirectional?: boolean;
  postureChecks?: string[];
}

// Event-filtering rule - discards matching webhook traffic events before storage.
export interface FilterRule {
  id: number;
  field: string;
  operator: string;
  value: string;
  enabled: boolean;
  sort_order?: number;
}

export interface FilterRulesResponse {
  rules: FilterRule[];
  builtinNoise: boolean;
  fields: string[];
  operators: string[];
}

export interface FilterRuleInput {
  field: string;
  operator: string;
  value: string;
  enabled: boolean;
}

// ─── Internal envelope-encrypted backup (tier 2) - full config + all secrets ───
export interface InternalBackupFile { name: string; size: number; at: string }
export interface InternalBackupConfig { enabled: boolean; hour: number; keep: number }
export interface InternalBackupStatus {
  /** BACKUP_DIR exists and is writable. */
  dirOk: boolean;
  dir: string;
  /** An encryption keypair is configured (a passphrase has been set). */
  keyConfigured: boolean;
  config: InternalBackupConfig;
  /** Newest first. */
  files: InternalBackupFile[];
}
export interface InternalBackupRunResult { file: string; size: number }
export interface InternalBackupRestoreResult {
  settings: number;
  tables?: Record<string, number>;
  skipped?: Record<string, number>;
}
