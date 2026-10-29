import { createContext, useContext, type ReactNode } from 'react';
import { useMe } from '@/lib/queries';
import { getTenantMode } from '@/lib/api';
import type { Viewer } from '@/lib/types';

interface ViewerCtx {
  viewer: Viewer;
  /** SSO is on and the user is NOT an admin → limited to their own data. */
  restricted: boolean;
  isAdmin: boolean;
  /** Admin on the CURRENT account: a real admin, or a Tenant Support holder while
   *  managing a tenant (the server elevates them to admin inside a tenant). Outside
   *  tenant mode this equals isAdmin, so main-account behavior is unchanged. */
  tenantAdmin: boolean;
  /** May approve/deny access requests (admin or an Entra approver group). */
  canApprove: boolean;
  /** Fine-grained feature permission check (admins always pass). */
  can: (perm: string) => boolean;
  loading: boolean;
}

const Ctx = createContext<ViewerCtx | null>(null);

const OPEN: Viewer = { authEnabled: false, isAdmin: true };

export function ViewerProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, isError } = useMe();
  // On a non-401 failure, fall back to open access (mirrors the vanilla app).
  const viewer = data ?? (isError ? OPEN : OPEN);
  const isAdmin = !!viewer.isAdmin;
  const restricted = !!viewer.authEnabled && !isAdmin;
  const canApprove = isAdmin || !!viewer.canApprove;
  const can = (perm: string) => isAdmin || !!viewer.perms?.[perm];
  // Read once per render - a tenant switch hard-reloads the app, so this can't go stale.
  const tenantAdmin = isAdmin || (!!getTenantMode() && !!viewer.perms?.['tenants.support']);

  if (isLoading && !data) {
    return (
      <div className="flex h-screen items-center justify-center text-nb-gray-500">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-nb-gray-700 border-t-netbird" />
      </div>
    );
  }

  return <Ctx.Provider value={{ viewer, restricted, isAdmin, tenantAdmin, canApprove, can, loading: isLoading }}>{children}</Ctx.Provider>;
}

export function useViewer(): ViewerCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useViewer must be used within ViewerProvider');
  return v;
}
