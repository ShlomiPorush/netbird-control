import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, UserCircle2, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { registerPopup } from '@/lib/popupBus';
import { avatarColor } from '@/lib/str';

export interface UserOpt { id: string; name: string; email: string }

function Avatar({ name, id, size = 28 }: { name?: string; id?: string; size?: number }) {
  const label = name || id || '?';
  return (
    <div
      className="rounded-full shrink-0 flex items-center justify-center uppercase font-medium bg-nb-gray-200 dark:bg-nb-gray-850"
      style={{ width: size, height: size, fontSize: size * 0.42, color: avatarColor(label) }}
    >
      {label.charAt(0)}
    </div>
  );
}

export function UserSelect({ users, value, onChange }: { users: UserOpt[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, above: false });

  // Only one popup panel open app-wide (see lib/popupBus).
  useEffect(() => { if (open) return registerPopup(() => setOpen(false)); }, [open]);

  const selected = users.find((u) => u.id === value);
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [users, search]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current; if (!el) return;
      const r = el.getBoundingClientRect();
      const W = Math.max(280, r.width);
      const left = Math.min(r.left, window.innerWidth - W - 8);
      const above = window.innerHeight - r.bottom < 320 && r.top > window.innerHeight - r.bottom;
      setPos({ left, top: above ? r.top : r.bottom, width: W, above });
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

  const pick = (id: string) => { onChange(id); setOpen(false); setSearch(''); };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center justify-between gap-2 h-[42px] px-4 rounded-md border text-sm font-medium whitespace-nowrap transition-colors shadow-xs bg-white border-gray-200 text-gray-900 hover:bg-gray-100 dark:bg-nb-gray-920 dark:text-nb-gray-300 dark:border-nb-gray-700/40 dark:hover:text-white dark:hover:bg-nb-gray-910"
        style={{ minWidth: 170 }}
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          {selected ? <Avatar name={selected.name} id={selected.id} size={20} /> : <UserCircle2 size={16} className="text-nb-gray-500 dark:text-nb-gray-300" />}
          <span className="truncate">{selected ? selected.name || selected.id : 'All Users'}</span>
        </span>
        <ChevronsUpDown size={16} className="shrink-0 opacity-60" />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width }}
          className={cn('z-1100', pos.above ? '-translate-y-full -mt-2' : 'mt-2')}
        >
          <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-950 shadow-2xl overflow-hidden">
            <div className="relative border-b border-nb-gray-100 dark:border-nb-gray-800">
              <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-nb-gray-400" />
              <input
                autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search user..."
                className="h-11 w-full bg-transparent pl-10 pr-3 text-sm outline-hidden font-light dark:text-nb-gray-100 placeholder:text-nb-gray-500 dark:placeholder:text-nb-gray-400"
              />
            </div>
            <div className="nb-scroll max-h-[360px] overflow-y-auto p-1.5">
              <button onClick={() => pick('')} className="flex items-center gap-2.5 w-full px-2 py-2 rounded-md text-left hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
                <div className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center bg-sky-400 text-white"><UserCircle2 size={16} /></div>
                <div className="flex flex-col min-w-0">
                  <span className="text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200">All Users</span>
                  <span className="text-[0.72rem] text-nb-gray-500 dark:text-nb-gray-400 font-light">Include all users</span>
                </div>
              </button>
              {filtered.length === 0 ? (
                <div className="px-3 py-3 text-xs text-nb-gray-500">No users matching your search.</div>
              ) : filtered.map((u) => (
                <button key={u.id} onClick={() => pick(u.id)} className="flex items-center gap-2.5 w-full px-2 py-2 rounded-md text-left hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
                  <Avatar name={u.name} id={u.id} />
                  <div className="flex flex-col min-w-0">
                    <span className="text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200 truncate">{u.name || u.id}</span>
                    <span className="text-[0.72rem] text-nb-gray-500 dark:text-nb-gray-400 font-light truncate">{u.email || '-'}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
