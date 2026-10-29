import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Wrench, ChevronRight, HeartPulse, Sparkles, Workflow, Layers, ListChecks, Ban, Filter as FilterIcon, Network as NetworkIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { getTenantMode } from '@/lib/api';
import { SystemHealthTab } from '@/components/admin/SystemHealth';
import { NetworkAccess } from '@/components/settings/NetworkAccess';
import { AccessProfiles } from '@/components/settings/AccessProfiles';
import { PostureChecks } from '@/components/settings/PostureChecks';
import { Blocklist } from '@/components/settings/Blocklist';
import { EventFiltering } from '@/components/settings/EventFiltering';
import Cleanup from '@/pages/Cleanup';
import Automation from '@/pages/Automation';

// Everything an admin MANAGES that isn't app configuration - monitoring, the network's
// access model, guardrails and data hygiene - under one Settings-style hub. Settings is
// kept to pure configuration (connections, notifications, permissions, backup).
// Section keys match the old Settings tab keys so /settings?tab=X deep links redirect cleanly.
type Section = 'health' | 'automation' | 'profiles' | 'posture' | 'access' | 'blocklist' | 'filtering' | 'cleanup';

const TABS: { key: Section; label: string; icon: LucideIcon }[] = [
  { key: 'health', label: 'System Health', icon: HeartPulse },
  { key: 'automation', label: 'Automation', icon: Workflow },
  { key: 'profiles', label: 'Access Profiles', icon: Layers },
  { key: 'posture', label: 'Posture Checks', icon: ListChecks },
  { key: 'access', label: 'Network Access', icon: NetworkIcon },
  { key: 'blocklist', label: 'Blocklist', icon: Ban },
  { key: 'filtering', label: 'Event Filtering', icon: FilterIcon },
  { key: 'cleanup', label: 'Cleanup', icon: Sparkles },
];
const isSection = (v: string | null): v is Section => !!v && TABS.some((t) => t.key === v);

// While MANAGING a tenant, only the sections that operate on the TENANT's own account are
// offered. System Health and Event Filtering are now per-account (the backend scopes both to
// the active tenant), so they're offered too; Automation is per-tenant as well.
const TENANT_SECTIONS: Section[] = ['health', 'automation', 'cleanup', 'profiles', 'posture', 'access', 'blocklist', 'filtering'];

export default function Operations() {
  const inTenantMode = !!getTenantMode();
  const tabs = inTenantMode ? TABS.filter((t) => TENANT_SECTIONS.includes(t.key)) : TABS;
  // Land on the FIRST offered tab. In tenant mode that's System Health (TABS order); on main
  // it's System Health too (TABS[0]).
  const defaultSection: Section = tabs[0].key;
  const validSection = (v: string | null): v is Section => isSection(v) && (!inTenantMode || TENANT_SECTIONS.includes(v as Section));
  const [params, setParams] = useSearchParams();
  // Deep-linkable sections (?tab=cleanup); old standalone routes redirect here.
  const [section, setSection] = useState<Section>(() => (validSection(params.get('tab')) ? (params.get('tab') as Section) : defaultSection));
  useEffect(() => { const t = params.get('tab'); if (validSection(t)) setSection(t); }, [params]);
  const selectTab = (key: Section) => {
    setSection(key);
    const next = new URLSearchParams(params);
    next.set('tab', key);
    setParams(next, { replace: true });
  };
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
          <Wrench size={13} /> <span>Operations</span>
          <ChevronRight size={14} className="text-nb-gray-300 dark:text-nb-gray-700" />
          <ActiveIcon size={14} className="text-netbird" />
          <span className="text-nb-gray-700 dark:text-nb-gray-200">{active.label}</span>
        </div>
        <h1 className="text-2xl font-bold text-nb-gray-900 dark:text-nb-gray-50 mb-2">{active.label}</h1>
        {/* In tenant mode `active` is already restricted to TENANT_SECTIONS - render by IT,
            not by raw state, so a stale ?tab can never mount a main-only section. */}
        {active.key === 'health' ? <SystemHealthTab />
          : active.key === 'automation' ? <Automation />
            : active.key === 'profiles' ? <AccessProfiles />
              : active.key === 'posture' ? <PostureChecks />
                : active.key === 'access' ? <NetworkAccess />
                  : active.key === 'blocklist' ? <Blocklist />
                    : active.key === 'filtering' ? <EventFiltering />
                      : <Cleanup />}
      </div>
    </div>
  );
}
