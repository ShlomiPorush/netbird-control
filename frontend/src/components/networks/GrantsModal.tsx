import { useMemo, useState } from 'react';
import { ShieldCheck, Pencil, Eye, Users } from 'lucide-react';
import { Modal, Button, Spinner, GroupMultiSelect } from '@/components/ui';
import { useAdGroups, useAccessProfiles } from '@/lib/queries';
import { useSaveGrants, useSaveNetworkDefaultProfiles } from '@/lib/mutations';
import type { NetworkGrant } from '@/lib/types';

interface Props {
  networkId: string;
  networkName: string;
  currentGrants: NetworkGrant[];
  currentDefaultProfileIds: number[];
  onClose: () => void;
}

export function GrantsModal({ networkId, networkName, currentGrants, currentDefaultProfileIds, onClose }: Props) {
  const { data: groups, isLoading } = useAdGroups();
  const { data: profiles } = useAccessProfiles();
  const saveGrants = useSaveGrants();
  const saveDefaults = useSaveNetworkDefaultProfiles();
  const [editGroups, setEditGroups] = useState<string[]>(() => currentGrants.filter((g) => g.access === 'edit').map((g) => g.id));
  const [viewGroups, setViewGroups] = useState<string[]>(() => currentGrants.filter((g) => g.access === 'view').map((g) => g.id));
  // Which edit groups get baked into NEW policies as sources (default: all of them).
  const [policySources, setPolicySources] = useState<string[]>(
    () => currentGrants.filter((g) => g.access === 'edit' && g.policySource !== false).map((g) => g.id),
  );
  // Grantable-only groups: the network's editors may PICK these as policy sources,
  // without the groups gaining any edit/view rights on the network.
  const [grantable, setGrantable] = useState<string[]>(() => currentGrants.filter((g) => g.access === 'source').map((g) => g.id));
  const [defaults, setDefaults] = useState<number[]>(currentDefaultProfileIds);

  // Only shared profiles can be assigned to a resource (and thus default-selected).
  const sharedProfiles = useMemo(() => (profiles || []).filter((p) => p.shared), [profiles]);
  const pending = saveGrants.isPending || saveDefaults.isPending;

  // Keep policy sources a subset of the edit groups; a NEWLY added edit group is included by
  // default (the legacy behavior), a removed one drops out.
  const onEditGroupsChange = (next: string[]) => {
    const prev = new Set(editGroups);
    const added = next.filter((id) => !prev.has(id));
    setEditGroups(next);
    setPolicySources((ps) => [...ps.filter((id) => next.includes(id)), ...added]);
  };
  const editGroupOptions = useMemo(
    () => (groups || []).filter((g) => editGroups.includes(g.id)),
    [groups, editGroups],
  );

  const submit = async () => {
    // Edit takes precedence: a group listed in both is granted edit, ignored in view.
    // Grantable rows are last - a group already granted edit/view keeps that (stronger) row.
    const editSet = new Set(editGroups);
    const viewSet = new Set(viewGroups);
    const grants: NetworkGrant[] = [
      ...editGroups.map((id) => ({ id, name: '', access: 'edit' as const, policySource: policySources.includes(id) })),
      ...viewGroups.filter((id) => !editSet.has(id)).map((id) => ({ id, name: '', access: 'view' as const })),
      ...grantable.filter((id) => !editSet.has(id) && !viewSet.has(id)).map((id) => ({ id, name: '', access: 'source' as const })),
    ];
    await saveGrants.mutateAsync({ networkId, grants: grants.map((g) => ({ id: g.id, access: g.access, policySource: g.policySource })) });
    await saveDefaults.mutateAsync({ networkId, profileIds: defaults });
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<ShieldCheck size={18} />}
      title={`Manage Access - ${networkName}`}
      subtitle="Choose who may edit or view this network, and which Access Profile new resources get by default."
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      {isLoading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-[0.8rem] font-semibold text-nb-gray-600 dark:text-nb-gray-400"><Pencil size={13} /> Groups That Can Edit</span>
            <GroupMultiSelect groups={groups || []} value={editGroups} onChange={onEditGroupsChange} placeholder="Select AD groups…" />
            <p className="text-[0.78rem] text-nb-gray-500">Members can add, edit and delete resources, routing peers and policies in this network.</p>
          </div>

          {editGroups.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-2 text-[0.8rem] font-semibold text-nb-gray-600 dark:text-nb-gray-400"><ShieldCheck size={13} /> Policy Source Groups</span>
              <GroupMultiSelect groups={editGroupOptions} value={policySources} onChange={setPolicySources} placeholder="Select which edit groups become policy sources…" />
              <p className="text-[0.78rem] text-nb-gray-500">Of the edit groups above, only these are automatically added as <b>sources of new policies</b> created in this network. An edit group left out can manage the network without its members getting access from every new policy.</p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-[0.8rem] font-semibold text-nb-gray-600 dark:text-nb-gray-400"><Eye size={13} /> Groups That Can View (Read-Only)</span>
            <GroupMultiSelect groups={groups || []} value={viewGroups} onChange={setViewGroups} placeholder="Select AD groups…" />
            <p className="text-[0.78rem] text-nb-gray-500">Members can open this network and see everything in it, but can’t make changes. A group set to edit above takes precedence.</p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-[0.8rem] font-semibold text-nb-gray-600 dark:text-nb-gray-400"><Users size={13} /> Grantable Source Groups</span>
            <GroupMultiSelect groups={groups || []} value={grantable} onChange={setGrantable} placeholder="Select AD groups…" />
            <p className="text-[0.78rem] text-nb-gray-500">
              The network's <b>editors</b> (non-admins) may pick these as <b>policy sources</b> when creating or
              editing a resource policy - without seeing the full group list, and without these groups gaining any
              rights on the network itself. Leave empty to keep editors locked to the automatic sources above.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[0.8rem] font-semibold text-nb-gray-600 dark:text-nb-gray-400">Default Access Profile</span>
            {sharedProfiles.length ? (
              <>
                <GroupMultiSelect
                  groups={sharedProfiles.map((p) => ({ id: String(p.id), name: p.name }))}
                  value={defaults.map(String)}
                  onChange={(ids) => setDefaults(ids.map(Number))}
                  placeholder="Select default profile(s)…"
                />
                <p className="text-[0.78rem] text-nb-gray-500">Pre-selected (and editable) when adding a resource to this network.</p>
              </>
            ) : (
              <p className="text-[0.82rem] text-nb-gray-500">No shared Access Profiles yet - create one in Operations → Access Profiles.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
