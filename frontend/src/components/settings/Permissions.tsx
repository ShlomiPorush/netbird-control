import { useEffect, useMemo, useState } from 'react';
import { useFeaturePerms, useAdGroups, useUsers } from '@/lib/queries';
import { useSaveFeaturePerms } from '@/lib/mutations';
import type { FeaturePermKey, FeaturePermsConfig, FeaturePermUser } from '@/lib/types';
import { Button, LoadingState, Field, GroupMultiSelect } from '@/components/ui';

// The grantable capabilities, in display order. Keys must match backend PERMISSION_KEYS.
const FEATURE_PERMS: { key: FeaturePermKey; label: string; description: string }[] = [
  { key: 'activity.all', label: 'View All Activity', description: 'See traffic events of every user and device on the Activity page - not just their own - including the user filter.' },
  { key: 'peers.all', label: 'View All Peers', description: 'See every peer in the account on the Peers page - not just their own devices.' },
  { key: 'audit.view', label: 'View Audit Logs', description: 'Open the Admin page: app audit trail, NetBird admin activity, statistics, and IP history.' },
  { key: 'temp.manage', label: 'Manage Temporary Access', description: 'Open the Temporary Access page and create, extend, or revoke temporary access grants (including recurring rules).' },
  { key: 'networks.manage', label: 'Manage All Networks', description: 'Admin-grade access to every network: view and edit all resources, routing peers and per-resource policies, and create, rename or delete networks. Includes seeing all peers (needed to pick routing peers).' },
  { key: 'proxy.manage', label: 'Manage Reverse Proxy', description: 'Open the Reverse Proxy page (services, access logs) and create new proxy services, including the Expose Docker Container wizard.' },
  { key: 'troubleshoot.all', label: 'Troubleshoot All Peers', description: 'Support desk: pick ANY device on the Troubleshoot page and run diagnostics on it. Read-only - grants no management rights and does not unlock the Peers page.' },
  { key: 'tenants.support', label: 'Tenant Support', description: 'Switch into MSP tenants and fully manage them - like an admin, but only inside a tenant. No admin rights on the main account, no tenant creation or deletion.' },
];

export function Permissions() {
  const { data, isLoading } = useFeaturePerms();
  const save = useSaveFeaturePerms();
  const users = useUsers().data || [];
  const { data: adGroups } = useAdGroups();
  const userRefs = useMemo(
    () => users.filter((u) => !u.is_service_user).map((u) => ({ id: u.id, name: (u.name || u.email || u.id) + (u.email && u.name ? ` (${u.email})` : '') })),
    [users],
  );
  // Per-permission selections (user ids + group ids), plus the loaded user objects so a
  // selection whose user no longer appears in /api/users is preserved on save.
  const [sel, setSel] = useState<Record<string, { userIds: string[]; groupIds: string[] }>>({});
  const [loadedUsers, setLoadedUsers] = useState<Map<string, FeaturePermUser>>(new Map());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!data) return;
    const next: Record<string, { userIds: string[]; groupIds: string[] }> = {};
    const known = new Map<string, FeaturePermUser>();
    for (const { key } of FEATURE_PERMS) {
      const e = data[key] || { users: [], groupIds: [] };
      next[key] = { userIds: e.users.map((u) => u.id), groupIds: e.groupIds || [] };
      e.users.forEach((u) => known.set(u.id, u));
    }
    setSel(next);
    setLoadedUsers(known);
  }, [data]);

  const patch = (key: FeaturePermKey, p: Partial<{ userIds: string[]; groupIds: string[] }>) =>
    setSel((prev) => {
      const cur = prev[key] || { userIds: [], groupIds: [] };
      return { ...prev, [key]: { ...cur, ...p } };
    });

  const onSave = async () => {
    setError('');
    const cfg: FeaturePermsConfig = {};
    for (const { key } of FEATURE_PERMS) {
      const s = sel[key] || { userIds: [], groupIds: [] };
      cfg[key] = {
        users: s.userIds.map((id) => {
          const u = users.find((x) => x.id === id);
          if (u) return { id: u.id, email: u.email || '', name: u.name || u.email || u.id };
          return loadedUsers.get(id) || { id, email: '', name: id };
        }),
        groupIds: s.groupIds,
      };
    }
    try {
      await save.mutateAsync(cfg);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed to save'); }
  };

  if (isLoading) return <LoadingState />;
  return (
    <div className="max-w-2xl">
      <p className="text-nb-gray-500 text-sm mb-5">
        Grant specific capabilities to non-admin users - without making them admins. A capability applies to
        anyone selected directly or through one of the selected groups. Admins always have every capability.
      </p>

      <div className="flex flex-col gap-4">
        {FEATURE_PERMS.map(({ key, label, description }) => {
          const s = sel[key] || { userIds: [], groupIds: [] };
          return (
            <div key={key} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
              <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">{label}</div>
              <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3">{description}</p>
              <div className="flex flex-col gap-3">
                <Field label="Users">
                  <GroupMultiSelect groups={userRefs} value={s.userIds} onChange={(ids) => patch(key, { userIds: ids })}
                    placeholder="Select users…" searchPlaceholder="Search users…" />
                </Field>
                <Field label="Groups" hint="Members of these groups get the capability.">
                  <GroupMultiSelect groups={adGroups || []} value={s.groupIds} onChange={(ids) => patch(key, { groupIds: ids })}
                    placeholder="Select groups…" searchPlaceholder="Search groups…" />
                </Field>
              </div>
            </div>
          );
        })}

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
          {error && <span className="text-sm text-red-500">{error}</span>}
        </div>
      </div>
    </div>
  );
}
