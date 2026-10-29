import { NavLink } from 'react-router-dom';
import { Home, Activity, ShieldCheck, Shield, Users, MonitorSmartphone, Network, Settings, Wrench, KeyRound, ClipboardCheck, X, Globe, Stethoscope, Building2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useViewer } from '@/contexts/ViewerContext';
import { usePendingRequestCount, useMspStatus } from '@/lib/queries';
import { getTenantMode } from '@/lib/api';
import { useScrollLock } from '@/lib/useScrollLock';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Activity;
  adminOnly?: boolean;
  approverOnly?: boolean; // visible to admins AND designated approvers
  perm?: string;          // adminOnly item ALSO visible to holders of this feature permission
  /** The Access Management hub: admins OR approvers OR temp.manage holders. */
  accessHub?: boolean;
  /** MSP Tenants: admins only AND the account must be an activated MSP. */
  mspOnly?: boolean;
  /** Visible while MANAGING a tenant (default: hidden in tenant mode). */
  tenantMode?: boolean;
  end?: boolean;
  badge?: 'pendingRequests';
}

const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: Home, end: true, tenantMode: true },
  { to: '/activity', label: 'Activity', icon: Activity, tenantMode: true },
  { to: '/admin', label: 'Admin', icon: ShieldCheck, adminOnly: true, perm: 'audit.view', tenantMode: true },
  { to: '/users', label: 'Users & Groups', icon: Users, adminOnly: true, tenantMode: true },
  { to: '/peers', label: 'Peers', icon: MonitorSmartphone, tenantMode: true },
  { to: '/policies', label: 'Policies', icon: Shield, adminOnly: true, tenantMode: true },
  { to: '/networks', label: 'Networks', icon: Network, tenantMode: true },
  { to: '/reverse-proxy', label: 'Reverse Proxy', icon: Globe, adminOnly: true, perm: 'proxy.manage', tenantMode: true },
  { to: '/request-access', label: 'Request Access', icon: KeyRound },
  { to: '/access', label: 'Access Management', icon: ClipboardCheck, accessHub: true, badge: 'pendingRequests', tenantMode: true },
  { to: '/tenants', label: 'Tenants', icon: Building2, adminOnly: true, mspOnly: true },
  { to: '/operations', label: 'Operations', icon: Wrench, adminOnly: true, tenantMode: true },
  { to: '/settings', label: 'Settings', icon: Settings, adminOnly: true, tenantMode: true },
];

function NavList({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { restricted, tenantAdmin, canApprove, can } = useViewer();
  // Tenants shows only for admins of an activated MSP account (checked once, cached long).
  const mspAvailable = !!useMspStatus(!restricted).data?.available;
  const inTenantMode = !!getTenantMode();
  const items = NAV.filter((n) => {
    // While MANAGING a tenant only the live-management pages stay - everything else
    // (history, app features, settings) belongs to the main account.
    if (inTenantMode && !n.tenantMode) return false;
    // Tenants stays admin-only (never shown to support users): `restricted`, not tenantAdmin.
    if (n.mspOnly && (!mspAvailable || restricted)) return false;
    if (n.accessHub) return !restricted || canApprove || can('temp.manage') || tenantAdmin;
    // Admin-gated items open to a Tenant Support holder WHILE managing a tenant (tenantAdmin);
    // outside tenant mode tenantAdmin === isAdmin, so a support user sees exactly what a
    // restricted user sees today.
    if (n.adminOnly && !tenantAdmin && !(n.perm && can(n.perm))) return false;
    if (n.approverOnly && !canApprove) return false;
    return true;
  });
  // Access requests are a main-account feature - don't poll pending-count in tenant mode (403).
  const pending = usePendingRequestCount(canApprove && !inTenantMode).data?.count || 0;
  return (
    <>
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-[3px]">
        {items.map(({ to, label, icon: Icon, end, badge }) => {
          const count = badge === 'pendingRequests' ? pending : 0;
          return (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg text-[.87rem] font-normal py-[.5rem] px-3 transition-colors',
                collapsed && 'justify-center px-0',
                isActive
                  ? 'bg-nb-gray-200 text-nb-gray-900 dark:bg-nb-gray-900 dark:text-white'
                  : 'text-nb-gray-600 hover:bg-nb-gray-200 dark:text-nb-gray-400 dark:hover:bg-nb-gray-900/50 dark:hover:text-nb-gray-200',
              )
            }
          >
            <span className="relative shrink-0">
              <Icon size={18} />
              {collapsed && count > 0 && <span className="absolute -top-1.5 -right-1.5 h-2 w-2 rounded-full bg-netbird" />}
            </span>
            {!collapsed && <span className="truncate">{label}</span>}
            {!collapsed && count > 0 && (
              <span className="ml-auto inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-netbird text-white text-[0.7rem] font-medium">{count}</span>
            )}
          </NavLink>
          );
        })}
      </nav>
      {/* Pinned to the bottom, visually quieter than the main nav - a help tool, not a destination. */}
      <div className="shrink-0 px-3 py-2 border-t border-nb-gray-200 dark:border-nb-gray-900">
        <NavLink
          to="/troubleshoot"
          onClick={onNavigate}
          title={collapsed ? 'Troubleshoot' : undefined}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-lg text-[0.8rem] font-normal py-[0.4rem] px-3 transition-colors',
              collapsed && 'justify-center px-0',
              isActive
                ? 'bg-nb-gray-200 text-nb-gray-900 dark:bg-nb-gray-900 dark:text-white'
                : 'text-nb-gray-500 hover:bg-nb-gray-200 dark:text-nb-gray-500 dark:hover:bg-nb-gray-900/50 dark:hover:text-nb-gray-300',
            )
          }
        >
          <Stethoscope size={16} className="shrink-0" />
          {!collapsed && <span className="truncate">Troubleshoot</span>}
        </NavLink>
      </div>
    </>
  );
}

/** Desktop sidebar (md+): sticky, collapsible. Hidden on mobile (use the drawer there). */
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      className={cn(
        'hidden md:flex flex-col shrink-0 sticky top-14 h-[calc(100vh-3.5rem)] border-r',
        'border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-950',
        'transition-[width] duration-200',
        collapsed ? 'w-[68px]' : 'w-[240px]',
      )}
    >
      <NavList collapsed={collapsed} />
    </aside>
  );
}

/** Mobile navigation drawer (< md): off-canvas with a backdrop, closes on navigate. */
export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Full-screen drawer - the page behind must not scroll while it's open.
  useScrollLock(open);
  return (
    <div className={cn('md:hidden fixed inset-0 z-50', !open && 'pointer-events-none')} aria-hidden={!open}>
      <div
        className={cn('absolute inset-0 bg-black/50 transition-opacity duration-200', open ? 'opacity-100' : 'opacity-0')}
        onClick={onClose}
      />
      <aside
        className={cn(
          'absolute left-0 top-0 h-full w-[260px] max-w-[82%] flex flex-col shadow-2xl',
          'border-r border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-950',
          'transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between h-14 px-4 border-b border-nb-gray-200 dark:border-nb-gray-900">
          <span className="font-semibold text-nb-gray-900 dark:text-nb-gray-50">Menu</span>
          <button onClick={onClose} title="Close" className="flex items-center justify-center h-8 w-8 rounded-md text-nb-gray-500 hover:bg-nb-gray-200 dark:hover:bg-nb-gray-900 dark:text-nb-gray-400">
            <X size={18} />
          </button>
        </div>
        <NavList onNavigate={onClose} />
      </aside>
    </div>
  );
}
