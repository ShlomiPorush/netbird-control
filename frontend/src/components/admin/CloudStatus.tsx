import { AlertTriangle, CloudOff, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useNetbirdCloudStatus } from '@/lib/queries';
import { formatTimestamp } from '@/lib/logfmt';
import type { CloudStatusIncident, CloudStatusIndicator } from '@/lib/types';
import { Badge, Card } from '@/components/ui';

type Severity = 'ok' | 'warn' | 'bad' | 'unknown';

const SEVERITY: Record<CloudStatusIndicator, Severity> = {
  none: 'ok', minor: 'warn', maintenance: 'warn', major: 'bad', critical: 'bad', unknown: 'unknown',
};

const COMPONENT_STATUS: Record<string, { label: string; severity: Severity }> = {
  operational: { label: 'Operational', severity: 'ok' },
  degraded_performance: { label: 'Degraded', severity: 'warn' },
  under_maintenance: { label: 'Maintenance', severity: 'warn' },
  partial_outage: { label: 'Partial Outage', severity: 'bad' },
  major_outage: { label: 'Major Outage', severity: 'bad' },
  full_outage: { label: 'Full Outage', severity: 'bad' },
};

const DOT: Record<Severity, string> = {
  ok: 'bg-green-500', warn: 'bg-amber-500', bad: 'bg-red-500', unknown: 'bg-nb-gray-400',
};

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function componentStatus(status: string) {
  return COMPONENT_STATUS[status] || { label: titleCase(status || 'unknown'), severity: 'unknown' as Severity };
}

const isImpaired = (severity: Severity) => severity === 'warn' || severity === 'bad';

function ExternalA({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1 text-netbird hover:underline', className)}>
      {children} <ExternalLink size={12} />
    </a>
  );
}

function IncidentRow({ incident }: { incident: CloudStatusIncident }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-nb-gray-900 dark:text-nb-gray-50">{incident.name}</span>
        {incident.status && <Badge tone={incident.impact === 'major' || incident.impact === 'critical' ? 'red' : 'orange'}>{titleCase(incident.status)}</Badge>}
      </div>
      {incident.latestUpdate && <p className="mt-0.5 text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300 line-clamp-2">{incident.latestUpdate}</p>}
      <div className="mt-0.5 text-[0.74rem] text-nb-gray-500">
        {incident.startedAt && <>Started {formatTimestamp(incident.startedAt)} · </>}
        <ExternalA href={incident.url}>Details</ExternalA>
      </div>
    </div>
  );
}

function QuietStatusLine({ known, className }: { known: boolean; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 px-4 py-2.5 text-sm', className)}>
      <span className="flex min-w-0 items-start gap-2">
        <span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', known ? DOT.ok : DOT.unknown)} />
        <span className="min-w-0 text-nb-gray-800 dark:text-nb-gray-100">
          {known ? 'NetBird Cloud: No Known Issues' : 'NetBird Cloud: Status Unknown (the status page could not be read)'}
        </span>
      </span>
      <ExternalA href="https://status.netbird.io/" className="text-[0.8rem]">status.netbird.io</ExternalA>
    </div>
  );
}

export function CloudStatusBanner({ className, showQuiet = false }: { className?: string; showQuiet?: boolean }) {
  const { data } = useNetbirdCloudStatus();
  if (!data?.enabled) return null;
  const s = data.summary;
  const affected = s ? s.components.filter((c) => isImpaired(componentStatus(c.status).severity)) : [];
  const overallImpaired = !!s && isImpaired(SEVERITY[s.indicator]);
  if (!s || (!s.incidents.length && !affected.length && !overallImpaired)) {
    return showQuiet ? <QuietStatusLine known={!!s} className={className} /> : null;
  }
  const bad = SEVERITY[s.indicator] === 'bad' || affected.some((c) => componentStatus(c.status).severity === 'bad');
  return (
    <Card className={cn('p-4 md:p-5 border-l-4', bad ? 'border-l-red-500' : 'border-l-amber-500', className)}>
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className={cn('shrink-0 mt-0.5', bad ? 'text-red-500' : 'text-amber-500')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h2 className="text-base font-bold tracking-tight text-nb-gray-900 dark:text-nb-gray-50">
              NetBird Cloud: {(overallImpaired && s.description) || 'Service Issue'}
            </h2>
            <ExternalA href={s.pageUrl} className="text-sm">status.netbird.io</ExternalA>
          </div>
          {affected.length > 0 && (
            <p className="mt-0.5 text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">
              Affected: {affected.map((c) => `${c.name} (${componentStatus(c.status).label})`).join(', ')}
            </p>
          )}
          {s.incidents.length > 0 && (
            <div className="mt-3 flex flex-col gap-3">
              {s.incidents.map((i) => <IncidentRow key={i.id} incident={i} />)}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export function CloudStatusSection() {
  const { data, isLoading } = useNetbirdCloudStatus();
  if (isLoading || !data?.enabled) return null;
  const s = data.summary;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 mb-2">
        <h3 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50">NetBird Cloud</h3>
        <span className="text-[0.76rem] text-nb-gray-500">
          checked {formatTimestamp(data.checkedAt)} · <ExternalA href="https://status.netbird.io/">status.netbird.io</ExternalA>
        </span>
      </div>
      {!s ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-white dark:bg-nb-gray-950 p-3.5 text-sm text-amber-600 dark:text-amber-400">
          <CloudOff size={16} className="shrink-0" />
          <span className="min-w-0">Status Unknown - the app could not read status.netbird.io{data.error ? `: ${data.error}` : ''}.</span>
        </div>
      ) : (
        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
          <div className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', DOT[SEVERITY[s.indicator]])} />
            <span className="text-lg font-semibold text-nb-gray-900 dark:text-nb-gray-50">{s.description || titleCase(s.indicator)}</span>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {s.components.map((c) => {
              const st = componentStatus(c.status);
              return (
                <div key={c.name} className="flex items-center gap-2 min-w-0 text-sm">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', DOT[st.severity])} />
                  <span className="min-w-0 truncate text-nb-gray-800 dark:text-nb-gray-100" title={c.name}>{c.name}</span>
                  {st.severity !== 'ok' && <span className={cn('shrink-0 text-[0.74rem]', st.severity === 'bad' ? 'text-red-500' : 'text-amber-600 dark:text-amber-400')}>{st.label}</span>}
                </div>
              );
            })}
          </div>
          {s.incidents.length > 0 && (
            <div className="mt-4 pt-3 border-t border-nb-gray-100 dark:border-nb-gray-900 flex flex-col gap-3">
              {s.incidents.map((i) => <IncidentRow key={i.id} incident={i} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
