import { Suspense, useEffect } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { ArrowLeft, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { useViewer } from '@/contexts/ViewerContext';
import { LoadingState } from '@/components/ui';
import { AccountMenu, useTenantFallback } from './TopBar';
import { useAppShell } from './useAppShell';

/** The Remote Access shell: a page of its own, without the portal's sidebar and top bar. Only the
 * way back to the portal, the theme switch and the account menu stay, above one centered card. */
export function RemoteLayout() {
  const appName = useAppShell()?.appName || 'NetBird Control';
  const { effective, toggle } = useTheme();
  const { viewer } = useViewer();
  // A launch link in a tab that still points at a removed tenant goes on in the main account.
  useTenantFallback();
  // No browser menu on a right click anywhere on this page (menus and panels it opens included);
  // text fields keep theirs, for paste.
  useEffect(() => {
    const block = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
    };
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  return (
    <div className="relative isolate flex min-h-screen flex-col bg-nb-gray-50 dark:bg-nb-gray-960">
      {/* A soft brand glow behind the card. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28rem] bg-[radial-gradient(56rem_26rem_at_50%_-5rem,rgba(246,131,48,0.16),transparent_70%)] dark:bg-[radial-gradient(56rem_26rem_at_50%_-5rem,rgba(246,131,48,0.12),transparent_70%)]" />

      <header className="flex items-center justify-between gap-3 px-3 py-3 sm:px-5">
        <Link to="/" aria-label="Back To Portal" title="Back To Portal"
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-nb-gray-600 hover:bg-nb-gray-200/70 hover:text-nb-gray-900 dark:text-nb-gray-300 dark:hover:bg-nb-gray-900 dark:hover:text-nb-gray-50 transition-colors">
          <ArrowLeft size={17} /> <span className="hidden sm:inline">Back To Portal</span>
        </Link>
        <div className="flex items-center gap-1.5">
          <button onClick={toggle} title="Toggle theme" aria-label="Toggle theme"
            className="flex h-9 w-9 items-center justify-center rounded-md text-nb-gray-500 hover:bg-nb-gray-200 dark:text-nb-gray-400 dark:hover:bg-nb-gray-900 transition-colors">
            {effective === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          {viewer.authEnabled && <AccountMenu />}
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center px-4 pt-2 pb-10 sm:justify-center sm:pb-16">
        <div className="mb-5 flex max-w-full min-w-0 items-center gap-2.5 text-sm font-semibold text-nb-gray-600 dark:text-nb-gray-300">
          <img src="/favicon.svg" alt="" className="h-7 w-7 shrink-0" />
          <span className="min-w-0 truncate">{appName}</span>
        </div>
        <Suspense fallback={<LoadingState />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
