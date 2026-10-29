import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getTenantMode } from '@/lib/api';
import { useRetention, useSystemHealth } from '@/lib/queries';
import { useSaveRetention } from '@/lib/mutations';
import { formatMaybeDate } from '@/lib/logfmt';
import { Button, Checkbox, Field, FieldHint, Input, LoadingState } from '@/components/ui';

// Below this the UI shows a compliance warning (~24 months). Advisory only - the
// admin's choice always wins (matches RETENTION_WARN_DAYS on the server).
const WARN_DAYS = 730;

function fmtCount(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

// ─── Data Retention - how long traffic + NetBird events are kept (admin's call) ───
// Fully per-account: the endpoint is tenant-aware, so while managing a tenant this edits THAT
// tenant's window. The stored-volume card uses the main-only System Health, so it is main-only.
export function Retention() {
  const inTenantMode = !!getTenantMode();
  const { data, isLoading } = useRetention();
  const health = useSystemHealth(!inTenantMode).data;
  const save = useSaveRetention();
  const [days, setDays] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (data) setDays(data.days || 0); }, [data]);

  const onSave = async () => {
    if (days === null) return;
    setError('');
    try {
      await save.mutateAsync(days);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed to save'); }
  };

  if (isLoading || days === null) return <LoadingState />;
  const enabled = days > 0;

  return (
    <div className="max-w-2xl">
      <p className="text-nb-gray-500 text-sm mb-5">
        How long <b>traffic events</b> and <b>NetBird events</b> are kept. When enabled, a daily job
        purges everything older than the window. Disabled = data is kept <b>forever</b>.
        The app's own audit trail and IP history are <b>never</b> purged.
      </p>

      <div className="flex flex-col gap-4">
        {/* Current data volume - decide with the real numbers in front of you. */}
        {health && (
          <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4 text-sm">
            <div className="font-semibold text-nb-gray-900 dark:text-nb-gray-50 mb-1.5">Currently Stored</div>
            <p className="text-nb-gray-500">
              Traffic events: <b className="text-nb-gray-700 dark:text-nb-gray-200">~{fmtCount(health.db.events.rows)}</b>
              {health.db.events.oldest && <> (oldest {formatMaybeDate(health.db.events.oldest)})</>}
              {' '}· NetBird events: <b className="text-nb-gray-700 dark:text-nb-gray-200">~{fmtCount(health.db.adminEvents.rows)}</b>
              {health.db.adminEvents.oldest && <> (oldest {formatMaybeDate(health.db.adminEvents.oldest)})</>}
            </p>
            {health.retention.last && !health.retention.last.error && (
              <p className="mt-1 text-nb-gray-500">
                Last purge {formatMaybeDate(health.retention.last.at)} - {(health.retention.last.events || 0) + (health.retention.last.adminEvents || 0)} rows removed.
              </p>
            )}
            {health.retention.last?.error && (
              <p className="mt-1 text-red-500">Last purge failed: {health.retention.last.error}</p>
            )}
          </div>
        )}

        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4 flex flex-col gap-4">
          <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
            <Checkbox checked={enabled}
              onChange={(e) => setDays(e.target.checked ? (days || WARN_DAYS) : 0)} />
            <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200">Enable Retention Purge</span>
          </label>
          {enabled && (
            <>
              <Field label="Keep Events For">
                <div className="flex items-center gap-2">
                  <Input type="number" min={1} max={3650} value={days} className="w-32"
                    onChange={(e) => setDays(parseInt(e.target.value, 10) || 0)} />
                  <span className="text-sm text-nb-gray-500">days</span>
                </div>
                <FieldHint>
                  {days >= 365
                    ? `≈ ${(days / 365).toFixed(1)} year(s). `
                    : days >= 30 ? `≈ ${Math.round(days / 30)} month(s). ` : ''}
                  Events older than this are deleted daily, in batches. Maximum 3650 (10 years).
                </FieldHint>
              </Field>
              {days > 0 && days < WARN_DAYS && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[0.82rem] text-amber-600 dark:text-amber-400">
                  <AlertTriangle size={14} className="inline mr-1.5 -mt-0.5" />
                  Below 24 months ({WARN_DAYS} days). If your compliance policy requires keeping logs for
                  at least 24 months, raise this - purged events cannot be recovered.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
          {error && <span className="text-sm text-red-500">{error}</span>}
        </div>
      </div>
    </div>
  );
}
