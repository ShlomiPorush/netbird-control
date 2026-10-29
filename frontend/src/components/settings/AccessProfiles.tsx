import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Share2, Layers3, ShieldCheck, Rows3 } from 'lucide-react';
import { useAccessProfiles, useGroups, usePostureChecks } from '@/lib/queries';
import { useSaveAccessProfile, useDeleteAccessProfile } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import type { AccessProfile, AccessProfileInput } from '@/lib/types';
import {
  Badge, Button, IconButton, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td,
  Modal, Field, Input, SelectMenu, GroupMultiSelect, PortSelector, SearchInput, Pagination, ClearFiltersButton,
} from '@/components/ui';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { ToolbarMenu } from '@/components/logs/toolbar';

const PROTOCOLS = ['all', 'tcp', 'udp', 'icmp'];

const protoPortsLabel = (p: AccessProfile) =>
  (p.protocol === 'all' || p.protocol === 'icmp' || !p.ports.length) ? 'all' : p.ports.join(', ');

export function AccessProfiles() {
  const { data, isLoading } = useAccessProfiles();
  const del = useDeleteAccessProfile();
  const confirm = useConfirm();
  const [modal, setModal] = useState<{ profile: AccessProfile | null } | null>(null);
  const [search, setSearch] = useState('');
  const profiles = data || [];

  // Standard table chrome (same as every list page): search + sort + client pagination.
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return profiles;
    return profiles.filter((p) => (p.name || '').toLowerCase().includes(q));
  }, [profiles, search]);
  const { sorted, state } = useTableSort(filtered, {
    name: (p) => p.name || '',
    type: (p) => (p.shared ? 'Shared' : 'Direct'),
    sources: (p) => (!p.shared ? '' : p.sources.map((s) => s.name).join(', ')),
    protoPorts: (p) => `${p.protocol} ${protoPortsLabel(p)}`,
    // Direct presets never carry a resource count - sort them below any shared profile.
    resources: (p) => (p.shared ? p.resourceCount : -1),
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25, [search]);

  const onDelete = async (p: AccessProfile) => {
    const ok = await confirm({
      title: 'Delete access profile',
      message: p.shared
        ? `Delete “${p.name}”? Its group and shared policy are removed, and any resources using it lose this access.`
        : `Delete the Direct preset “${p.name}”? Policies already created from it are not affected.`,
      confirmText: 'Delete',
    });
    if (ok) await del.mutateAsync(p.id);
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
        <div>
          <p className="text-nb-gray-500 text-sm max-w-2xl">
            Reusable access definitions. A <b>Shared</b> profile bundles source groups + protocol/ports into one policy that
            many resources inherit - edit once, applies to all. A <b>Direct</b> profile is just a protocol/ports preset used
            when adding a per-resource policy (sources come from the network).
          </p>
        </div>
        <Button variant="primary" onClick={() => setModal({ profile: null })} className="self-start sm:shrink-0"><Plus size={15} /> Add profile</Button>
      </div>

      {isLoading ? <LoadingState /> : !profiles.length ? (
        <EmptyState title="No Access Profiles" hint="Create a profile to share one policy across resources, or a preset for per-resource policies." icon={<Share2 size={22} />} />
      ) : (
        <>
          {/* Standard table chrome: search + rows-per-page, sortable columns, pagination. */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search name…" />
            <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
            <ClearFiltersButton active={!!search} onClear={() => setSearch('')} />
          </div>

          {!sorted.length ? (
            <EmptyState title="No Matching Profiles" hint="Try a different search." icon={<Share2 size={22} />} />
          ) : (
            <>
        <Table>
          <THead>
            <SortTh label="Name" sortKey="name" state={state} />
            <SortTh label="Type" sortKey="type" state={state} />
            <SortTh label="Source Groups" sortKey="sources" state={state} />
            <SortTh label="Protocol &amp; Ports" sortKey="protoPorts" state={state} />
            <SortTh label="Resources" sortKey="resources" state={state} />
            <Th className="text-right">{''}</Th>
          </THead>
          <TBody>
            {pageRows.map((p) => (
              <Tr key={p.id} onClick={() => setModal({ profile: p })}>
                <Td><span className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{p.name}</span></Td>
                <Td>
                  <div className="flex items-center gap-1.5">
                    <Badge tone={p.shared ? 'cyan' : 'gray'}>{p.shared ? 'Shared' : 'Direct'}</Badge>
                    {p.postureChecks?.length > 0 && <Badge tone="orange" icon={<ShieldCheck size={11} />}>{p.postureChecks.length}</Badge>}
                  </div>
                </Td>
                <Td>
                  {!p.shared
                    ? <span className="text-nb-gray-500 text-xs italic">From network</span>
                    : p.sources.length
                      ? <div className="flex flex-wrap gap-1.5">{p.sources.map((s) => <Badge key={s.id} tone="gray" icon={<Share2 size={11} />}>{s.name}</Badge>)}</div>
                      : <span className="text-nb-gray-500 text-xs italic">Any</span>}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <Badge tone="gray" className="uppercase">{p.protocol}</Badge>
                    <Badge tone="gray" className="uppercase">{protoPortsLabel(p)}</Badge>
                  </div>
                </Td>
                <Td>{p.shared ? <Badge tone="gray" icon={<Layers3 size={11} />}>{p.resourceCount}</Badge> : <span className="text-nb-gray-500 text-xs">-</span>}</Td>
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex items-center gap-1.5">
                    <IconButton onClick={() => setModal({ profile: p })} title="Edit"><Pencil size={15} /></IconButton>
                    <IconButton onClick={() => onDelete(p)} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
              <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="profiles" />
            </>
          )}
        </>
      )}

      {modal && <ProfileModal profile={modal.profile} onClose={() => setModal(null)} />}
    </div>
  );
}

function ProfileModal({ profile, onClose }: { profile: AccessProfile | null; onClose: () => void }) {
  const save = useSaveAccessProfile();
  const allGroups = useGroups().data;
  const postureList = usePostureChecks().data || [];
  const groups = useMemo(() => (allGroups || []).map((g) => ({ id: g.id, name: g.name })), [allGroups]);
  const isNew = !profile;
  const [name, setName] = useState(profile?.name || '');
  const [shared, setShared] = useState(profile?.shared ?? true);
  const [sources, setSources] = useState<string[]>(profile?.sources.map((s) => s.id) || []);
  const [protocol, setProtocol] = useState(profile?.protocol || 'all');
  const [ports, setPorts] = useState<string[]>(profile?.ports || []);
  const [posture, setPosture] = useState<string[]>(profile?.postureChecks || []);
  const [error, setError] = useState('');
  const showPorts = protocol === 'tcp' || protocol === 'udp';

  const submit = async () => {
    if (!name.trim()) { setError('Name is required.'); return; }
    setError('');
    const payload: AccessProfileInput = {
      name: name.trim(), shared, sources: shared ? sources : [], protocol, ports: showPorts ? ports : [],
      postureChecks: shared ? posture : [],
    };
    try { await save.mutateAsync({ id: profile?.id, payload }); onClose(); }
    catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<Share2 size={18} />}
      title={profile ? 'Edit Access Profile' : 'Add Access Profile'}
      subtitle={shared ? 'Shared - resources assigned to it inherit one policy.' : 'Direct - a protocol/ports preset for per-resource policies.'}
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending}>{save.isPending ? '…' : 'Save'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={shared ? 'e.g. Clients - ALL' : 'e.g. Common ports'} maxLength={60} /></Field>

        <Field label="Type" hint={isNew ? 'Choose upfront - this can’t change later.' : 'Type cannot be changed after creation.'}>
          <div className="flex gap-2">
            <TypeBtn active={shared} disabled={!isNew} onClick={() => setShared(true)} title="Shared (group)" desc="One policy, inherited by every assigned resource." />
            <TypeBtn active={!shared} disabled={!isNew} onClick={() => setShared(false)} title="Direct (preset)" desc="Protocol/ports only; applied per-resource, sources from the network." />
          </div>
        </Field>

        {shared && (
          <Field label="Source Groups" hint="Who is allowed to access resources assigned to this profile.">
            <GroupMultiSelect groups={groups} value={sources} onChange={setSources} placeholder="Select source groups…" />
          </Field>
        )}

        {shared && postureList.length > 0 && (
          <Field label="Posture Checks (Optional)" hint="Peers must satisfy these checks to access the resources. Manage in Operations → Posture Checks.">
            <GroupMultiSelect
              groups={postureList.map((pc) => ({ id: pc.id, name: pc.name }))}
              value={posture}
              onChange={setPosture}
              placeholder="Attach posture check(s)…"
            />
          </Field>
        )}

        <Field label="Protocol">
          <SelectMenu value={protocol} onChange={(v) => setProtocol(v)} searchable={false}
            options={PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() }))} />
        </Field>
        {showPorts && <Field label="Ports"><PortSelector value={ports} onChange={setPorts} /></Field>}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

function TypeBtn({ active, disabled, onClick, title, desc }: { active: boolean; disabled?: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex-1 text-left rounded-md border px-3 py-2.5 transition-colors',
        active
          ? 'border-netbird bg-netbird/5 text-nb-gray-900 dark:text-nb-gray-50'
          : 'border-nb-gray-200 dark:border-nb-gray-800 text-nb-gray-600 dark:text-nb-gray-300 hover:border-nb-gray-300 dark:hover:border-nb-gray-700',
        disabled && !active ? 'opacity-40 cursor-not-allowed' : '',
        disabled ? 'cursor-default' : 'cursor-pointer',
      ].join(' ')}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="text-[0.72rem] text-nb-gray-500 mt-0.5 leading-snug">{desc}</div>
    </button>
  );
}
