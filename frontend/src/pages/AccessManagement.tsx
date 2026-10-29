import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardCheck, ChevronRight, Inbox, Clock, RotateCcw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useViewer } from '@/contexts/ViewerContext';
import { getTenantMode } from '@/lib/api';
import { usePendingRequestCount } from '@/lib/queries';
import AccessRequests from '@/pages/AccessRequests';
import TemporaryAccess from '@/pages/TemporaryAccess';
import AccessReview from '@/pages/AccessReview';

// One roof for the access lifecycle, mirroring the Settings layout: a request is
// APPROVED into a temporary grant, grants are the STANDING access, and the review
// re-certifies what stays. Sections are filtered per viewer (approvers who aren't
// admins see only Requests; temp.manage holders only Temporary Access).
// NOTE: the hub uses ?section= - the inner pages already own ?tab= for their own
// sub-tabs (Grants/Recurring, Requests/History), so the two never collide.
type Section = 'requests' | 'grants' | 'review';

export default function AccessManagement() {
  const { restricted, canApprove, can } = useViewer();
  // Access requests are a MAIN-only feature (requesters are main users); while managing a tenant
  // only the converted per-tenant sections show - Temporary Access (grants) + Access Review.
  const inTenantMode = !!getTenantMode();
  const pending = usePendingRequestCount(canApprove && !inTenantMode).data?.count || 0;

  const TABS = useMemo(() => ([
    ...(canApprove && !inTenantMode ? [{ key: 'requests' as Section, label: 'Access Requests', icon: Inbox }] : []),
    ...((!restricted || can('temp.manage')) ? [{ key: 'grants' as Section, label: 'Temporary Access', icon: Clock }] : []),
    ...(!restricted ? [{ key: 'review' as Section, label: 'Access Review', icon: RotateCcw }] : []),
  ] as { key: Section; label: string; icon: LucideIcon }[]), [restricted, canApprove, can, inTenantMode]);

  const [params, setParams] = useSearchParams();
  const isSection = (v: string | null): v is Section => !!v && TABS.some((t) => t.key === v);
  const [section, setSection] = useState<Section>(() => (isSection(params.get('section')) ? (params.get('section') as Section) : (TABS[0]?.key || 'requests')));
  useEffect(() => { const t = params.get('section'); if (isSection(t)) setSection(t); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectTab = (key: Section) => {
    setSection(key);
    const next = new URLSearchParams(params);
    next.set('section', key);
    next.delete('tab'); // the inner pages' own sub-tab param - stale values must not leak across sections
    setParams(next, { replace: true });
  };

  const active = TABS.find((t) => t.key === section) || TABS[0];
  if (!active) return null; // route guard should prevent this
  const ActiveIcon = active.icon;
  return (
    <div className="flex flex-col lg:flex-row lg:items-start lg:gap-8">
      <nav className="nb-scroll flex lg:flex-col gap-1 lg:w-52 shrink-0 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0 mb-4 lg:mb-0 lg:sticky lg:top-20">
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = active.key === t.key;
          return (
            <button key={t.key} onClick={() => selectTab(t.key)}
              className={cn('flex items-center gap-2.5 whitespace-nowrap rounded-md px-4 py-2 text-[0.87rem] text-left transition-colors shrink-0',
                on
                  ? 'bg-nb-gray-200/70 dark:bg-nb-gray-920 text-nb-gray-900 dark:text-nb-gray-100'
                  : 'text-nb-gray-500 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900/50 hover:text-nb-gray-800 dark:hover:text-nb-gray-200')}>
              <Icon size={14} className="shrink-0" /> {t.label}
              {t.key === 'requests' && pending > 0 && (
                <span className="ml-auto inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-netbird text-white text-[0.7rem] font-medium">{pending}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-w-0 lg:border-l lg:border-nb-gray-200 lg:dark:border-nb-gray-930 lg:pl-8">
        <div className="flex items-center gap-1.5 text-sm mb-3 text-nb-gray-400">
          <ClipboardCheck size={13} /> <span>Access Management</span>
          <ChevronRight size={14} className="text-nb-gray-300 dark:text-nb-gray-700" />
          <ActiveIcon size={14} className="text-netbird" />
          <span className="text-nb-gray-700 dark:text-nb-gray-200">{active.label}</span>
        </div>
        <h1 className="text-2xl font-bold text-nb-gray-900 dark:text-nb-gray-50 mb-2">{active.label}</h1>
        {active.key === 'requests' ? <AccessRequests />
          : active.key === 'grants' ? <TemporaryAccess />
            : <AccessReview />}
      </div>
    </div>
  );
}
