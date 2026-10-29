import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Share2, Plus, MoreVertical, Edit2, Trash2, Lock, ShieldCheck, Copy, ClipboardPaste, Check, X as XIcon, Rows3 } from 'lucide-react';
import {
  Modal, Tabs, Input, Field, Button, Spinner, GroupMultiSelect, SearchInput, SortTh, Pagination,
} from '@/components/ui';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { usePolicyOptions, useAppConfig, useAccessProfiles, useBlocklist } from '@/lib/queries';
import { PolicyModal } from './PolicyModal';
import { addressBlockedForNetwork, addressesOverlap } from '@/lib/blocklist';
import { writePolicyClipboard, readPolicyClipboard } from '@/lib/policyClipboard';
import { useSaveResource } from '@/lib/mutations';
import { useViewer } from '@/contexts/ViewerContext';
import type { Resource, PolicyOptions, PolicyInput, AccessProfile } from '@/lib/types';
import { cn } from '@/lib/cn';

interface Props {
  networkId: string;
  resource: Resource | null; // null = create
  duplicate?: boolean; // true = `resource` is a SOURCE to copy: form opens prefilled, saving creates a NEW resource
  initialTab?: 'resource' | 'access';
  existingNames?: string[]; // names of OTHER resources in this network (for duplicate check)
  existingResources?: { name: string; address: string }[]; // OTHER resources here (overlap check)
  allowDuplicates?: boolean; // per-network opt-out: overlapping addresses are allowed here
  onClose: () => void;
}

export function ResourceModal({ networkId, resource, duplicate = false, initialTab = 'resource', existingNames = [], existingResources = [], allowDuplicates = false, onClose }: Props) {
  const opts = usePolicyOptions(networkId);
  const profiles = useAccessProfiles();
  const ready = !opts.isLoading && !profiles.isLoading;

  // While options/profiles load, show the same header in a plain Modal (no tabs/footer yet);
  // once ready, ResourceForm renders its own Modal so it can own the tabs + footer slots.
  if (!ready) {
    return (
      <Modal
        open
        onClose={onClose}
        icon={<Share2 size={18} />}
        title={duplicate ? 'Duplicate Resource' : resource ? 'Edit Resource' : 'Add Resource'}
        subtitle={duplicate ? `Copy of ${resource?.name || ''}` : resource ? resource.name : 'Add a resource to this network and control which peers can access it.'}
        size="lg"
      >
        <div className="flex justify-center py-10"><Spinner /></div>
      </Modal>
    );
  }

  return (
    <ResourceForm
      networkId={networkId}
      resource={resource}
      duplicate={duplicate}
      initialTab={initialTab}
      opts={opts.data || { canChoose: true, groups: [], defaultIds: [] }}
      profiles={profiles.data || []}
      existingNames={existingNames}
      existingResources={existingResources}
      allowDuplicates={allowDuplicates}
      onClose={onClose}
    />
  );
}

// Only direct (app-managed) policies are editable; inherited ones are shown read-only.
// The full field set round-trips so editing via the shared policy modal loses nothing.
// A duplicate never copies a policy the form can't reproduce exactly - it would be recreated as a
// single Accept rule (a Drop rule would start allowing traffic).
function policiesFromResource(resource: Resource | null, forDuplicate = false): PolicyInput[] {
  return (resource?.policies || []).filter((p) => !p.inherited && !(forDuplicate && p.notReproducible)).map((p) => ({
    sources: (p.sources || []).map((s) => s.id),
    protocol: p.protocol || 'all',
    ports: (p.ports || []).slice(),
    name: p.name || '',
    description: p.description || '',
    enabled: p.enabled !== false,
    bidirectional: !!p.bidirectional,
    postureChecks: (p.postureChecks || []).slice(),
  }));
}

function ResourceForm({ networkId, resource, duplicate, initialTab, opts, profiles, existingNames, existingResources, allowDuplicates, onClose }: {
  networkId: string; resource: Resource | null; duplicate: boolean; initialTab: 'resource' | 'access';
  opts: PolicyOptions; profiles: AccessProfile[]; existingNames: string[]; existingResources: { name: string; address: string }[]; allowDuplicates: boolean; onClose: () => void;
}) {
  // Duplicating: everything initializes from the source resource, but saving CREATES.
  const isEdit = !!resource && !duplicate;
  const appCfg = useAppConfig().data;
  const showGroups = appCfg?.showResourceGroups ?? true;
  // Shared profiles are assignable to the resource (join a group); Direct profiles are
  // protocol/ports presets used inside the policy editor.
  const sharedProfiles = useMemo(() => profiles.filter((p) => p.shared), [profiles]);
  const directProfiles = useMemo(() => profiles.filter((p) => !p.shared), [profiles]);
  const profileGroupIds = useMemo(() => new Set(sharedProfiles.map((p) => p.groupId)), [sharedProfiles]);
  const [tab, setTab] = useState<'resource' | 'access'>(initialTab);
  // A copy starts with a "(copy)" name so it never collides with the source's unique name.
  const [name, setName] = useState(resource ? (duplicate ? `${resource.name || ''} (copy)` : resource.name || '') : '');
  const [address, setAddress] = useState(resource?.address || '');
  const [description, setDescription] = useState(resource?.description || '');
  // Shared access profiles the resource is assigned to (it inherits their policy).
  // New resources start from the network's default profiles; existing ones from their groups.
  const [profileIds, setProfileIds] = useState<number[]>(() => {
    if (resource) {
      return sharedProfiles.filter((p) => (resource.groups || []).some((g) => g.id === p.groupId)).map((p) => p.id);
    }
    const defaults = new Set(opts.defaultProfileIds || []);
    return sharedProfiles.filter((p) => defaults.has(p.id)).map((p) => p.id);
  });
  // Raw resource groups, excluding profile groups (those are managed via the picker above).
  const [groups, setGroups] = useState<string[]>(
    () => (resource?.groups || []).map((g) => g.id).filter((id) => !profileGroupIds.has(id)),
  );
  const inheritedPolicies = useMemo(() => (resource?.policies || []).filter((p) => p.inherited), [resource]);
  const [policies, setPolicies] = useState<PolicyInput[]>(() => policiesFromResource(resource, duplicate));
  // Direct policies this editor can't reproduce: skipped by Duplicate, and changing the list on
  // Edit is refused by the server - both are said up front.
  const lockedPolicies = useMemo(() => (resource?.policies || []).filter((p) => !p.inherited && p.notReproducible), [resource]);
  // Saving REPLACES the resource's policies on the server, so an unchanged list is not sent.
  const [initialPolicies] = useState(() => JSON.stringify(policiesFromResource(resource)));
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [error, setError] = useState('');
  const save = useSaveResource(networkId);

  const groupName = useMemo(() => {
    const m = new Map(opts.groups.map((g) => [g.id, g.name]));
    return (id: string) => m.get(id) || id;
  }, [opts.groups]);

  // Resource names must be unique within a network - check locally for instant feedback.
  const takenNames = useMemo(() => new Set(existingNames.map((n) => n.trim().toLowerCase())), [existingNames]);
  const nameExists = !!name.trim() && takenNames.has(name.trim().toLowerCase());
  // Addresses use a SMART overlap check, not string equality - a host already covered by an
  // existing CIDR (or an intersecting CIDR / wildcard domain) counts as a duplicate too.
  const addressConflict = useMemo(() => {
    const cand = address.trim();
    if (!cand) return null;
    return existingResources.find((r) => r.address && addressesOverlap(cand, r.address)) || null;
  }, [address, existingResources]);
  // Blocks the save only when this network hasn't opted into duplicates; when it HAS,
  // the conflict is still surfaced as an informational note below.
  const addressExists = !!addressConflict && !allowDuplicates;
  const blocklist = useBlocklist().data;
  const blockedBy = address.trim() ? addressBlockedForNetwork(address.trim(), networkId, blocklist || []) : null;
  // The blocklist blocks everyone EXCEPT admins - an admin may knowingly override (audited
  // server-side as blocklist.override), so for them it's a warning, not a hard stop.
  const { isAdmin } = useViewer();
  const blockedHard = !!blockedBy && !isAdmin;

  const policyLabel = name.trim() ? `${name.trim()} Policy` : 'Policy';

  // App-standard table chrome for the staged policies: search, sortable columns (default
  // Name A-Z), rows-per-page + pagination - same as every other table. Rows carry their
  // ORIGINAL index so edit/copy/delete keep working regardless of the display order.
  const [polSearch, setPolSearch] = useState('');
  const polRows = useMemo(() => {
    const q = polSearch.toLowerCase().trim();
    return policies.map((p, i) => ({ p, i })).filter(({ p }) => !q
      || (p.name?.trim() || policyLabel).toLowerCase().includes(q)
      || (p.sources || []).some((gid) => groupName(gid).toLowerCase().includes(q))
      || `${p.protocol} ${(p.ports || []).join(' ')}`.toLowerCase().includes(q));
  }, [policies, polSearch, policyLabel, groupName]);
  const { sorted: polSorted, state: polSort } = useTableSort(polRows, {
    name: ({ p }) => (p.name?.trim() || policyLabel).toLowerCase(),
    sources: ({ p }) => (p.sources || []).map((g) => groupName(g)).join(', ').toLowerCase(),
    ports: ({ p }) => `${p.protocol || 'all'} ${(p.ports || []).join(',')}`,
  }, { key: 'name', dir: 'asc' });
  const polPage = useClientPagination(polSorted, 25, [polSearch]);

  const savePolicy = (p: PolicyInput) => {
    setPolicies((prev) => editing?.index != null ? prev.map((x, i) => (i === editing.index ? p : x)) : [...prev, p]);
    setEditing(null);
  };

  // Copy a staged policy from the row menu / paste one straight into the list - same
  // clipboard format as the policy editor's Copy/Paste, so both directions work.
  const [pasteFlash, setPasteFlash] = useState<'idle' | 'ok' | 'fail'>('idle');
  const flashPaste = (s: 'ok' | 'fail') => { setPasteFlash(s); setTimeout(() => setPasteFlash('idle'), 1500); };
  const copyStagedPolicy = async (p: PolicyInput) => {
    try {
      await writePolicyClipboard({
        name: p.name || '', description: p.description || '', enabled: p.enabled !== false,
        sources: p.sources || [], destinations: [], protocol: p.protocol, ports: p.ports || [],
        bidirectional: !!p.bidirectional, postureChecks: p.postureChecks || [],
      });
    } catch { /* clipboard unavailable */ }
  };
  const pasteStagedPolicy = async () => {
    const p = await readPolicyClipboard();
    if (!p) { flashPaste('fail'); return; }
    const known = (id: string) => opts.groups.some((g) => g.id === id);
    const pastedSources = (p.sources || []).map(String).filter(known);
    // Sources follow the same rules as the editor: fixed networks keep their configured
    // sources; otherwise pasted groups (known here) win, falling back to the defaults.
    const sources = opts.canChoose ? (pastedSources.length ? pastedSources : opts.defaultIds.slice()) : opts.defaultIds.slice();
    setPolicies((prev) => [...prev, {
      sources,
      protocol: typeof p.protocol === 'string' ? p.protocol : 'tcp',
      ports: Array.isArray(p.ports) ? p.ports.map(String).filter(Boolean) : [],
      name: (p.name || '').trim() || policyLabel,
      description: p.description || '',
      enabled: p.enabled !== false,
      bidirectional: !!p.bidirectional,
      postureChecks: Array.isArray(p.postureChecks) ? p.postureChecks.map(String).filter(Boolean) : [],
    }]);
    // Pasted a policy but no usable source groups in this network - open it so they get picked.
    if (!sources.length) setEditing({ index: policies.length });
    flashPaste('ok');
  };

  const submit = async () => {
    if (!name.trim() || !address.trim()) { setError('Name and address are required.'); return; }
    if (nameExists || addressExists) { setTab('resource'); return; }
    if (blockedHard) { setError(`Address is blocked (matches “${blockedBy}” on the blocklist).`); setTab('resource'); return; }
    setError('');
    const profileGids = profileIds.map((id) => sharedProfiles.find((p) => p.id === id)?.groupId).filter(Boolean) as string[];
    const payload = {
      name: name.trim(),
      address: address.trim(),
      description: description.trim(),
      // Keep the current enabled state on edit (a duplicate/new resource starts enabled).
      enabled: isEdit ? resource?.enabled !== false : true,
      groups: [...new Set([...groups, ...profileGids])],
      policies: isEdit && !duplicate && JSON.stringify(policies) === initialPolicies ? undefined : policies.map((p) => ({
        sources: p.sources.slice(),
        protocol: p.protocol,
        ports: p.protocol === 'tcp' || p.protocol === 'udp' ? p.ports.slice() : [],
        name: p.name, description: p.description, enabled: p.enabled,
        bidirectional: p.bidirectional, postureChecks: p.postureChecks,
      })),
    };
    try {
      await save.mutateAsync({ rid: isEdit ? resource?.id : undefined, payload });
      onClose();
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<Share2 size={18} />}
      title={duplicate ? 'Duplicate Resource' : isEdit ? 'Edit Resource' : 'Add Resource'}
      subtitle={duplicate
        ? `A copy of "${resource?.name || ''}" - adjust the name and address, then create.`
        : isEdit ? resource?.name : 'Add a resource to this network and control which peers can access it.'}
      size="lg"
      tabs={
        <Tabs
          bordered={false}
          value={tab}
          onChange={(k) => setTab(k as 'resource' | 'access')}
          items={[
            { key: 'resource', label: <span className="inline-flex items-center gap-2"><Share2 size={15} /> Resource</span> },
            { key: 'access', label: 'Access Control' },
          ]}
        />
      }
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending || nameExists || addressExists || blockedHard}>
            {save.isPending ? '…' : isEdit ? 'Save Changes' : 'Create'}
          </Button>
        </>
      }
    >
      {tab === 'resource' ? (
        <div className="flex flex-col gap-4">
          <Field label="Name" hint="Set an easily identifiable name for your resource">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production Web Server"
              className={nameExists ? '!border-red-500 focus:!border-red-500 focus:!ring-red-500/20' : undefined}
            />
          </Field>
          {nameExists && (
            <p className="-mt-2.5 text-[0.78rem] text-red-500">A resource with this name already exists. Please use another name.</p>
          )}
          <Field label="Address" hint="Enter a single IP Address, CIDR Block or Domain Name.">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. 10.0.0.5, 10.0.0.0/24 or db.example.com"
              className={(blockedHard || addressExists) ? '!border-red-500 focus:!border-red-500 focus:!ring-red-500/20'
                : blockedBy ? '!border-amber-500 focus:!border-amber-500 focus:!ring-amber-500/20' : undefined} />
          </Field>
          {addressConflict && !allowDuplicates && (
            <p className="-mt-2.5 text-[0.78rem] text-red-500">
              {addressConflict.address.trim().toLowerCase() === address.trim().toLowerCase()
                ? 'A resource with this address already exists in this network'
                : 'This address overlaps an existing resource in this network'}
              {': '}“{addressConflict.name || addressConflict.address}” ({addressConflict.address}).
            </p>
          )}
          {addressConflict && allowDuplicates && (
            <p className="-mt-2.5 text-[0.78rem] text-amber-600 dark:text-amber-400">
              Overlaps “{addressConflict.name || addressConflict.address}” ({addressConflict.address}) - allowed, this network permits duplicate addresses.
            </p>
          )}
          {blockedBy && (blockedHard ? (
            <p className="-mt-2.5 text-[0.78rem] text-red-500">This address is blocked (matches “{blockedBy}” on the blocklist) and can’t be used.</p>
          ) : (
            <p className="-mt-2.5 text-[0.78rem] text-amber-600 dark:text-amber-400">
              This address matches “{blockedBy}” on the blocklist. As an admin you can still save it - the override is recorded in the audit log.
            </p>
          ))}
          <Field label="Description (Optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Internal Graylog dashboard" /></Field>

          {/* Always visible - when no Shared profiles exist yet, say so instead of hiding
              the feature (a silently missing field reads as a bug). */}
          <Field
            label="Access Profile (Optional)"
            hint="Assign a shared access profile - the resource inherits its policy automatically, no per-resource policy needed. Manage profiles in Operations → Access Profiles."
          >
            {sharedProfiles.length > 0 ? (
              <GroupMultiSelect
                groups={sharedProfiles.map((p) => ({ id: String(p.id), name: p.name }))}
                value={profileIds.map(String)}
                onChange={(ids) => setProfileIds(ids.map(Number))}
                placeholder="Select access profile(s)…"
              />
            ) : (
              <div className="min-h-[44px] flex items-center rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 px-3 py-2 text-sm text-nb-gray-500">
                No Shared profiles yet - create one in Operations → Access Profiles to assign it here.
              </div>
            )}
          </Field>

          {showGroups && (
            <Field
              label="Resource Groups (Optional)"
              hint="Add this resource to a group (e.g. Databases, Web Servers) to reference it in access policies and simplify management. Optional - access policies target the resource directly."
            >
              <GroupMultiSelect groups={opts.groups} value={groups} onChange={setGroups} placeholder="Add or select group(s)…" />
            </Field>
          )}
        </div>
      ) : (
        <div>
          <div className="text-[0.8rem] font-semibold text-nb-gray-700 dark:text-nb-gray-200">Access Control Policies</div>
          <p className="text-[0.85rem] text-nb-gray-500 dark:text-nb-gray-400 leading-relaxed mt-1">
            Define which source groups are allowed to access this resource. You can also restrict access to specific protocols and ports.
            Without policies access to this resource will not be possible.
          </p>

          {policies.length > 0 && (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                <SearchInput value={polSearch} onChange={setPolSearch} placeholder="Search by name, group or port…" kbd={false} />
                <ToolbarMenu icon={<Rows3 size={15} />} label={`${polPage.perPage} rows per page`} value={String(polPage.perPage)}
                  onChange={(v) => polPage.setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
              </div>
              <div className="mt-3 mb-3 overflow-hidden border border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-920/30 p-1 rounded-md">
                <table className="w-full">
                  <thead>
                    <tr>
                      <SortTh label="Name" sortKey="name" state={polSort} />
                      <SortTh label="Source Groups" sortKey="sources" state={polSort} />
                      <SortTh label="Protocol & Ports" sortKey="ports" state={polSort} />
                      <th className="py-2 px-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {polPage.pageRows.map(({ p, i }) => (
                      <tr key={i} onClick={() => setEditing({ index: i })}
                        className="rounded-md hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900/30 cursor-pointer transition-all">
                        <td className="py-2.5 px-4 align-middle">
                          <div className="flex items-center gap-2 text-[13px] font-medium text-nb-gray-600 dark:text-nb-gray-300 whitespace-nowrap">
                            <span className={cn('h-2 w-2 rounded-full shrink-0', p.enabled === false ? 'bg-nb-gray-400' : 'bg-green-500')} />
                            <span className="truncate max-w-[180px]" title={p.name?.trim() || policyLabel}>{p.name?.trim() || policyLabel}</span>
                            {(p.postureChecks?.length || 0) > 0 && (
                              <span title={`${p.postureChecks!.length} Posture Check${p.postureChecks!.length === 1 ? '' : 's'} attached`}
                                className="inline-flex items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[0.68rem] font-medium text-indigo-500 dark:text-indigo-400">
                                <ShieldCheck size={11} /> {p.postureChecks!.length}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 align-middle"><SourceChips ids={p.sources} name={groupName} /></td>
                        <td className="py-2.5 px-4 align-middle"><ProtoPortsCell protocol={p.protocol} ports={p.ports} /></td>
                        <td className="py-2.5 px-3 align-middle" onClick={(e) => e.stopPropagation()}>
                          <div className="flex justify-end">
                            <RowMenu onEdit={() => setEditing({ index: i })} onCopy={() => copyStagedPolicy(p)}
                              onDelete={() => setPolicies((prev) => prev.filter((_, idx) => idx !== i))} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!polPage.pageRows.length && (
                  <div className="px-4 py-4 text-sm text-nb-gray-500">No policies match your search.</div>
                )}
              </div>
              {polPage.totalPages > 1 && (
                <div className="mb-3">
                  <Pagination page={polPage.page} totalPages={polPage.totalPages} onPage={polPage.setPage} total={polPage.total} label="policies" />
                </div>
              )}
            </>
          )}

          <div className="mt-1 flex gap-2">
            <button onClick={() => setEditing({ index: null })}
              className="flex-1 flex items-center justify-center gap-2 rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:border-netbird hover:text-netbird py-2.5 text-sm font-medium transition-colors">
              <Plus size={14} /> Add Policy
            </button>
            <button onClick={pasteStagedPolicy} title="Paste a copied policy as a new row"
              className="px-5 flex items-center justify-center gap-2 rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:border-netbird hover:text-netbird py-2.5 text-sm font-medium transition-colors">
              {pasteFlash === 'ok' ? <Check size={14} className="text-green-500" />
                : pasteFlash === 'fail' ? <XIcon size={14} className="text-red-500" />
                : <ClipboardPaste size={14} />} Paste
            </button>
          </div>

          {lockedPolicies.length > 0 && (
            <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[0.78rem] text-amber-700 dark:text-amber-400">
              {duplicate ? 'Not copied' : "Can't be changed here"}: {lockedPolicies.map((p) => `"${p.name || p.id}"`).join(', ')} - {lockedPolicies.length === 1 ? 'its rules' : 'their rules'} (several rules, an SSH, Drop or disabled rule) can't be reproduced by this editor.{' '}
              {duplicate
                ? 'Add access for the copy on the Policies page.'
                : 'Edit them on the Policies page - saving a changed policy list here is refused.'}
            </div>
          )}

          {inheritedPolicies.length > 0 && (
            <div className="mt-5">
              <div className="flex items-center gap-1.5 text-[0.72rem] uppercase tracking-wider text-nb-gray-400 font-medium mb-1.5 px-1">
                <Lock size={11} /> Inherited from groups (read-only)
              </div>
              <p className="text-[0.78rem] text-nb-gray-500 mb-2 px-1">
                These policies grant access through a group this resource belongs to. Manage them in Access Control, or remove the resource from the group.
              </p>
              <div className="overflow-hidden border border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-50/60 dark:bg-nb-gray-920/20 p-1 rounded-md">
                <table className="w-full">
                  <tbody>
                    {inheritedPolicies.map((p) => (
                      <tr key={p.id} className="align-middle">
                        <td className="py-2.5 px-4 align-middle">
                          <div className="flex items-center gap-2 text-[13px] font-medium text-nb-gray-600 dark:text-nb-gray-300 whitespace-nowrap">
                            <span className={cn('h-2 w-2 rounded-full shrink-0', p.enabled === false ? 'bg-nb-gray-400' : 'bg-green-500')} />
                            {p.name}
                          </div>
                          {p.viaGroup && <div className="text-[0.7rem] text-nb-gray-500 mt-0.5 ml-4">via {p.viaGroup}</div>}
                        </td>
                        <td className="py-2.5 px-4 align-middle"><SourceChips ids={(p.sources || []).map((s) => s.id)} name={(id) => (p.sources || []).find((s) => s.id === id)?.name || groupName(id)} /></td>
                        <td className="py-2.5 px-4 align-middle"><ProtoPortsCell protocol={p.protocol || 'all'} ports={p.ports || []} /></td>
                        <td className="py-2.5 px-3 align-middle text-right"><Lock size={14} className="text-nb-gray-400 inline" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      {editing && (
        <PolicyModal
          policy={null}
          onClose={() => setEditing(null)}
          staged={{
            initial: editing.index != null ? policies[editing.index] : null,
            resourceName: name.trim() || 'This resource',
            defaultName: policyLabel,
            nameTemplate: appCfg?.policyNameTemplate || '{resource} Policy',
            groups: opts.groups,
            defaultSourceIds: opts.defaultIds,
            canChooseSources: opts.canChoose,
            presets: directProfiles,
            onSave: savePolicy,
          }}
        />
      )}
    </Modal>
  );
}

// Hover popover rendered to a portal so it isn't clipped by the modal's scroll box.
function OverflowPopover({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 352)), top: r.bottom + 6 });
    setOpen(true);
  };
  return (
    <span ref={ref} className="inline-flex" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      {label}
      {open && createPortal(
        <div
          style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1100 }}
          className="max-w-[340px] rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-2xl p-2.5"
        >
          <div className="flex flex-wrap gap-1.5">{children}</div>
        </div>,
        document.body,
      )}
    </span>
  );
}

function SrcChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md text-[0.75rem] py-1 px-2.5 border bg-nb-gray-100 dark:bg-nb-gray-900 border-nb-gray-200 dark:border-nb-gray-800/50 text-nb-gray-600 dark:text-nb-gray-300">
      <Share2 size={11} className="text-nb-blue-500 dark:text-nb-blue-400 shrink-0" />
      <span className="truncate max-w-[160px]">{label}</span>
    </span>
  );
}

function SourceChips({ ids, name }: { ids: string[]; name: (id: string) => string }) {
  if (!ids.length) return <span className="text-nb-gray-500 text-sm">-</span>;
  const shown = ids.slice(0, 3);
  const extra = ids.length - shown.length;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {shown.map((id) => <SrcChip key={id} label={name(id)} />)}
      {extra > 0 && (
        <OverflowPopover label={
          <span className="cursor-default text-[0.75rem] py-1 px-2 rounded-md border bg-nb-gray-100 dark:bg-nb-gray-900 border-nb-gray-200 dark:border-nb-gray-800/50 text-nb-gray-500">+ {extra}</span>
        }>
          {ids.map((id) => <SrcChip key={id} label={name(id)} />)}
        </OverflowPopover>
      )}
    </div>
  );
}

function PortBadge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md text-[0.75rem] py-1 px-3 border uppercase tracking-wider font-medium bg-nb-gray-100 dark:bg-nb-gray-930/60 border-nb-gray-200 dark:border-nb-gray-800/40 text-nb-gray-600 dark:text-nb-gray-300', className)}>
      {children}
    </span>
  );
}

function ProtoPortsCell({ protocol, ports }: { protocol: string; ports: string[] }) {
  const usesPorts = protocol === 'tcp' || protocol === 'udp';
  // Like the official dashboard: protocol + the FIRST port + a "+N" hover popover with the
  // rest - always one compact line, the row-menu column never gets pushed out of the modal.
  const shown = usesPorts ? ports.slice(0, 1) : [];
  const extra = usesPorts ? ports.length - shown.length : 0;
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <PortBadge><Share2 size={12} />{protocol}</PortBadge>
      {!usesPorts || ports.length === 0 ? <PortBadge>All</PortBadge> : (
        <>
          {shown.map((p) => <PortBadge key={p}>{p}</PortBadge>)}
          {extra > 0 && (
            <OverflowPopover label={<PortBadge className="cursor-default">+ {extra}</PortBadge>}>
              {ports.map((p) => <PortBadge key={p}>{p}</PortBadge>)}
            </OverflowPopover>
          )}
        </>
      )}
    </div>
  );
}

function RowMenu({ onEdit, onCopy, onDelete }: { onEdit: () => void; onCopy: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.right - 200, top: r.bottom + 4 });
    setOpen((o) => !o);
  };

  return (
    <>
      <button ref={btnRef} onClick={toggle}
        className="inline-flex items-center justify-center h-8 w-9 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 text-nb-gray-500 hover:text-nb-gray-900 dark:hover:text-nb-gray-100 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
        <MoreVertical size={16} />
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[1090]" onClick={() => setOpen(false)} />
          <div style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1100, minWidth: 200 }}
            className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
            <button onClick={() => { setOpen(false); onEdit(); }}
              className="flex items-center gap-3 w-full px-2.5 py-2 rounded text-sm text-nb-gray-700 dark:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
              <Edit2 size={14} /> Edit Policy
            </button>
            <button onClick={() => { setOpen(false); onCopy(); }}
              className="flex items-center gap-3 w-full px-2.5 py-2 rounded text-sm text-nb-gray-700 dark:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
              <Copy size={14} /> Copy Policy
            </button>
            <button onClick={() => { setOpen(false); onDelete(); }}
              className="flex items-center gap-3 w-full px-2.5 py-2 rounded text-sm text-red-500 hover:bg-red-500/10">
              <Trash2 size={14} /> Delete Policy
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
