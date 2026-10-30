import { useState, type ReactNode } from 'react';
import { Shield, FolderGit2, Lock, Network, MonitorSmartphone, AlertTriangle, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { NetbirdNbSettings } from '@/lib/types';
import { Field, Input, Select } from '@/components/ui';

// ─── Shared NetBird account-settings field UI ───
// The category cards + row/panel/input helpers that render the full official NetBird account-settings
// field set. Reused by BOTH Tenant Defaults (the seed template for NEW tenants) and the live NetBird
// Settings editor (the current account's ACTUAL settings) so the two never drift apart.

// On/off switch matching the app's toggle style (see AutoApprovalPanel's MiniToggle).
export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 rounded-full transition-colors shrink-0',
        checked ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700',
        disabled && 'opacity-50 cursor-not-allowed')}
    >
      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

// A single setting row mirroring the official dashboard's FancyToggleSwitch anatomy: setting name
// (medium weight) with a muted help line beneath it, and the toggle aligned right on the same row.
// Anything passed as children renders below the row (e.g. a duration or claim-name input when on).
export function SettingRow({ title, help, checked, onChange, disabled, children }: {
  title: ReactNode; help?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children?: ReactNode;
}) {
  return (
    <div className={cn('py-3.5 first:pt-0 last:pb-0', disabled && 'opacity-50')}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">{title}</div>
          {help && <p className="text-[0.72rem] text-nb-gray-500 mt-0.5">{help}</p>}
        </div>
        <div className="pt-0.5"><Toggle checked={checked} onChange={onChange} disabled={disabled} /></div>
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

// The official "attached" sub-panel: a bordered box that reads as a continuation of the row above
// it (open only when its parent toggle is on). Dims/locks when the whole category is disabled.
export function SubPanel({ disabled, children }: { disabled?: boolean; children: ReactNode }) {
  return (
    <div className={cn('rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50/70 dark:bg-nb-gray-900/40 px-4 py-4 flex flex-col gap-4',
      disabled && 'opacity-50 pointer-events-none')}>
      {children}
    </div>
  );
}

// A tag/chip input (type + Enter adds a chip, click a chip to remove) - mirrors the official
// JWT Allow Groups control. Values are de-duplicated and trimmed.
export function TagInput({ values, onChange, disabled, placeholder }: {
  values: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((g) => (
            <button type="button" key={g} disabled={disabled}
              onClick={() => onChange(values.filter((x) => x !== g))}
              className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 bg-nb-gray-100 px-2.5 py-1 text-[0.75rem] text-nb-gray-600 transition-colors hover:border-nb-gray-300 hover:text-nb-gray-800 dark:border-nb-gray-800/50 dark:bg-nb-gray-900 dark:text-nb-gray-300 dark:hover:text-nb-gray-100">
              {g}<X size={12} className="shrink-0" />
            </button>
          ))}
        </div>
      )}
      <Input value={draft} disabled={disabled} placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        onBlur={add} />
    </div>
  );
}

// A category header mirroring the official settings tabs: the tab's icon in a soft tile, its title,
// and a one-line description.
export function CategoryHeader({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-nb-gray-100 text-nb-gray-600 dark:bg-nb-gray-800/60 dark:text-nb-gray-300">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">{title}</div>
        <p className="text-[0.8rem] text-nb-gray-500 mt-0.5">{description}</p>
      </div>
    </div>
  );
}

// A duration expressed in seconds, edited as a number + Days/Hours unit (matches the official
// dashboard). Days when evenly divisible by a day, otherwise hours - always round-trips to seconds.
const DAY = 86400;
const HOUR = 3600;
export function DurationPicker({ seconds, onChange, disabled }: { seconds: number; onChange: (s: number) => void; disabled?: boolean }) {
  const asDays = seconds > 0 && seconds % DAY === 0;
  const unit = asDays ? DAY : HOUR;
  const value = seconds > 0 ? Math.round(seconds / unit) : 0;
  return (
    <div className="flex items-center gap-2">
      <Input type="number" min={1} value={value || ''} disabled={disabled} className="w-24"
        onChange={(e) => onChange((parseInt(e.target.value, 10) || 0) * unit)} />
      <Select value={String(unit)} disabled={disabled} className="w-28"
        onChange={(e) => {
          const nextUnit = parseInt(e.target.value, 10);
          onChange((value || 1) * nextUnit);
        }}>
        <option value={String(DAY)}>Days</option>
        <option value={String(HOUR)}>Hours</option>
      </Select>
    </div>
  );
}

export const CARD = 'rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4 flex flex-col gap-4';
// Rows within a category: divided like the official settings and set off from the header by a top rule.
export const ROWS = 'divide-y divide-nb-gray-100 dark:divide-nb-gray-800 border-t border-nb-gray-100 dark:border-nb-gray-800 pt-1';

// The category cards accept the flat nb shape; Tenant Defaults passes its superset (with the
// seeding-only ipv6_disable), the live editor passes the plain shape. ipv6_disable is optional so
// both compile - the toggle that reads it renders only in the 'defaults' variant.
type NbFields = NetbirdNbSettings & { ipv6_disable?: boolean };

// The five official NetBird settings categories (Authentication / Groups / Permissions / Networks /
// Clients), shared verbatim between the two editors. `variant` is the ONLY difference:
//   • 'defaults' - Tenant Defaults: infra hints say "keep the tenant's default", plus a Disable IPv6
//     toggle (clearing the tenant's IPv6 groups is the seeding disable mechanism).
//   • 'live' - NetBird Settings editor: infra fields carry a re-allocation warning (changing them on a
//     live account re-allocates every peer IP), and there is NO Disable IPv6 toggle (IPv6 on a live
//     account is managed by its ipv6_enabled_groups, not a blanket clear).
export function NetbirdCategoryCards({ nb, setNb, off, mfaSupported, variant }: {
  nb: NbFields;
  setNb: (patch: Partial<NbFields>) => void;
  off?: boolean;
  mfaSupported?: boolean;
  variant: 'defaults' | 'live';
}) {
  const isDefaults = variant === 'defaults';

  // Automatic Updates round-trip: a single string (auto_update_version) drives the method dropdown +
  // version field. '' / 'disabled' → Disabled, 'latest' → Latest Version, anything else → Custom
  // Version (the literal 'custom' means Custom is picked but no version yet). No separate state, so
  // typing never loses input - the raw string is stored as-is.
  const autoUpdVal = nb.auto_update_version;
  const updMethod: 'disabled' | 'latest' | 'custom' =
    !autoUpdVal || autoUpdVal === 'disabled' ? 'disabled' : autoUpdVal === 'latest' ? 'latest' : 'custom';
  const updVersion = updMethod === 'custom' && autoUpdVal !== 'custom' ? autoUpdVal : '';
  const setUpdMethod = (m: string) => setNb({ auto_update_version: m });
  const setUpdVersion = (v: string) => setNb({ auto_update_version: v === '' ? 'custom' : v });

  return (
    <>
      {/* Authentication */}
      <div className={CARD}>
        <CategoryHeader icon={Shield} title="Authentication"
          description={isDefaults ? 'Sign-in and session policy defaults for every new tenant.' : "This account's sign-in and session policy."} />
        <div className={ROWS}>
          <SettingRow title="Peer Approval"
            help="Require peers to be approved by an administrator."
            checked={nb.peer_approval_enabled} disabled={off} onChange={(v) => setNb({ peer_approval_enabled: v })} />
          <SettingRow title="User Approval Required"
            help="Require manual approval for new users joining via domain matching. Users will be blocked until approved."
            checked={nb.user_approval_required} disabled={off} onChange={(v) => setNb({ user_approval_required: v })} />
          <SettingRow title="Multi-Factor Authentication (MFA)"
            help={mfaSupported === false
              ? 'Not available through the configured NetBird API - the cloud MFA service is not served by this API base.'
              : 'Enable NetBird MFA if not configured in your IdP. This setting is global and applies to all users.'}
            checked={nb.mfa_enabled} disabled={off || mfaSupported === false}
            onChange={(v) => setNb(v ? { mfa_enabled: true } : { mfa_enabled: false, mfa_remember_browser: false })}>
            {nb.mfa_enabled && (
              <SubPanel disabled={off}>
                <SettingRow title="Remember Browser for MFA"
                  help="When enabled, users will have the option to remember their browser for 30 days. MFA will not be required for that browser during this period."
                  checked={nb.mfa_remember_browser} disabled={off} onChange={(v) => setNb({ mfa_remember_browser: v })} />
              </SubPanel>
            )}
          </SettingRow>
          <SettingRow title="Peer Session Expiration"
            help="Request periodic re-authentication of peers registered with SSO."
            checked={nb.peer_login_expiration_enabled} disabled={off}
            onChange={(v) => setNb(v
              ? { peer_login_expiration_enabled: true }
              : { peer_login_expiration_enabled: false, peer_inactivity_expiration_enabled: false })}>
            {nb.peer_login_expiration_enabled && (
              <SubPanel disabled={off}>
                <Field label="Session Expiration"
                  hint="Time after which every peer added with SSO login will require re-authentication.">
                  <DurationPicker seconds={nb.peer_login_expiration} disabled={off}
                    onChange={(s) => setNb({ peer_login_expiration: s })} />
                </Field>
                <div className="border-t border-nb-gray-200 dark:border-nb-gray-800 pt-1">
                  <SettingRow title="Require Login After Disconnect"
                    help="Enable to require authentication after users disconnect from management for 10 minutes."
                    checked={nb.peer_inactivity_expiration_enabled} disabled={off}
                    onChange={(v) => setNb({ peer_inactivity_expiration_enabled: v })} />
                </div>
              </SubPanel>
            )}
          </SettingRow>
        </div>
      </div>

      {/* Groups */}
      <div className={CARD}>
        <CategoryHeader icon={FolderGit2} title="Groups"
          description={isDefaults ? 'Group propagation and JWT sync defaults for new tenants.' : "This account's group propagation and JWT sync."} />
        <div className={ROWS}>
          <SettingRow title="Enable User Group Propagation"
            help="Allow group propagation from a user's auto-groups to peers, sharing membership information."
            checked={nb.groups_propagation_enabled} disabled={off} onChange={(v) => setNb({ groups_propagation_enabled: v })} />
          <SettingRow title="Enable JWT Group Sync"
            help="Extract and sync groups from JWT claims with a user's auto-groups, auto-creating groups from tokens."
            checked={nb.jwt_groups_enabled} disabled={off} onChange={(v) => setNb({ jwt_groups_enabled: v })}>
            {nb.jwt_groups_enabled && (
              <SubPanel disabled={off}>
                <Field label="JWT Claim"
                  hint="Specify the JWT claim for extracting group names, e.g., roles or groups, to add to account groups (this claim should contain a list of group names).">
                  <Input value={nb.jwt_groups_claim_name} disabled={off}
                    placeholder="e.g., roles"
                    onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                    onChange={(e) => setNb({ jwt_groups_claim_name: e.target.value.replace(/ /g, '') })} />
                </Field>
                <Field label="JWT Allow Groups"
                  hint="Limit access to NetBird for the specified group names, e.g., NetBird users. To use the groups, you need to configure them first in your IdP.">
                  <TagInput values={nb.jwt_allow_groups} disabled={off}
                    placeholder="Add a group and press Enter"
                    onChange={(v) => setNb({ jwt_allow_groups: v })} />
                </Field>
              </SubPanel>
            )}
          </SettingRow>
        </div>
      </div>

      {/* Permissions */}
      <div className={CARD}>
        <CategoryHeader icon={Lock} title="Permissions"
          description={isDefaults ? 'Dashboard access defaults for regular users in new tenants.' : "Dashboard access for this account's regular users."} />
        <div className={ROWS}>
          <SettingRow title="Restrict Regular Users"
            help="Access to the dashboard will be limited and regular users will not be able to view any peers."
            checked={nb.regular_users_view_blocked} disabled={off} onChange={(v) => setNb({ regular_users_view_blocked: v })} />
        </div>
      </div>

      {/* Networks */}
      <div className={CARD}>
        <CategoryHeader icon={Network} title="Networks"
          description={isDefaults ? 'Networking and traffic-logging defaults for new tenants.' : "This account's networking and traffic logging."} />
        <div className="border-t border-nb-gray-100 dark:border-nb-gray-800 pt-4 flex flex-col gap-4">
          {!isDefaults && (
            // Live-account infra warning: changing the DNS domain or IP ranges re-allocates peer IPs.
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[0.72rem] text-amber-700 dark:text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>Changing the DNS domain or a network range re-allocates every peer's IP address and can disrupt active connections. Leave a field unchanged to keep the current value.</span>
            </div>
          )}
          <Field label="DNS Domain"
            hint={isDefaults
              ? 'Specify a custom peer DNS domain for your network. This should not point to a valid domain to avoid overriding DNS results. Leave empty to keep the tenant\'s default.'
              : 'The custom peer DNS domain for this account. This should not point to a valid domain to avoid overriding DNS results.'}>
            <Input value={nb.dns_domain} disabled={off} placeholder="netbird.cloud"
              onChange={(e) => setNb({ dns_domain: e.target.value })} />
          </Field>
          <Field label="Network Range"
            hint={isDefaults
              ? 'Specify a custom IPv4 range for your network in CIDR format. All peer IPs will be re-allocated when changed. Leave empty to keep the tenant\'s default.'
              : 'The IPv4 range for this account in CIDR format. All peer IPs are re-allocated when changed.'}>
            <Input value={nb.network_range} disabled={off} placeholder="e.g. 100.64.0.0/16"
              onChange={(e) => setNb({ network_range: e.target.value })} />
          </Field>
          <Field label="IPv6 Network Range"
            hint={isDefaults
              ? 'Specify a custom IPv6 range for your network in CIDR format. All peer IPv6 addresses will be re-allocated when changed. Leave empty to keep the tenant\'s default.'
              : 'The IPv6 range for this account in CIDR format. All peer IPv6 addresses are re-allocated when changed.'}>
            <Input value={nb.network_range_v6} disabled={off} placeholder="e.g. fd00:1234:5678::/64"
              onChange={(e) => setNb({ network_range_v6: e.target.value })} />
          </Field>
        </div>
        <div className={ROWS}>
          {isDefaults && (
            <SettingRow title="Disable IPv6"
              help="Turn IPv6 off on tenants by clearing their IPv6 Enabled Groups (removing all groups is how IPv6 is disabled). When off, the tenant's IPv6 configuration is left untouched."
              checked={!!nb.ipv6_disable} disabled={off} onChange={(v) => setNb({ ipv6_disable: v })} />
          )}
          <SettingRow title="Routing Peer DNS Resolution"
            help="Resolve DNS for routed domains on the routing peer instead of on the client. Requires NetBird client v0.35 or higher."
            checked={nb.routing_peer_dns_resolution_enabled} disabled={off} onChange={(v) => setNb({ routing_peer_dns_resolution_enabled: v })} />
          <SettingRow title="Enable Traffic Events"
            help="Enable traffic events for all peers. This requires NetBird client v0.39 or higher."
            checked={nb.network_traffic_logs_enabled} disabled={off}
            onChange={(v) => setNb(v
              ? { network_traffic_logs_enabled: true }
              : { network_traffic_logs_enabled: false, network_traffic_packet_counter_enabled: false })}>
            {nb.network_traffic_logs_enabled && (
              <SubPanel disabled={off}>
                <SettingRow title="Enable Traffic Reporting (Kernel)"
                  help="Traffic reporting is always enabled in userspace, and this setting only applies to kernel. If enabled, network packets and their size will be counted and reported."
                  checked={nb.network_traffic_packet_counter_enabled} disabled={off}
                  onChange={(v) => setNb({ network_traffic_packet_counter_enabled: v })} />
              </SubPanel>
            )}
          </SettingRow>
        </div>
      </div>

      {/* Clients */}
      <div className={CARD}>
        <CategoryHeader icon={MonitorSmartphone} title="Clients"
          description={isDefaults ? 'Client connection defaults for new tenants.' : "This account's client connection settings."} />
        <div className="border-t border-nb-gray-100 dark:border-nb-gray-800 pt-4 flex flex-col gap-3">
          <div className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">Automatic Updates</div>
          <p className="text-[0.72rem] text-nb-gray-500 -mt-1">
            Configure how NetBird clients receive update notifications. When enabled, users will be prompted to install the selected version.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Select value={updMethod} disabled={off} onChange={(e) => setUpdMethod(e.target.value)}>
              <option value="disabled">Disabled</option>
              <option value="latest">Latest Version</option>
              <option value="custom">Custom Version</option>
            </Select>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[0.72rem] font-medium text-nb-gray-500">Version</span>
              <Input className="w-full pl-17" value={updVersion}
                disabled={off || updMethod !== 'custom'} placeholder="e.g., 0.52.2"
                onChange={(e) => setUpdVersion(e.target.value)} />
            </div>
          </div>
          <SettingRow
            title={<><AlertTriangle size={14} className="text-amber-500" />Force Automatic Updates</>}
            help="When enabled, updates are installed automatically in the background without user interaction."
            checked={nb.auto_update_always} disabled={off || updMethod === 'disabled'}
            onChange={(v) => setNb({ auto_update_always: v })} />
          {nb.auto_update_always && updMethod !== 'disabled' && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[0.72rem] text-amber-700 dark:text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>Enabling automatic updates will restart the NetBird client during updates, which can temporarily disrupt active connections. Use with caution in production environments.</span>
            </div>
          )}
        </div>
        <div className={ROWS}>
          <SettingRow title="Enable Peer Expose"
            help="When enabled, peers can expose local HTTP services accessible via a public URL."
            checked={nb.peer_expose_enabled} disabled={off} onChange={(v) => setNb({ peer_expose_enabled: v })} />
          <SettingRow title="Enable Lazy Connections"
            help="Allow to establish connections between peers only when required. This requires NetBird client v0.45 or higher. Changes will only take effect after restarting the clients."
            checked={nb.lazy_connection_enabled} disabled={off} onChange={(v) => setNb({ lazy_connection_enabled: v })} />
          {isDefaults ? (
            // Tri-state in the profile: a profile saved before this setting existed leaves it unmanaged,
            // so Apply Defaults never switches it on a tenant until the admin picks a value here.
            <div className={cn('py-3.5 last:pb-0', off && 'opacity-50')}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">Reject Hostname Collisions</div>
                  <p className="text-[0.72rem] text-nb-gray-500 mt-0.5">
                    When enabled, registering or renaming a peer to a hostname that is already in use fails instead of receiving a suffix. This applies to ephemeral peers as well. Requires NetBird v0.81 or newer; tenants on an older version are skipped.
                  </p>
                </div>
                <Select className="w-44 shrink-0" disabled={off}
                  value={nb.peer_hostname_collision_rejected == null ? 'unmanaged' : nb.peer_hostname_collision_rejected ? 'on' : 'off'}
                  onChange={(e) => setNb({ peer_hostname_collision_rejected: e.target.value === 'unmanaged' ? null : e.target.value === 'on' })}>
                  <option value="unmanaged">Keep Tenant Setting</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </Select>
              </div>
            </div>
          ) : (
            <SettingRow title="Reject Hostname Collisions"
              help={typeof nb.peer_hostname_collision_rejected === 'boolean'
                ? 'When enabled, registering or renaming a peer to a hostname that is already in use fails instead of receiving a suffix. This applies to ephemeral peers as well.'
                : 'Not available on this account - requires NetBird v0.81 or newer.'}
              checked={!!nb.peer_hostname_collision_rejected}
              disabled={off || typeof nb.peer_hostname_collision_rejected !== 'boolean'}
              onChange={(v) => setNb({ peer_hostname_collision_rejected: v })} />
          )}
        </div>
      </div>
    </>
  );
}
