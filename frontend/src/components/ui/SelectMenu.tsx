import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, Check, SearchIcon, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { registerPopup } from '@/lib/popupBus';

export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  subtitle?: string;
  /** Renders as a non-selectable group separator (e.g. "My Devices"). Hidden while searching. */
  heading?: boolean;
}

// NetBird-styled single-select dropdown, matching GroupMultiSelect's look (trigger box, search
// row with the ⏎ badge, and command-item rows with a Radix-style checkbox). A drop-in for the
// native <Select>. Portalled so it never clips inside modals / scroll areas; auto-adds the
// search box when there are many options.
export function SelectMenu({
  options, value, onChange, placeholder = 'Select...', searchable, disabled,
  searchPlaceholder = 'Search...', className,
}: {
  options: SelectOption[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  searchable?: boolean;
  disabled?: boolean;
  searchPlaceholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Keyboard-highlighted row (ArrowUp/Down move it, Enter picks it, mouse hover syncs it).
  const [activeIdx, setActiveIdx] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, above: false });
  const canSearch = searchable ?? options.length > 7;

  const selected = options.find((o) => !o.heading && o.value === value);
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    // While searching, results are a flat list - group headings would only mislead.
    return q ? options.filter((o) => !o.heading && (o.label.toLowerCase().includes(q) || (o.subtitle || '').toLowerCase().includes(q))) : options;
  }, [options, search]);
  // Keyboard navigation / Enter operate on the pickable rows only (headings are skipped).
  const selectable = useMemo(() => filtered.filter((o) => !o.heading), [filtered]);

  // Only one popup panel open app-wide (see lib/popupBus).
  useEffect(() => { if (open) return registerPopup(() => setOpen(false)); }, [open]);

  // Reset the highlight when the list changes; keep the highlighted row scrolled into view.
  useEffect(() => { setActiveIdx(0); }, [open, search]);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector(`[data-optidx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIdx]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current; if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const above = spaceBelow < 300 && r.top > spaceBelow;
      setPos({ left: r.left, top: above ? r.top : r.bottom, width: r.width, above });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open]);

  useEffect(() => {
    if (!open) { setSearch(''); return; }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(selectable.length - 1, i + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
      else if (e.key === 'Enter' && selectable.length) { e.preventDefault(); pick((selectable[activeIdx] || selectable[0]).value); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectable, activeIdx]);

  const pick = (v: string) => { onChange(v); setOpen(false); setSearch(''); };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'min-h-[44px] w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-all group',
          'border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer dark:hover:bg-nb-gray-900/50',
          className,
        )}
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          {selected?.icon && <span className="shrink-0 text-nb-gray-400">{selected.icon}</span>}
          <span className={cn('truncate', selected ? 'text-nb-gray-800 dark:text-nb-gray-200' : 'text-neutral-500 dark:text-nb-gray-400/70')}>{selected ? selected.label : placeholder}</span>
        </span>
        <ChevronsUpDown size={18} className="shrink-0 text-nb-gray-400 group-hover:text-nb-gray-300 transition-all" />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, zIndex: 1100 }}
          className={cn(pos.above ? '-translate-y-full -mt-2.5' : 'mt-2.5')}
        >
          <div className="rounded-md border border-neutral-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-950 shadow-lg shadow-nb-gray-950 overflow-hidden">
            {canSearch && (
              <div className="relative border-b border-neutral-200 dark:border-nb-gray-700">
                <input
                  autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={searchPlaceholder}
                  className="min-h-[42px] w-full bg-transparent text-sm outline-hidden font-light dark:text-nb-gray-100 dark:placeholder:text-nb-gray-400 placeholder:text-neutral-500 pl-10 pr-12"
                />
                <div className="absolute left-0 top-0 h-full flex items-center pl-4 text-nb-gray-400"><SearchIcon size={14} /></div>
                <div className="absolute right-0 top-0 h-full flex items-center pr-4">
                  <div className="flex items-center bg-nb-gray-100 dark:bg-nb-gray-800 py-1 px-1.5 rounded-[4px] border border-nb-gray-300 dark:border-nb-gray-500 text-nb-gray-500 dark:text-nb-gray-300">
                    <CornerDownLeft size={10} />
                  </div>
                </div>
              </div>
            )}
            <div role="listbox" className="nb-scroll max-h-[240px] overflow-y-auto flex flex-col gap-1 pl-2 py-2 pr-3">
              {filtered.length === 0 ? (
                <div className="px-3 py-3 text-xs text-neutral-500 dark:text-nb-gray-300">No matches</div>
              ) : (() => {
                let selIdx = -1;
                return filtered.map((o) => {
                  if (o.heading) {
                    return (
                      <div key={`h:${o.value}`} className="px-3 pt-2.5 pb-0.5 text-[0.66rem] font-medium uppercase tracking-wider text-nb-gray-400 dark:text-nb-gray-500 select-none">
                        {o.label}
                      </div>
                    );
                  }
                  selIdx++;
                  const idx = selIdx;
                  return (
                    <div
                      key={o.value}
                      role="option"
                      aria-selected={o.value === value}
                      data-optidx={idx}
                      onClick={() => pick(o.value)}
                      onMouseEnter={() => setActiveIdx(idx)}
                      className={cn(
                        'text-sm flex justify-between gap-2 py-2 px-3 cursor-pointer items-center rounded-md transition-colors',
                        idx === activeIdx ? 'bg-nb-gray-100 dark:bg-nb-gray-910' : 'bg-transparent',
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {o.icon && <span className="shrink-0 text-nb-gray-400">{o.icon}</span>}
                        <span className="min-w-0">
                          <span className="block truncate text-nb-gray-700 dark:text-nb-gray-200">{o.label}</span>
                          {o.subtitle && <span className="block truncate text-[0.72rem] text-nb-gray-500">{o.subtitle}</span>}
                        </span>
                      </div>
                      <CheckboxBox checked={o.value === value} />
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// Mirror of NetBird's Radix Checkbox (as used in GroupMultiSelect), for the selected row.
function CheckboxBox({ checked }: { checked: boolean }) {
  return (
    <div className="h-5 w-5 shrink-0">
      <div className={cn(
        'h-5 w-5 rounded-[4px] border flex items-center justify-center transition-colors',
        checked
          ? 'bg-netbird border-netbird text-white dark:text-neutral-50'
          : 'border-neutral-300 bg-white dark:bg-nb-gray-950 dark:border-nb-gray-900',
      )}>
        {checked && <Check size={14} />}
      </div>
    </div>
  );
}
