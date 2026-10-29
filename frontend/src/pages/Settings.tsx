import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Send,
  Settings as SettingsGear, ChevronRight, SlidersHorizontal, Cable, Webhook as WebhookIcon, Mail,
  UserCheck, Lock, Shield, Database, Archive, Building2, Cog,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { getTenantMode } from '@/lib/api';
import { useMspStatus } from '@/lib/queries';
import { General } from '@/components/settings/General';
import { NetbirdApi } from '@/components/settings/NetbirdApi';
import { Webhook } from '@/components/settings/Webhook';
import { Telegram } from '@/components/settings/Telegram';
import { Smtp } from '@/components/settings/Smtp';
import { Approvals } from '@/components/settings/Approvals';
import { Permissions } from '@/components/settings/Permissions';
import { Security } from '@/components/settings/Security';
import { Retention } from '@/components/settings/Retention';
import { TenantDefaults } from '@/components/settings/TenantDefaults';
import { NetbirdSettings } from '@/components/settings/NetbirdSettings';
import { BackupRestore } from '@/components/settings/BackupRestore';

// Settings is pure app configuration only. The access-model and hygiene pages that used to
// live here (Network Access, Access Profiles, Posture Checks, Blocklist, Event Filtering)
// now live under Operations; old ?tab= deep links to them redirect there.
type Section = 'general' | 'netbird' | 'netbird-settings' | 'webhook' | 'telegram' | 'smtp' | 'approver' | 'permissions' | 'security' | 'retention' | 'tenant-defaults' | 'backup';
const MOVED_TO_OPERATIONS = new Set(['access', 'profiles', 'posture', 'blocklist', 'filtering']);

const TABS: { key: Section; label: string; icon: LucideIcon }[] = [
  { key: 'general', label: 'General', icon: SlidersHorizontal },
  { key: 'netbird', label: 'NetBird API', icon: Cable },
  { key: 'netbird-settings', label: 'NetBird Settings', icon: Cog },
  { key: 'webhook', label: 'Webhook', icon: WebhookIcon },
  { key: 'telegram', label: 'Telegram', icon: Send },
  { key: 'smtp', label: 'Email (SMTP)', icon: Mail },
  { key: 'approver', label: 'Approvals', icon: UserCheck },
  { key: 'permissions', label: 'Permissions', icon: Lock },
  { key: 'security', label: 'Security', icon: Shield },
  { key: 'retention', label: 'Data Retention', icon: Database },
  { key: 'tenant-defaults', label: 'Tenant Defaults', icon: Building2 },
  { key: 'backup', label: 'Backup & Restore', icon: Archive },
];
const isSection = (v: string | null): v is Section => !!v && TABS.some((t) => t.key === v);

// While MANAGING a tenant, Settings offers only the sections that are fully per-tenant: the
// tenant's own incoming webhook, its own Telegram notifications, and its own data-retention
// window. Everything else is app-wide configuration that belongs to the main account (mirrors
// the Operations tenant-mode filter).
// NetBird Settings is included: the live editor edits the CURRENT account's own NetBird settings, so
// while managing a tenant it edits THAT tenant's account (backend is ALS-aware). This is distinct from
// the main-only "Tenant Defaults" tab, which is the seed template for NEW tenants.
const TENANT_SECTIONS: Section[] = ['netbird-settings', 'webhook', 'telegram', 'retention'];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const inTenantMode = !!getTenantMode();
  // Tenant Defaults is a main-only MSP feature: hide it inside tenant mode (not in TENANT_SECTIONS)
  // and on non-MSP accounts. Only query MSP status when it could be shown (main account).
  const isMsp = useMspStatus(!inTenantMode).data?.available === true;
  const tabs = inTenantMode
    ? TABS.filter((t) => TENANT_SECTIONS.includes(t.key))
    : TABS.filter((t) => t.key !== 'tenant-defaults' || isMsp);
  const defaultSection: Section = inTenantMode ? 'webhook' : 'general';
  const validSection = (v: string | null): v is Section => isSection(v) && (!inTenantMode || TENANT_SECTIONS.includes(v as Section));
  // Deep-linkable tabs (?tab=general) so the ⌘K search can jump straight to a section.
  const [section, setSection] = useState<Section>(() => (validSection(params.get('tab')) ? (params.get('tab') as Section) : defaultSection));
  useEffect(() => {
    const t = params.get('tab');
    if (t && MOVED_TO_OPERATIONS.has(t)) { navigate(`/operations?tab=${t}`, { replace: true }); return; }
    if (validSection(t)) setSection(t);
  }, [params, navigate]);
  const selectTab = (key: Section) => {
    setSection(key);
    const next = new URLSearchParams(params);
    next.set('tab', key);
    setParams(next, { replace: true });
  };
  // Vertical tab menu + breadcrumb/title header, mirroring the NetBird dashboard's
  // Settings layout (icons on the left, "Settings › Tab" breadcrumb above the content).
  const active = tabs.find((t) => t.key === section) || tabs[0];
  const ActiveIcon = active.icon;
  return (
    <div className="flex flex-col lg:flex-row lg:items-start lg:gap-8">
      <nav className="nb-scroll flex lg:flex-col gap-1 lg:w-52 shrink-0 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0 mb-4 lg:mb-0 lg:sticky lg:top-20">
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = section === t.key;
          return (
            <button key={t.key} onClick={() => selectTab(t.key)}
              className={cn('flex items-center gap-2.5 whitespace-nowrap rounded-md px-4 py-2 text-[0.87rem] text-left transition-colors shrink-0',
                on
                  ? 'bg-nb-gray-200/70 dark:bg-nb-gray-920 text-nb-gray-900 dark:text-nb-gray-100'
                  : 'text-nb-gray-500 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900/50 hover:text-nb-gray-800 dark:hover:text-nb-gray-200')}>
              <Icon size={14} className="shrink-0" /> {t.label}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-w-0 lg:border-l lg:border-nb-gray-200 lg:dark:border-nb-gray-930 lg:pl-8">
        <div className="flex items-center gap-1.5 text-sm mb-3 text-nb-gray-400">
          <SettingsGear size={13} /> <span>Settings</span>
          <ChevronRight size={14} className="text-nb-gray-300 dark:text-nb-gray-700" />
          <ActiveIcon size={14} className="text-netbird" />
          <span className="text-nb-gray-700 dark:text-nb-gray-200">{active.label}</span>
        </div>
        <h1 className="text-2xl font-bold text-nb-gray-900 dark:text-nb-gray-50 mb-2">{active.label}</h1>
        {/* Render by `active.key` (already restricted to TENANT_SECTIONS in tenant mode) so a
            stale ?tab can never mount a main-only section while managing a tenant. */}
        {active.key === 'general' ? <General />
          : active.key === 'netbird' ? <NetbirdApi />
            : active.key === 'netbird-settings' ? <NetbirdSettings />
            : active.key === 'webhook' ? <Webhook />
            : active.key === 'telegram' ? <Telegram />
            : active.key === 'smtp' ? <Smtp />
            : active.key === 'approver' ? <Approvals />
            : active.key === 'permissions' ? <Permissions />
            : active.key === 'security' ? <Security />
            : active.key === 'retention' ? <Retention />
            : active.key === 'tenant-defaults' ? <TenantDefaults />
            : <BackupRestore />}
      </div>
    </div>
  );
}
