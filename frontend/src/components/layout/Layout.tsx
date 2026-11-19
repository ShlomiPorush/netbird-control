import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar, MobileSidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { GlobalSearch } from './GlobalSearch';
import { useAppShell } from './useAppShell';
import { LoadingState, TopProgress } from '@/components/ui';

export function Layout() {
  useAppShell();

  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem('nb_sidebar_collapsed') === '1',
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

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
    // Browser remote sessions live above the shells (App.tsx), so moving around keeps them open.
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
