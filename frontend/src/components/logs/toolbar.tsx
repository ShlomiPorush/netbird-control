import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Filter as FilterIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { registerPopup } from '@/lib/popupBus';

const secondaryBtn =
  'inline-flex items-center gap-2 h-[42px] px-4 rounded-md border text-sm font-medium whitespace-nowrap transition-colors shadow-sm ' +
  'bg-white border-gray-200 text-gray-900 hover:bg-gray-100 ' +
  'dark:bg-nb-gray-920 dark:text-nb-gray-400 dark:border-nb-gray-700/40 dark:hover:text-white dark:hover:bg-nb-gray-910';

/** All / P2P / Routed segmented control (active = white "tertiary" variant). */
export function Segmented({ options, value, onChange }: {
  options: { value: string; label: string }[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex h-[42px] rounded-md overflow-hidden border border-gray-200 dark:border-nb-gray-700/40 shadow-sm">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'px-4 h-full text-sm font-medium transition-colors border-r last:border-r-0 border-gray-200 dark:border-nb-gray-700/40',
              active
                ? 'bg-white text-gray-800 dark:bg-white dark:text-gray-800'
                : 'bg-white text-gray-900 hover:bg-gray-100 dark:bg-nb-gray-920 dark:text-nb-gray-400 dark:hover:text-white dark:hover:bg-nb-gray-910',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // A separately-portaled menu lives OUTSIDE `ref`; track it so an outside-click check that
  // also consults `menuRef` doesn't treat a click on the menu as "outside" (which would close
  // it on mousedown before the option's click lands). Null for anchored menus - a no-op there.
  const menuRef = useRef<HTMLDivElement>(null);
  // Only one popup panel open app-wide (see lib/popupBus).
  useEffect(() => { if (open) return registerPopup(() => setOpen(false)); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return { open, setOpen, ref, menuRef };
}

/** Button-triggered single-select dropdown (Users, rows-per-page).
 *  `portal` renders the menu in a fixed-position body portal so an `overflow` ancestor (e.g. a
 *  modal's scroll container) can't clip it. Anchored (default) behaviour is unchanged. */
export function ToolbarMenu({ icon, label, options, value, onChange, align = 'start', width = 210, portal = false }: {
  icon: ReactNode; label: ReactNode; options: { value: string; label: string }[];
  value: string; onChange: (v: string) => void; align?: 'start' | 'end'; width?: number; portal?: boolean;
}) {
  const { open, setOpen, ref, menuRef } = usePopover();
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  // Portal only: measure the trigger and pin the menu below it; close on any scroll (capture, so
  // scrolling the modal body counts) so it never floats away from the button.
  useEffect(() => {
    if (!open || !portal) return;
    const measure = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.max(width, r.width);
      const left = align === 'end' ? r.right - w : r.left;
      setPos({ left: Math.max(8, Math.min(left, window.innerWidth - w - 8)), top: r.bottom + 6, width: w });
    };
    measure();
    const onScroll = () => setOpen(false);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', onScroll, true); };
  }, [open, portal, align, width, setOpen]);

  const optionButtons = options.map((o) => {
    const active = o.value === value;
    return (
      <button
        key={o.value}
        onClick={() => { onChange(o.value); setOpen(false); }}
        className={cn(
          'flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-left transition-colors',
          active ? 'text-nb-gray-900 dark:text-white' : 'text-nb-gray-600 dark:text-nb-gray-400 hover:text-nb-gray-900 dark:hover:text-white hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800',
        )}
      >
        <Check size={15} className={cn('shrink-0 text-netbird', active ? 'opacity-100' : 'opacity-0')} />
        <span className="truncate">{o.label}</span>
      </button>
    );
  });

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className={cn(secondaryBtn, 'justify-between')} style={{ minWidth: width }}>
        <span className="inline-flex items-center gap-2 min-w-0">
          <span className="text-nb-gray-500 dark:text-nb-gray-300 shrink-0">{icon}</span>
          <span className="truncate">{label}</span>
        </span>
        <ChevronDown size={16} className="opacity-50 shrink-0" />
      </button>
      {open && !portal && (
        <div
          style={{ minWidth: width }}
          className={cn('nb-scroll absolute top-full mt-1.5 z-50 max-h-72 overflow-y-auto rounded-md border border-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1', align === 'end' ? 'right-0' : 'left-0')}
        >
          {optionButtons}
        </div>
      )}
      {open && portal && pos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', left: pos.left, top: pos.top, minWidth: pos.width }}
          className="nb-scroll z-[1100] max-h-72 overflow-y-auto rounded-md border border-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1"
        >
          {optionButtons}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** "Filter" button consolidating protocol / source / destination, like NetBird. */
export function FilterPopover({
  protocol, onProtocol, source, onSource, destination, onDestination, onClear,
}: {
  protocol: string; onProtocol: (v: string) => void;
  source: string; onSource: (v: string) => void;
  destination: string; onDestination: (v: string) => void;
  onClear: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const count = (protocol ? 1 : 0) + (source ? 1 : 0) + (destination ? 1 : 0);
  const fieldCls = 'h-9 w-full rounded-md border px-3 text-sm outline-none bg-white border-gray-200 dark:bg-nb-gray-900 dark:border-nb-gray-700 dark:text-nb-gray-100 focus:border-netbird/60';
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className={secondaryBtn}>
        <FilterIcon size={16} className="text-nb-gray-500 dark:text-nb-gray-300" />
        Filter
        {count > 0 && <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-netbird text-white text-[0.65rem] font-bold">{count}</span>}
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1.5 z-50 w-64 rounded-md border border-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-3 space-y-3">
          <div className="space-y-1.5">
            <span className="text-[0.72rem] font-semibold uppercase tracking-wide text-nb-gray-500">Protocol</span>
            <select value={protocol} onChange={(e) => onProtocol(e.target.value)} className={fieldCls + ' cursor-pointer'}>
              <option value="">All Protocols</option>
              <option value="6">TCP</option>
              <option value="17">UDP</option>
              <option value="1">ICMP</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <span className="text-[0.72rem] font-semibold uppercase tracking-wide text-nb-gray-500">Source</span>
            <input value={source} onChange={(e) => onSource(e.target.value)} placeholder="Source IP / peer…" autoComplete="off" className={fieldCls} />
          </div>
          <div className="space-y-1.5">
            <span className="text-[0.72rem] font-semibold uppercase tracking-wide text-nb-gray-500">Destination</span>
            <input value={destination} onChange={(e) => onDestination(e.target.value)} placeholder="Destination IP / peer…" autoComplete="off" className={fieldCls} />
          </div>
          {count > 0 && (
            <button onClick={() => { onClear(); }} className="text-[0.8rem] text-netbird hover:underline">Clear filters</button>
          )}
        </div>
      )}
    </div>
  );
}
