import { cn } from '@/lib/cn';
import { Input, SelectMenu, FieldHint } from '@/components/ui';
import { formatMaybeDate } from '@/lib/logfmt';

// Shared "in N (presets/custom) OR until an exact time" duration control, used by Temporary
// Access, Access Requests, and the approval modal.
export const UNIT_MIN: Record<'m' | 'h' | 'd', number> = { m: 1, h: 60, d: 1440 };
const PRESETS = [{ label: '1h', m: 60 }, { label: '8h', m: 480 }, { label: '1 day', m: 1440 }, { label: '1 week', m: 10080 }];

export type DurationState = { mode: 'in' | 'until'; minutes: number; until: string };
export const DEFAULT_DURATION: DurationState = { mode: 'in', minutes: 480, until: '' };
export function durationFromMinutes(min: number): DurationState {
  return { mode: 'in', minutes: min && min >= 1 ? min : 480, until: '' };
}

export function durationPayload(d: DurationState): { durationMinutes?: number; expiresAt?: string } | null {
  if (d.mode === 'until') {
    if (!d.until) return null;
    const t = new Date(d.until);
    return (Number.isNaN(t.getTime()) || t.getTime() <= Date.now()) ? null : { expiresAt: t.toISOString() };
  }
  return d.minutes >= 1 ? { durationMinutes: Math.round(d.minutes) } : null;
}
function splitMin(min: number): { value: number; unit: 'm' | 'h' | 'd' } {
  if (min && min % 1440 === 0) return { value: min / 1440, unit: 'd' };
  if (min && min % 60 === 0) return { value: min / 60, unit: 'h' };
  return { value: min || 0, unit: 'm' };
}

export function DurationControl({ value, onChange }: { value: DurationState; onChange: (d: DurationState) => void }) {
  const set = (patch: Partial<DurationState>) => onChange({ ...value, ...patch });
  const sp = splitMin(value.minutes);
  const seg = (mode: 'in' | 'until', label: string) => (
    <button type="button" onClick={() => set({ mode })}
      className={cn('flex-1 h-9 text-sm rounded-md transition-colors',
        value.mode === mode ? 'bg-white dark:bg-nb-gray-900 text-netbird shadow-xs' : 'text-nb-gray-500 hover:text-nb-gray-800 dark:hover:text-nb-gray-200')}>
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="inline-flex rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-0.5 bg-nb-gray-100/50 dark:bg-nb-gray-920">
        {seg('in', 'For a duration')}{seg('until', 'Until a time')}
      </div>
      {value.mode === 'in' ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.m} type="button" onClick={() => set({ minutes: p.m })}
                className={cn('px-3 h-8 rounded-md border text-[0.82rem] transition-colors',
                  value.minutes === p.m ? 'border-netbird bg-netbird/10 text-netbird' : 'border-nb-gray-200 dark:border-nb-gray-800 text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900')}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input type="number" min={1} value={sp.value} onChange={(e) => set({ minutes: (parseInt(e.target.value, 10) || 0) * UNIT_MIN[sp.unit] })} className="w-24" />
            <div className="w-36">
              <SelectMenu
                searchable={false}
                value={sp.unit}
                onChange={(v) => set({ minutes: sp.value * UNIT_MIN[v as 'm' | 'h' | 'd'] })}
                options={[{ value: 'm', label: 'Minutes' }, { value: 'h', label: 'Hours' }, { value: 'd', label: 'Days' }]}
              />
            </div>
          </div>
          <FieldHint>Expires around {formatMaybeDate(new Date(Date.now() + value.minutes * 60000).toISOString())}.</FieldHint>
        </>
      ) : (
        <Input type="datetime-local" value={value.until} onChange={(e) => set({ until: e.target.value })} />
      )}
    </div>
  );
}
