import { lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { useViewer } from '@/contexts/ViewerContext';
import { getTenantMode } from '@/lib/api';
import type { ReactNode } from 'react';

// Route-level code splitting: each page is its own chunk, fetched on first visit
// (previously the whole app shipped as one bundle). The Suspense fallback lives in
// Layout around the <Outlet />, so the nav chrome stays put while a chunk loads.
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Activity = lazy(() => import('@/pages/Activity'));
const Admin = lazy(() => import('@/pages/Admin'));
const Users = lazy(() => import('@/pages/Users'));
const UserDetail = lazy(() => import('@/pages/UserDetail'));
const GroupDetail = lazy(() => import('@/pages/GroupDetail'));
const Peers = lazy(() => import('@/pages/Peers'));
const PeerDetail = lazy(() => import('@/pages/PeerDetail'));
const NetworksList = lazy(() => import('@/pages/NetworksList'));
const NetworkDetail = lazy(() => import('@/pages/NetworkDetail'));
const Policies = lazy(() => import('@/pages/Policies'));
const Settings = lazy(() => import('@/pages/Settings'));
const Operations = lazy(() => import('@/pages/Operations'));
const RequestAccess = lazy(() => import('@/pages/RequestAccess'));
const AccessManagement = lazy(() => import('@/pages/AccessManagement'));
const ReverseProxy = lazy(() => import('@/pages/ReverseProxy'));
const Troubleshoot = lazy(() => import('@/pages/Troubleshoot'));
const Tenants = lazy(() => import('@/pages/Tenants'));

// Admin-only pages: non-admins are bounced. `tenantAdmin` lets a Tenant Support holder
// through WHILE managing a tenant (server treats them as admin there); outside tenant mode
// tenantAdmin === isAdmin, so main-account behavior is unchanged for everyone.
function AdminRoute({ children }: { children: ReactNode }) {
  const { tenantAdmin } = useViewer();
  return tenantAdmin ? <>{children}</> : <Navigate to="/" replace />;
}

// The Access Management hub: admins, approvers, and Manage Temporary Access holders -
// each sees only the sections their rights unlock (filtered inside the page).
function AccessMgmtRoute({ children }: { children: ReactNode }) {
  const { restricted, canApprove, can } = useViewer();
  return (!restricted || canApprove || can('temp.manage')) ? <>{children}</> : <Navigate to="/" replace />;
}

// Pages open to admins AND holders of a fine-grained feature permission (Settings → Permissions).
function PermRoute({ perm, children }: { perm: string; children: ReactNode }) {
  const { can, tenantAdmin } = useViewer();
  return (can(perm) || tenantAdmin) ? <>{children}</> : <Navigate to="/" replace />;
}

// While MANAGING an MSP tenant, only the live-management pages exist - anything stateful
// (history, app features, settings) belongs to the main account and bounces to Peers.
// Mirrors the server-side allowlist, which is the actual enforcement.
function TenantSafeRoute({ children }: { children: ReactNode }) {
  return getTenantMode() ? <Navigate to="/peers" replace /> : <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="activity" element={<Activity />} />
        <Route path="admin" element={<PermRoute perm="audit.view"><Admin /></PermRoute>} />
        <Route path="users" element={<AdminRoute><Users /></AdminRoute>} />
        {/* Accessible to non-admins for their OWN profile; the backend enforces self-or-admin. */}
        <Route path="users/:id" element={<UserDetail />} />
        <Route path="groups/:id" element={<AdminRoute><GroupDetail /></AdminRoute>} />
        <Route path="peers" element={<Peers />} />
        <Route path="peers/:id" element={<PeerDetail />} />
        <Route path="policies" element={<AdminRoute><Policies /></AdminRoute>} />
        <Route path="networks" element={<NetworksList />} />
        <Route path="networks/:id" element={<NetworkDetail />} />
        {/* Settings runs in tenant mode too - the page itself filters to the per-tenant sections
            (Webhook + Data Retention); the server allowlist enforces the same. */}
        <Route path="settings" element={<AdminRoute><Settings /></AdminRoute>} />
        <Route path="operations" element={<AdminRoute><Operations /></AdminRoute>} />
        {/* Old standalone pages now live under Operations - keep deep links alive. */}
        <Route path="automation" element={<Navigate to="/operations?tab=automation" replace />} />
        <Route path="request-access" element={<TenantSafeRoute><RequestAccess /></TenantSafeRoute>} />
        {/* Troubleshoot works in tenant mode too - a support user diagnoses the tenant's devices. */}
        <Route path="troubleshoot" element={<Troubleshoot />} />
        <Route path="access" element={<AccessMgmtRoute><AccessManagement /></AccessMgmtRoute>} />
        {/* The three standalone pages now live under Access Management - keep deep links alive. */}
        <Route path="temporary-access" element={<Navigate to="/access?section=grants" replace />} />
        <Route path="access-requests" element={<Navigate to="/access?section=requests" replace />} />
        <Route path="access-review" element={<Navigate to="/access?section=review" replace />} />
        <Route path="cleanup" element={<Navigate to="/operations?tab=cleanup" replace />} />
        <Route path="reverse-proxy" element={<PermRoute perm="proxy.manage"><ReverseProxy /></PermRoute>} />
        <Route path="tenants" element={<TenantSafeRoute><AdminRoute><Tenants /></AdminRoute></TenantSafeRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
