import { Suspense, useEffect, useLayoutEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar, MobileSidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { GlobalSearch } from './GlobalSearch';
import { LoadingState, TopProgress } from '@/components/ui';
import { useAppConfig } from '@/lib/queries';
import { setTimeFormat } from '@/lib/logfmt';

export function Layout() {
  const cfg = useAppConfig().data;
  // Apply the configured timezone / date format / clock before child pages render
  // their timestamps.
  setTimeFormat({ timeZone: cfg?.timeZone, dateFormat: cfg?.dateFormat, hour12: cfg?.hour12 });
  useEffect(() => { if (cfg?.appName) document.title = cfg.appName; }, [cfg?.appName]);

  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem('nb_sidebar_collapsed') === '1',
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  // Reset scroll to the top when navigating to a different page (menu navigation), so a page
  // never opens mid-scroll at the previous page's position. Keyed on pathname only, so in-page
  // tab switches (`?tab=…`) keep their position. useLayoutEffect scrolls before paint (no flash).
  useLayoutEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

  const toggleCollapse = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem('nb_sidebar_collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    // The page itself scrolls (the standard browser scrollbar at the window edge).
    // The top bar and the sidebar are sticky so they stay put while content scrolls.
    <div className="flex flex-col min-h-screen">
      {/* Global loading bar for the heavy log queries - renders nothing while idle. */}
      <TopProgress />
      {/* Tenant mode is signaled by the TopBar itself (orange tint + tenant chip) - no extra bar. */}
      <TopBar collapsed={collapsed} onToggleCollapse={toggleCollapse} onOpenMobile={() => setMobileOpen(true)} />
      <div className="flex flex-1 min-h-0">
        <Sidebar collapsed={collapsed} />
        <main className="flex-1 min-w-0">
          <div className="px-4 py-5 md:px-8 md:py-8">
            {/* Route pages are lazy chunks (App.tsx) - keep the nav chrome while one loads. */}
            <Suspense fallback={<LoadingState />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
      <MobileSidebar open={mobileOpen} onClose={() => setMobileOpen(false)} />
      <GlobalSearch />
    </div>
  );
}
