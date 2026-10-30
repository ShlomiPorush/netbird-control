import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Search, GitFork, Share2, MonitorSmartphone, FolderGit2, User2, ShieldCheck, Layers, Globe } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSearch } from '@/lib/queries';
import { useDebounced } from '@/lib/useDebounced';
import { useScrollLock } from '@/lib/useScrollLock';
import type { SearchResult } from '@/lib/types';

const TYPE_META: Record<SearchResult['type'], { label: string; icon: ReactNode }> = {
  network: { label: 'Networks', icon: <GitFork size={15} /> },
  resource: { label: 'Resources', icon: <Share2 size={15} /> },
  peer: { label: 'Peers', icon: <MonitorSmartphone size={15} /> },
  group: { label: 'Groups', icon: <FolderGit2 size={15} /> },
  user: { label: 'Users', icon: <User2 size={15} /> },
  policy: { label: 'Policies', icon: <ShieldCheck size={15} /> },
  profile: { label: 'Access Profiles', icon: <Layers size={15} /> },
  proxy: { label: 'Proxy Services', icon: <Globe size={15} /> },
};

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.4rem] items-center justify-center rounded-sm border border-nb-gray-300 dark:border-nb-gray-700 bg-nb-gray-100 dark:bg-nb-gray-800 px-1.5 py-0.5 font-sans text-[0.7rem] text-nb-gray-600 dark:text-nb-gray-300">
      {children}
    </kbd>
  );
}

/** ⌘K / Ctrl-K global command palette - search networks, resources, peers, groups, users
 *  and policies, navigate with the keyboard. Mounted once in the app shell. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const dq = useDebounced(q);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);

  const { data, isFetching } = useSearch(dq, open);
  const results = data?.results || [];

  // ⌘K / Ctrl+K toggles the palette (works anywhere, even while an input is focused).
  // Match on e.code ('KeyK' - the PHYSICAL key), NOT e.key: on a non-Latin layout (e.g.
  // Hebrew) Ctrl+K yields e.key='ל', so an e.key==='k' check misses and the BROWSER's Ctrl+K
  // fires instead. Registered in the CAPTURE phase so we preventDefault before the browser.
  // The TopBar search button dispatches `app:search` to open it by click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        e.stopPropagation();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('app:search', onOpen);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('app:search', onOpen); };
  }, []);
  useEffect(() => { if (!open) { setQ(''); setSel(0); } }, [open]);
  // Full-screen overlay - the page behind must not scroll while it's open.
  useScrollLock(open);
  useEffect(() => { setSel(0); }, [dq]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const go = (r: SearchResult) => { setOpen(false); navigate(r.to); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) go(results[sel]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-1200 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-xs"
      onMouseDown={() => setOpen(false)}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}>
        {/* Input */}
        <div className="flex items-center gap-2.5 border-b border-nb-gray-100 dark:border-nb-gray-900 px-4">
          <Search size={18} className="shrink-0 text-nb-gray-400" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search networks, resources, peers…"
            className="h-12 flex-1 bg-transparent text-sm text-nb-gray-900 outline-hidden placeholder:text-nb-gray-400 dark:text-nb-gray-100"
          />
        </div>

        {/* Body */}
        {dq.trim().length < 1 ? (
          <div className="px-6 py-10 text-center">
            <div className="mb-3 flex items-center justify-center gap-2.5 text-nb-gray-400">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-nb-gray-100 dark:bg-nb-gray-900"><GitFork size={16} /></span>
              <span className="grid h-9 w-9 place-items-center rounded-md bg-nb-gray-100 dark:bg-nb-gray-900"><Share2 size={16} /></span>
              <span className="grid h-9 w-9 place-items-center rounded-md bg-nb-gray-100 dark:bg-nb-gray-900"><MonitorSmartphone size={16} /></span>
            </div>
            <div className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">Search across your account</div>
            <div className="mx-auto mt-1 max-w-sm text-[0.8rem] text-nb-gray-500">
              Networks, resources, peers, groups, users, policies, access profiles and proxy services. Start typing by name, description or address.
            </div>
          </div>
        ) : !results.length ? (
          <div className="px-6 py-10 text-center text-sm text-nb-gray-500">
            {isFetching ? 'Searching…' : <>No results for “{dq}”.</>}
          </div>
        ) : (
          <div ref={listRef} className="nb-scroll max-h-[52vh] overflow-y-auto py-1.5">
            {results.map((r, i) => (
              <Fragment key={`${r.type}-${r.id}`}>
                {(i === 0 || results[i - 1].type !== r.type) && (
                  <div className="px-4 pb-1 pt-2 text-[0.66rem] font-medium uppercase tracking-wide text-nb-gray-400 dark:text-nb-gray-500">
                    {TYPE_META[r.type].label}
                  </div>
                )}
                <button
                  data-idx={i}
                  onMouseMove={() => setSel(i)}
                  onClick={() => go(r)}
                  className={cn('flex w-full items-center gap-3 px-4 py-2 text-left',
                    i === sel ? 'bg-netbird/10' : 'hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40')}
                >
                  <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-md',
                    i === sel ? 'bg-netbird/15 text-netbird' : 'bg-nb-gray-100 text-nb-gray-500 dark:bg-nb-gray-900')}>
                    {TYPE_META[r.type].icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-nb-gray-800 dark:text-nb-gray-100">{r.title}</span>
                    {r.subtitle && <span className="block truncate text-[0.76rem] text-nb-gray-500">{r.subtitle}</span>}
                  </span>
                </button>
              </Fragment>
            ))}
          </div>
        )}

        {/* Footer hints */}
        <div className="flex items-center gap-3 border-t border-nb-gray-100 dark:border-nb-gray-900 px-4 py-2 text-[0.72rem] text-nb-gray-500">
          <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> Navigate</span>
          <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd> Open</span>
          <span className="inline-flex items-center gap-1"><Kbd>esc</Kbd> Close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
