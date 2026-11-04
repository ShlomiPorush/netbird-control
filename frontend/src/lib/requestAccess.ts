import type { GrantTarget } from '@/lib/types';

/** A link to Request Access with the target already chosen, so the user doesn't search for it
 *  again. The page reads ?type=&id=&name= once; the server resolves the target against its own
 *  catalogue when the request is submitted. Without a target it is the plain page. */
export function requestAccessLink(t?: GrantTarget | null): string {
  if (!t || !t.id) return '/request-access';
  const p = new URLSearchParams({ type: t.type, id: t.id, name: t.name || t.id });
  if (t.networkId) p.set('networkId', t.networkId);
  if (t.resourceType) p.set('resourceType', t.resourceType);
  if (t.access) p.set('access', JSON.stringify(t.access));
  return `/request-access?${p.toString()}`;
}
