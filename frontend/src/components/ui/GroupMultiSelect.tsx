import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, FolderGit2, SearchIcon, XIcon, Check, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { registerPopup } from '@/lib/popupBus';
import type { GroupRef } from '@/lib/types';

interface Props {
  groups: GroupRef[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
}

// Faithful port of NetBird's PeerGroupSelector (groups tab) - exact trigger box,
// gray-ghost GroupBadge chips, search row and command-item rows + Radix-style checkbox.
// Positioned via a portal so it never clips inside modals / scroll areas.
export function GroupMultiSelect({
  groups, value, onChange,
  placeholder = 'Add or select group(s)...',
  searchPlaceholder = 'Search groups...',
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, above: false });

  const selected = useMemo(
    () => value.map((id) => groups.find((g) => g.id === id)).filter(Boolean) as GroupRef[],
    [value, groups],
  );
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return groups.filter((g) => !q || (g.name || '').toLowerCase().includes(q) || (g.id || '').toLowerCase().includes(q));
  }, [groups, search]);

  // Only one popup panel open app-wide (see lib/popupBus).
  useEffect(() => { if (open) return registerPopup(() => setOpen(false)); }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current;
      if (!el) return;
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

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <>
      <div
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'min-h-[46px] w-full relative items-center group',
          'border border-neutral-200 dark:border-nb-gray-700 justify-between py-2 px-3',
          'rounded-md bg-white text-sm dark:bg-nb-gray-900/40 flex dark:text-neutral-400/70 text-neutral-500 cursor-pointer hover:dark:bg-nb-gray-900/50 transition-all',
        )}
      >
        <div className="flex items-center gap-2 flex-wrap h-full">
          {selected.map((g) => (
            <Chip key={g.id} name={g.name} onRemove={() => toggle(g.id)} />
          ))}
          {selected.length === 0 && <span className="pl-1">{placeholder}</span>}
        </div>
        <div className="pl-2">
          <ChevronsUpDown size={18} className="shrink-0 group-hover:text-nb-gray-300 transition-all" />
        </div>
      </div>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, zIndex: 1100 }}
          className={cn(pos.above ? '-translate-y-full -mt-2.5' : 'mt-2.5')}
        >
          <div className="rounded-md border border-neutral-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-950 shadow-lg shadow-nb-gray-950 overflow-hidden">
            {/* Search row */}
            <div className="relative border-b border-neutral-200 dark:border-nb-gray-700">
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="min-h-[42px] w-full bg-transparent text-sm outline-none font-light dark:text-nb-gray-100 dark:placeholder:text-nb-gray-400 placeholder:text-neutral-500 pl-10 pr-12"
              />
              <div className="absolute left-0 top-0 h-full flex items-center pl-4 text-nb-gray-400">
                <SearchIcon size={14} />
              </div>
              <div className="absolute right-0 top-0 h-full flex items-center pr-4">
                <div className="flex items-center bg-nb-gray-100 dark:bg-nb-gray-800 py-1 px-1.5 rounded-[4px] border border-nb-gray-300 dark:border-nb-gray-500 text-nb-gray-500 dark:text-nb-gray-300">
                  <CornerDownLeft size={10} />
                </div>
              </div>
            </div>

            {/* List */}
            <div className="nb-scroll max-h-[195px] overflow-y-auto flex flex-col gap-1 pl-2 py-2 pr-3">
              {filtered.length === 0 ? (
                <div className="px-3 py-3 text-xs text-neutral-500 dark:text-nb-gray-300">No groups found</div>
              ) : filtered.map((option) => {
                const isSelected = value.includes(option.id);
                return (
                  <div
                    key={option.id}
                    onClick={() => toggle(option.id)}
                    className="text-xs flex justify-between py-2 px-3 cursor-pointer items-center rounded-md bg-transparent hover:bg-nb-gray-100 dark:hover:bg-nb-gray-910 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <GroupChipStatic name={option.name} />
                    </div>
                    <CheckboxBox checked={isSelected} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// gray-ghost GroupBadge with an inline remove (X), as in the trigger.
function Chip({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <div
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
      className={cn(
        'relative z-10 whitespace-nowrap rounded-md font-normal flex gap-1.5 items-center justify-center transition-all group/badge',
        'bg-nb-gray-100 dark:bg-nb-gray-900 border border-nb-gray-200 dark:border-nb-gray-800/50 text-nb-gray-600 dark:text-nb-gray-300',
        'hover:bg-nb-gray-200 dark:hover:bg-nb-gray-800 cursor-pointer text-[0.75rem] py-[3px] px-3',
      )}
    >
      <FolderGit2 size={12} className="shrink-0" />
      <span className="truncate max-w-[180px]">{name}</span>
      <XIcon size={12} className="cursor-pointer group-hover/badge:text-nb-gray-100 transition-all shrink-0" />
    </div>
  );
}

// gray-ghost GroupBadge (no remove) used inside a list row.
function GroupChipStatic({ name }: { name: string }) {
  return (
    <div className="relative z-10 whitespace-nowrap rounded-md font-normal flex gap-1.5 items-center justify-center h-7 px-3 bg-nb-gray-100 dark:bg-nb-gray-900 border border-nb-gray-200 dark:border-nb-gray-800/50 text-nb-gray-600 dark:text-nb-gray-300 text-[0.75rem]">
      <FolderGit2 size={12} className="shrink-0" />
      <span className="truncate max-w-[200px]">{name}</span>
    </div>
  );
}

// Mirror of NetBird's Radix Checkbox (default variant).
function CheckboxBox({ checked }: { checked: boolean }) {
  return (
    <div className="h-5 w-5">
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
