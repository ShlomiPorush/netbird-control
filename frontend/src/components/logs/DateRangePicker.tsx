import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar as CalendarIcon } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { cn } from '@/lib/cn';
import { registerPopup } from '@/lib/popupBus';
import { Calendar } from '@/components/ui/Calendar';

const sod = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const eod = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const sameDay = (a?: Date, b?: Date) => !!a && !!b && a.toDateString() === b.toDateString();

/** The Activity page's DEFAULT window - grouped log views aggregate their whole range, so an
 * unbounded default meant scanning the entire tenant history on every page load. Last 7 days
 * keeps page loads index-bounded; All Time remains one click away in the picker. */
export function defaultLogRange(): { from: Date; to: Date } {
  return quickRanges().last7Days;
}

function quickRanges(): Record<string, { from: Date; to: Date }> {
  const now = new Date();
  const sub = (days: number) => { const x = new Date(now); x.setDate(x.getDate() - days); return sod(x); };
  const lastMonth = () => { const x = new Date(now); x.setMonth(x.getMonth() - 1); return sod(x); };
  return {
    today: { from: sod(now), to: eod(now) },
    yesterday: { from: sub(1), to: eod(sub(1)) },
    last7Days: { from: sub(7), to: eod(now) },
    last14Days: { from: sub(14), to: eod(now) },
    lastMonth: { from: lastMonth(), to: eod(now) },
  };
}

function toDateInput(d?: Date) { return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''; }

export function DateRangePicker({ value, onChange }: { value?: DateRange; onChange: (r?: DateRange) => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0, above: false, mobile: false });

  // Only one popup panel open app-wide (see lib/popupBus).
  useEffect(() => { if (open) return registerPopup(() => setOpen(false)); }, [open]);

  const ranges = useMemo(quickRanges, []);
  const isActive = (r: { from: Date; to: Date }) => sameDay(value?.from, r.from) && sameDay(value?.to, r.to);

  const label = useMemo(() => {
    if (!value?.from) return 'All Time';
    if (isActive(ranges.today)) return 'Today';
    if (isActive(ranges.yesterday)) return 'Yesterday';
    if (isActive(ranges.last7Days)) return 'Last 7 Days';
    if (isActive(ranges.last14Days)) return 'Last 14 Days';
    if (isActive(ranges.lastMonth)) return 'Last Month';
    const fmt = (d?: Date) => d?.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
    return value.to ? `${fmt(value.from)} - ${fmt(value.to)}` : fmt(value.from);
  }, [value, ranges]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current; if (!el) return;
      const r = el.getBoundingClientRect();
      const mobile = window.innerWidth < 640;
      // On phones use a single-month calendar that fits the viewport; never push the panel
      // off the left edge (the old hard-coded 600px width produced a negative left on mobile).
      const W = mobile ? Math.min(window.innerWidth - 16, 360) : 600, H = 440;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
      const above = window.innerHeight - r.bottom < H && r.top > window.innerHeight - r.bottom;
      setPos({ left, top: above ? r.top : r.bottom, above, mobile });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const onSelect = (r?: DateRange) => {
    if (!r?.from) { onChange(undefined); return; }
    onChange({ from: sod(r.from), to: r.to ? eod(r.to) : undefined });
  };

  const setInput = (which: 'from' | 'to', v: string) => {
    if (!v) return;
    const d = new Date(v + 'T00:00:00');
    const next: DateRange = { from: value?.from, to: value?.to };
    if (which === 'from') next.from = sod(d); else next.to = eod(d);
    onChange(next.from || next.to ? next : undefined);
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 h-[42px] px-4 rounded-md border text-sm font-medium whitespace-nowrap transition-colors shadow-xs bg-white border-gray-200 text-gray-900 hover:bg-gray-100 dark:bg-nb-gray-920 dark:text-nb-gray-300 dark:border-nb-gray-700/40 dark:hover:text-white dark:hover:bg-nb-gray-910"
      >
        <CalendarIcon size={16} className="shrink-0" />
        {label}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', left: pos.left, top: pos.top }}
          className={cn('z-1100', pos.above ? '-translate-y-full -mt-2' : 'mt-2')}
        >
          <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-2xl max-w-[calc(100vw-16px)] overflow-x-auto">
            {/* Quick ranges. `w-0 min-w-full` keeps this (wide) row from stretching the panel:
                the calendar below defines the panel width, and this row wraps within it. */}
            <div className="w-0 min-w-full px-3 py-2 flex flex-wrap gap-2 border-b border-nb-gray-100 dark:border-nb-gray-800 items-center justify-between">
              <QuickBtn label={<><CalendarIcon size={14} /> All Time</>} active={!value?.from} onClick={() => { onChange(undefined); setOpen(false); }} />
              <div className="flex gap-2 flex-wrap">
                <QuickBtn label="Last Month" active={isActive(ranges.lastMonth)} onClick={() => { onChange(ranges.lastMonth); setOpen(false); }} />
                <QuickBtn label="Last 14 Days" active={isActive(ranges.last14Days)} onClick={() => { onChange(ranges.last14Days); setOpen(false); }} />
                <QuickBtn label="Yesterday" active={isActive(ranges.yesterday)} onClick={() => { onChange(ranges.yesterday); setOpen(false); }} />
                <QuickBtn label="Today" active={isActive(ranges.today)} onClick={() => { onChange(ranges.today); setOpen(false); }} />
              </div>
            </div>

            <Calendar mode="range" numberOfMonths={pos.mobile ? 1 : 2} defaultMonth={value?.from} selected={value} onSelect={onSelect} />

            {/* From / To inputs, side by side. `min-w-0` lets each date input shrink below its
                intrinsic dd/mm/yyyy width so the pair always fits the panel instead of overflowing. */}
            <div className="w-0 min-w-full flex items-center gap-2 px-3 py-3 border-t border-nb-gray-100 dark:border-nb-gray-800">
              <input type="date" value={toDateInput(value?.from)} onChange={(e) => setInput('from', e.target.value)}
                className="h-9 flex-1 min-w-0 rounded-md border px-2.5 text-sm bg-white border-nb-gray-200 dark:bg-nb-gray-900 dark:border-nb-gray-700 dark:text-nb-gray-100 outline-hidden focus:border-netbird/60" />
              <span className="shrink-0 text-nb-gray-400">–</span>
              <input type="date" value={toDateInput(value?.to)} onChange={(e) => setInput('to', e.target.value)}
                className="h-9 flex-1 min-w-0 rounded-md border px-2.5 text-sm bg-white border-nb-gray-200 dark:bg-nb-gray-900 dark:border-nb-gray-700 dark:text-nb-gray-100 outline-hidden focus:border-netbird/60" />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function QuickBtn({ label, active, onClick }: { label: React.ReactNode; active?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'py-1.5 leading-none px-2.5 rounded-md text-center text-xs transition-all inline-flex items-center gap-2',
        active ? 'bg-nb-gray-200 dark:bg-nb-gray-800 text-nb-gray-900 dark:text-white'
               : 'bg-transparent text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900',
      )}
    >
      {label}
    </button>
  );
}
