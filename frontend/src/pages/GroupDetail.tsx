import { useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  FolderGit2, Users as UsersIcon, MonitorSmartphone, Layers3,
  ShieldCheck, Route as RouteIcon, Server, Globe, KeyRound, Rows3,
  PlusCircle, MinusCircle, UserPlus, Pencil, Loader2, PowerOff, Repeat, ArrowUpRight,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatMaybeDate } from '@/lib/logfmt';
import { ucLabel, initials, avatarColor } from '@/lib/str';
import { useGroupDetail, usePolicies, useUsers, usePeers } from '@/lib/queries';
import { useSetGroupPeers, useAssignGroupUsers, useRenameGroup, useCreateSetupKey } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useViewer } from '@/contexts/ViewerContext';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import type {
  GroupDetail as GroupDetailT, GroupMemberUser, GroupResourceRef,
  GroupRoute, GroupNameserver, GroupZone, GroupSetupKey, Policy, NbUser, Peer, SetupKeyResult,
} from '@/lib/types';
import { Badge, Breadcrumbs, Button, Checkbox, EmptyState, LoadingState, Modal, SearchInput, Field, Input, Label, FieldHint, CopyButton, Tabs, Table, THead, Th, SortTh, TBody, Tr, Td, Pagination } from '@/components/ui';
import type { TabItem } from '@/components/ui';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { PolicyTable } from '@/components/networks/PolicyTable';
import { PolicyModal } from '@/components/networks/PolicyModal';
import { IssuedChip } from '@/components/groups/IssuedChip';

type Tab = 'users' | 'peers' | 'policies' | 'resources' | 'routes' | 'nameservers' | 'zones' | 'setup-keys';
const TAB_KEYS: Tab[] = ['users', 'peers', 'policies', 'resources', 'routes', 'nameservers', 'zones', 'setup-keys'];

export default function GroupDetail() {
  const { id = '' } = useParams();
  const { tenantAdmin } = useViewer();
  const { data: group, isLoading, isError } = useGroupDetail(id);
  // Deep-linkable tab (?tab=peers) - so a "N Peers" chip elsewhere can open this group on its Peers tab.
  const [params, setParams] = useSearchParams();
  const initialTab = (TAB_KEYS.includes(params.get('tab') as Tab) ? params.get('tab') : 'users') as Tab;
  const [tab, setTab] = useState<Tab>(initialTab);
  const selectTab = (t: Tab) => {
    setTab(t);
    const next = new URLSearchParams(params);
    if (t === 'users') next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: true });
  };

  // All hooks must run before any early return (React error #310 - a conditional hook).
  const [renaming, setRenaming] = useState(false);

  if (isLoading) return <LoadingState label="Loading group…" />;
  if (isError || !group) return <EmptyState title="Group Not Found" hint="This group may no longer exist." />;

  const inUse = TAB_DEFS.some((t) => group[t.countKey] > 0);
  // The "All" group is auto-managed by NetBird (every peer/user is implicitly a member), so its
  // membership can't be edited manually - matching the official dashboard's validAllGroupTabs.
  const canManage = tenantAdmin && group.name !== 'All';
  // Rename: API-created groups only (the "All" group and IdP-issued groups are managed by NetBird).
  const canRename = tenantAdmin && group.name !== 'All' && (group.issued || 'api') === 'api';

  const tabs: TabItem[] = TAB_DEFS.map((t) => {
    const Icon = t.icon;
    return { key: t.key, label: `${group[t.countKey]} ${t.label}`, icon: <Icon size={14} /> };
  });

  return (
    <div>
      <Breadcrumbs items={[
        { label: 'Users & Groups', icon: <FolderGit2 size={14} />, to: '/users?tab=groups' },
        { label: group.name },
      ]} />

      {/* Header */}
      <div className="flex items-center gap-3 md:gap-4 mb-6">
        <span className="grid place-items-center h-10 w-10 md:h-12 md:w-12 rounded-md bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500 shrink-0">
          <FolderGit2 size={20} />
        </span>
        <h1 className="min-w-0 text-xl md:text-2xl font-medium text-nb-gray-800 dark:text-nb-gray-100 flex items-center gap-2.5">
          <span className="truncate">{group.name}</span>
          {canRename && (
            <button onClick={() => setRenaming(true)} title="Rename Group"
              className="shrink-0 text-nb-gray-400 hover:text-nb-gray-700 dark:hover:text-nb-gray-200 transition-colors">
              <Pencil size={16} />
            </button>
          )}
          <IssuedChip issued={group.issued} />
          <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', inUse ? 'bg-green-500' : 'bg-nb-gray-300 dark:bg-nb-gray-700')} title={inUse ? 'In use' : 'Unused'} />
        </h1>
      </div>
      {renaming && <RenameGroupModal id={group.id} current={group.name} onClose={() => setRenaming(false)} />}

      <Tabs items={tabs} value={tab} onChange={(k) => selectTab(k as Tab)} className="mb-5 overflow-x-auto" />

      {tab === 'users' && <GroupUsers group={group} canManage={canManage} />}
      {tab === 'peers' && <GroupPeers group={group} canManage={canManage} />}
      {/* Policies: admins only, hidden for the auto-managed "All" group (canManage). Resources +
          Setup Keys use tenantAdmin directly - both are valid for "All" too. */}
      {tab === 'policies' && <GroupPolicies group={group} canManage={canManage} />}
      {tab === 'resources' && <GroupResources resources={group.resources} canManage={tenantAdmin} />}
      {tab === 'routes' && <GroupRoutes routes={group.routes} />}
      {tab === 'nameservers' && <GroupNameservers nameservers={group.nameservers} />}
      {tab === 'zones' && <GroupZones zones={group.zones} />}
      {tab === 'setup-keys' && <GroupSetupKeys group={group} canManage={tenantAdmin} />}
    </div>
  );
}

const TAB_DEFS: { key: Tab; label: string; icon: typeof UsersIcon; countKey: keyof Pick<GroupDetailT,
  'users_count' | 'peers_count' | 'policies_count' | 'resources_count' | 'routes_count' | 'nameservers_count' | 'zones_count' | 'setup_keys_count'> }[] = [
  { key: 'users', label: 'Users', icon: UsersIcon, countKey: 'users_count' },
  { key: 'peers', label: 'Peers', icon: MonitorSmartphone, countKey: 'peers_count' },
  { key: 'policies', label: 'Policies', icon: ShieldCheck, countKey: 'policies_count' },
  { key: 'resources', label: 'Resources', icon: Layers3, countKey: 'resources_count' },
  { key: 'routes', label: 'Routes', icon: RouteIcon, countKey: 'routes_count' },
  { key: 'nameservers', label: 'Nameservers', icon: Server, countKey: 'nameservers_count' },
  { key: 'zones', label: 'Zones', icon: Globe, countKey: 'zones_count' },
  { key: 'setup-keys', label: 'Setup Keys', icon: KeyRound, countKey: 'setup_keys_count' },
];

function EnabledBadge({ on }: { on: boolean }) {
  return on ? <Badge tone="green">Enabled</Badge> : <Badge tone="gray">Disabled</Badge>;
}

function GroupChips({ items }: { items: string[] }) {
  if (!items.length) return <span className="text-nb-gray-500 text-xs italic">Any</span>;
  return <span className="flex flex-wrap gap-1.5">{items.map((x, i) => <Badge key={i} tone="gray">{x}</Badge>)}</span>;
}

// Standard rows-per-page control shared by the group's tab tables (these tabs have no search,
// so the toolbar carries only the page-size selector - same chrome as every other list page).
function PerPageBar({ perPage, setPerPage }: { perPage: number; setPerPage: (n: number) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 mb-4">
      <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
    </div>
  );
}

// ─── Shared mobile-card primitives (md:hidden) for the tab tables ───
function MobileList({ children }: { children: React.ReactNode }) {
  return <div className="md:hidden flex flex-col gap-2.5">{children}</div>;
}
function DCard({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClick}
      className={cn('rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5',
        onClick && 'cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors')}>
      {children}
    </div>
  );
}
function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-[0.78rem] text-nb-gray-400 dark:text-nb-gray-500">{label}</span>
      <span className="min-w-0 break-all text-right text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200">{children}</span>
    </div>
  );
}

// Semantic status (label + dot colour), mirroring the Users page's UserStatusCell so the group's
// member list reads exactly like the Users table (Active / Invited / Blocked …).
function memberStatus(u: GroupMemberUser): { label: string; dot: string } {
  if (u.is_blocked || (u.status || '').toLowerCase() === 'blocked') return { label: 'Blocked', dot: 'bg-red-500' };
  const s = (u.status || '').toLowerCase();
  if (s === 'invited') return { label: 'Invited', dot: 'bg-yellow-400' };
  if (s === 'active') return { label: 'Active', dot: 'bg-green-500' };
  return { label: u.status || 'Unknown', dot: 'bg-nb-gray-400' };
}

// Avatar + name + email cell (matching the Users page's UserNameCell).
function MemberNameCell({ name, email, id }: { name?: string; email?: string; id: string }) {
  const display = name || email || id;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="grid place-items-center h-9 w-9 rounded-full bg-nb-gray-100 dark:bg-nb-gray-900 text-[0.82rem] font-medium uppercase shrink-0"
        style={{ color: avatarColor(display) }}>
        {initials(display)}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{display}</div>
        {email && name && <div className="text-[0.78rem] text-nb-gray-500 truncate">{email}</div>}
      </div>
    </div>
  );
}

// Toolbar shared by the manageable Users/Peers tabs: an Assign button (left) and the per-page
// selector (right). The bulk "Remove Selected" bar renders separately, above the table.
function ManageToolbar({ assignLabel, onAssign, canManage, perPage, setPerPage }: {
  assignLabel: string; onAssign: () => void; canManage: boolean; perPage: number; setPerPage: (n: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      {canManage ? (
        <Button variant="secondary" onClick={onAssign}><PlusCircle size={15} /> {assignLabel}</Button>
      ) : <span />}
      <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
    </div>
  );
}

// Bulk-selection bar (mirrors the groups list): shows the count + a "Remove Selected" action.
function BulkBar({ count, label, onRemove, onClear, busy }: { count: number; label: string; onRemove: () => void; onClear: () => void; busy: boolean }) {
  if (!count) return null;
  return (
    <div className="flex items-center gap-3 mb-3 px-3 py-2 rounded-md border border-netbird/30 bg-netbird/5">
      <span className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">{count} selected</span>
      <Button variant="danger" size="sm" onClick={onRemove} disabled={busy}>
        <MinusCircle size={14} /> {busy ? 'Removing…' : `Remove ${count} from Group`}
      </Button>
      <button onClick={onClear} className="text-[0.8rem] text-nb-gray-500 hover:underline">Clear</button>
      <span className="ml-1 text-[0.76rem] text-nb-gray-500">{label}</span>
    </div>
  );
}

/* Rename a group (official: the header pencil). API-created groups only - server enforces it too. */
function RenameGroupModal({ id, current, onClose }: { id: string; current: string; onClose: () => void }) {
  const rename = useRenameGroup(id);
  const [name, setName] = useState(current);
  const [error, setError] = useState('');
  const submit = async () => {
    const n = name.trim();
    if (!n || n === current || rename.isPending) return;
    setError('');
    try { await rename.mutateAsync(n); onClose(); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open onClose={onClose} size="sm" icon={<Pencil size={18} />}
      title="Rename Group" subtitle="Give this group a new name."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!name.trim() || name.trim() === current || rename.isPending}>
            {rename.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Developers" autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      </Field>
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
    </Modal>
  );
}

function GroupUsers({ group, canManage }: { group: GroupDetailT; canManage: boolean }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const assign = useAssignGroupUsers();
  const users = group.users;
  const [assigning, setAssigning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const memberIds = useMemo(() => new Set(users.map((u) => u.id)), [users]);

  // Candidate users for the Assign modal - real (non-service) users NOT already in this group.
  const allUsers = useUsers(canManage && assigning).data || [];
  const candidates = useMemo(
    () => allUsers.filter((u) => !u.is_service_user && !memberIds.has(u.id)),
    [allUsers, memberIds],
  );

  const { sorted, state } = useTableSort(users, {
    name: (u) => u.name || u.email, role: (u) => u.role, status: (u) => memberStatus(u).label, last_login: (u) => u.last_login,
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);

  const toggleOne = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pageIds = pageRows.map((u) => u.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected((prev) => {
    const n = new Set(prev);
    if (allOnPage) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id));
    return n;
  });

  const doAssign = async (ids: string[]) => {
    try {
      const res = await assign.mutateAsync({ id: group.id, add: ids });
      setAssigning(false);
      if (res.failed?.length) await confirm({ title: 'Some Users Were Not Assigned', message: res.failed.map((f) => `• ${f.error}`).join('\n'), confirmText: 'OK' });
    } catch (e) { await confirm({ title: 'Assign Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };
  const removeUsers = async (ids: string[], label: string) => {
    const ok = await confirm({ title: `Remove ${label} from Group?`, message: `This removes the group from ${ids.length === 1 ? 'this user' : 'these users'} (their other groups are unchanged). You can add ${ids.length === 1 ? 'them' : 'them'} back later.`, confirmText: 'Remove' });
    if (!ok) return;
    try {
      const res = await assign.mutateAsync({ id: group.id, remove: ids });
      setSelected(new Set());
      if (res.failed?.length) await confirm({ title: 'Some Users Were Not Removed', message: res.failed.map((f) => `• ${f.error}`).join('\n'), confirmText: 'OK' });
    } catch (e) { await confirm({ title: 'Remove Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  if (!users.length) {
    return (
      <>
        <EmptyState title="This Group Has No Assigned Users Yet"
          hint={canManage ? 'Assign existing users to this group to see them listed here.' : 'No users have this group assigned.'} />
        {canManage && (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" onClick={() => setAssigning(true)}><PlusCircle size={15} /> Assign Users</Button>
          </div>
        )}
        {assigning && (
          <AssignModal<NbUser>
            title="Assign Users" subtitle={`Add users to ${group.name}.`} icon={<UserPlus size={18} />}
            items={candidates} confirmLabel="Assign Users" busy={assign.isPending}
            searchText={(u) => `${u.name || ''} ${u.email || ''} ${u.role || ''}`}
            emptyHint="You don't have any users to assign - every user is already in this group."
            renderRow={(u) => <MemberNameCell name={u.name} email={u.email} id={u.id} />}
            onConfirm={doAssign} onClose={() => setAssigning(false)} />
        )}
      </>
    );
  }

  return (
    <>
    <ManageToolbar assignLabel="Assign Users" onAssign={() => setAssigning(true)} canManage={canManage} perPage={perPage} setPerPage={setPerPage} />
    {canManage && <BulkBar count={selected.size} label="user(s)" busy={assign.isPending} onClear={() => setSelected(new Set())} onRemove={() => removeUsers([...selected], `${selected.size} User${selected.size === 1 ? '' : 's'}`)} />}
    <div className="hidden md:block">
    <Table>
      <THead>
        {canManage && <Th className="w-10 pl-2"><Checkbox checked={allOnPage} onChange={toggleAll} /></Th>}
        <SortTh label="Name" sortKey="name" state={state} />
        <SortTh label="Role" sortKey="role" state={state} />
        <SortTh label="Status" sortKey="status" state={state} />
        <Th>Block User</Th>
        <SortTh label="Last Login" sortKey="last_login" state={state} />
        {canManage && <Th className="w-10">{''}</Th>}
      </THead>
      <TBody>
        {pageRows.map((u) => {
          const st = memberStatus(u);
          return (
            <Tr key={u.id} onClick={() => navigate(`/users/${encodeURIComponent(u.id)}`)} className={selected.has(u.id) ? '!bg-netbird/[0.06]' : undefined}>
              {canManage && <Td className="pl-2" onClick={(e) => e.stopPropagation()}><Checkbox checked={selected.has(u.id)} onChange={() => toggleOne(u.id)} /></Td>}
              <Td><MemberNameCell name={u.name} email={u.email} id={u.id} /></Td>
              <Td>{u.role ? <Badge tone="gray">{ucLabel(u.role)}</Badge> : <span className="text-nb-gray-500">-</span>}</Td>
              <Td><span className="inline-flex items-center gap-2 text-sm text-nb-gray-600 dark:text-nb-gray-300"><span className={cn('h-2 w-2 rounded-full', st.dot)} /> {st.label}</span></Td>
              <Td>{u.is_blocked ? <Badge tone="red">Blocked</Badge> : <span className="text-nb-gray-400 dark:text-nb-gray-600 text-sm">-</span>}</Td>
              <Td><span className="text-[0.82rem] text-nb-gray-500">{formatMaybeDate(u.last_login)}</span></Td>
              {canManage && (
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <Button variant="secondary" size="sm" onClick={() => removeUsers([u.id], u.name || u.email || 'User')} disabled={assign.isPending}><MinusCircle size={14} /> Remove</Button>
                </Td>
              )}
            </Tr>
          );
        })}
      </TBody>
    </Table>
    </div>
    <MobileList>
      {pageRows.map((u) => {
        const st = memberStatus(u);
        return (
          <DCard key={u.id} onClick={() => navigate(`/users/${encodeURIComponent(u.id)}`)}>
            <div className="flex items-center gap-2.5">
              {canManage && <span onClick={(e) => e.stopPropagation()}><Checkbox checked={selected.has(u.id)} onChange={() => toggleOne(u.id)} /></span>}
              <div className="min-w-0 flex-1"><MemberNameCell name={u.name} email={u.email} id={u.id} /></div>
              <span className="inline-flex items-center gap-1.5 shrink-0 text-[0.78rem] text-nb-gray-500"><span className={cn('h-2 w-2 rounded-full', st.dot)} /> {st.label}</span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.78rem] text-nb-gray-500">
              {u.role && <Badge tone="gray">{ucLabel(u.role)}</Badge>}
              {u.is_blocked && <Badge tone="red">Blocked</Badge>}
              <span>Last login: {formatMaybeDate(u.last_login)}</span>
              {canManage && <button onClick={(e) => { e.stopPropagation(); removeUsers([u.id], u.name || u.email || 'User'); }} className="ml-auto inline-flex items-center gap-1 text-red-500 hover:underline"><MinusCircle size={13} /> Remove</button>}
            </div>
          </DCard>
        );
      })}
    </MobileList>
    <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="users" />
    {assigning && (
      <AssignModal<NbUser>
        title="Assign Users" subtitle={`Add users to ${group.name}.`} icon={<UserPlus size={18} />}
        items={candidates} confirmLabel="Assign Users" busy={assign.isPending}
        searchText={(u) => `${u.name || ''} ${u.email || ''} ${u.role || ''}`}
        emptyHint="You don't have any users to assign - every user is already in this group."
        renderRow={(u) => <MemberNameCell name={u.name} email={u.email} id={u.id} />}
        onConfirm={doAssign} onClose={() => setAssigning(false)} />
    )}
    </>
  );
}

function GroupPeers({ group, canManage }: { group: GroupDetailT; canManage: boolean }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const setPeers = useSetGroupPeers();
  const peers = group.peers;
  const [assigning, setAssigning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const currentIds = useMemo(() => peers.map((p) => p.id), [peers]);
  const memberIds = useMemo(() => new Set(currentIds), [currentIds]);

  // Candidate peers for the Assign modal - all peers NOT already in this group.
  const allPeers = usePeers(canManage && assigning).data || [];
  const candidates = useMemo(() => allPeers.filter((p) => !memberIds.has(p.id)), [allPeers, memberIds]);

  const { sorted, state } = useTableSort(peers, {
    name: (p) => p.name, address: (p) => p.dns_label || p.ip, os: (p) => p.os, owner: (p) => p.owner_email, last_seen: (p) => p.last_seen,
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);

  const toggleOne = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pageIds = pageRows.map((p) => p.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected((prev) => {
    const n = new Set(prev);
    if (allOnPage) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id));
    return n;
  });

  // Both add and remove send the FULL desired peer id list (NetBird replaces the set).
  const doAssign = async (ids: string[]) => {
    try {
      await setPeers.mutateAsync({ id: group.id, peers: [...new Set([...currentIds, ...ids])] });
      setAssigning(false);
    } catch (e) { await confirm({ title: 'Assign Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };
  const removePeers = async (ids: string[], label: string) => {
    const ok = await confirm({ title: `Remove ${label} from Group?`, message: `This removes ${ids.length === 1 ? 'this peer' : 'these peers'} from the group. You can add ${ids.length === 1 ? 'it' : 'them'} back later.`, confirmText: 'Remove' });
    if (!ok) return;
    const drop = new Set(ids);
    try {
      await setPeers.mutateAsync({ id: group.id, peers: currentIds.filter((pid) => !drop.has(pid)) });
      setSelected(new Set());
    } catch (e) { await confirm({ title: 'Remove Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  if (!peers.length) {
    return (
      <>
        <EmptyState title="This Group Has No Assigned Peers Yet"
          hint={canManage ? 'Assign existing peers to this group to see them listed here.' : 'No peers are assigned here.'} icon={<MonitorSmartphone size={22} />} />
        {canManage && (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" onClick={() => setAssigning(true)}><PlusCircle size={15} /> Assign Peers</Button>
          </div>
        )}
        {assigning && (
          <AssignModal<Peer>
            title="Assign Peers" subtitle={`Add peers to ${group.name}.`} icon={<MonitorSmartphone size={18} />}
            items={candidates} confirmLabel="Assign Peers" busy={setPeers.isPending}
            searchText={(p) => `${p.name || ''} ${p.ip || ''} ${p.owner_email || ''} ${p.os || ''}`}
            emptyHint="You don't have any peers to assign - every peer is already in this group."
            renderRow={(p) => <PeerAssignRow peer={p} />}
            onConfirm={doAssign} onClose={() => setAssigning(false)} />
        )}
      </>
    );
  }

  return (
    <>
    <ManageToolbar assignLabel="Assign Peers" onAssign={() => setAssigning(true)} canManage={canManage} perPage={perPage} setPerPage={setPerPage} />
    {canManage && <BulkBar count={selected.size} label="peer(s)" busy={setPeers.isPending} onClear={() => setSelected(new Set())} onRemove={() => removePeers([...selected], `${selected.size} Peer${selected.size === 1 ? '' : 's'}`)} />}
    <div className="hidden md:block">
    <Table>
      <THead>
        {canManage && <Th className="w-10 pl-2"><Checkbox checked={allOnPage} onChange={toggleAll} /></Th>}
        <SortTh label="Name" sortKey="name" state={state} />
        <SortTh label="Address" sortKey="address" state={state} />
        <SortTh label="OS" sortKey="os" state={state} />
        <SortTh label="Owner" sortKey="owner" state={state} />
        <SortTh label="Last Seen" sortKey="last_seen" state={state} />
        {canManage && <Th className="w-10">{''}</Th>}
      </THead>
      <TBody>
        {pageRows.map((p) => (
          <Tr key={p.id} onClick={() => navigate(`/peers/${encodeURIComponent(p.id)}`)} className={selected.has(p.id) ? '!bg-netbird/[0.06]' : undefined}>
            {canManage && <Td className="pl-2" onClick={(e) => e.stopPropagation()}><Checkbox checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} /></Td>}
            <Td>
              <div className="flex items-center gap-2.5">
                <span className={cn('h-2 w-2 rounded-full shrink-0', p.connected ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
                <span className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate">{p.name || '-'}</span>
              </div>
            </Td>
            <Td>
              <div className="min-w-0">
                {p.dns_label && <div className="text-sm text-nb-gray-700 dark:text-nb-gray-300 truncate">{p.dns_label}</div>}
                <div className="text-[0.78rem] font-mono text-nb-gray-500">{p.ip || '-'}</div>
              </div>
            </Td>
            <Td>
              <div className="text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">{p.os || '-'}</div>
              {p.version && <div className="text-[0.72rem] text-nb-gray-500">{p.version}</div>}
            </Td>
            <Td><span className="text-sm text-nb-gray-600 dark:text-nb-gray-400">{p.owner_email || '-'}</span></Td>
            <Td><span className="text-[0.82rem] text-nb-gray-500">{p.connected ? 'Connected' : formatMaybeDate(p.last_seen)}</span></Td>
            {canManage && (
              <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                <Button variant="secondary" size="sm" onClick={() => removePeers([p.id], p.name || 'Peer')} disabled={setPeers.isPending}><MinusCircle size={14} /> Remove</Button>
              </Td>
            )}
          </Tr>
        ))}
      </TBody>
    </Table>
    </div>
    <MobileList>
      {pageRows.map((p) => (
        <DCard key={p.id} onClick={() => navigate(`/peers/${encodeURIComponent(p.id)}`)}>
          <div className="flex items-center gap-2.5">
            {canManage && <span onClick={(e) => e.stopPropagation()}><Checkbox checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} /></span>}
            <span className={cn('h-2 w-2 rounded-full shrink-0', p.connected ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
            <span className="flex-1 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{p.name || '-'}</span>
            <span className="shrink-0 text-[0.78rem] text-nb-gray-500">{p.connected ? 'Connected' : formatMaybeDate(p.last_seen)}</span>
          </div>
          {(p.dns_label || p.ip) && (
            <div className="mt-2 flex flex-col gap-0.5 text-[0.82rem]">
              {p.dns_label && <div className="text-nb-gray-700 dark:text-nb-gray-300 break-all">{p.dns_label}</div>}
              <div className="font-mono text-nb-gray-500 break-all">{p.ip || '-'}</div>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.8rem] text-nb-gray-500">
            <span className="text-nb-gray-600 dark:text-nb-gray-300">{p.os || '-'}</span>
            {p.owner_email && <span className="break-all">· {p.owner_email}</span>}
            {canManage && <button onClick={(e) => { e.stopPropagation(); removePeers([p.id], p.name || 'Peer'); }} className="ml-auto inline-flex items-center gap-1 text-red-500 hover:underline"><MinusCircle size={13} /> Remove</button>}
          </div>
        </DCard>
      ))}
    </MobileList>
    <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="peers" />
    {assigning && (
      <AssignModal<Peer>
        title="Assign Peers" subtitle={`Add peers to ${group.name}.`} icon={<MonitorSmartphone size={18} />}
        items={candidates} confirmLabel="Assign Peers" busy={setPeers.isPending}
        searchText={(p) => `${p.name || ''} ${p.ip || ''} ${p.owner_email || ''} ${p.os || ''}`}
        emptyHint="You don't have any peers to assign - every peer is already in this group."
        renderRow={(p) => <PeerAssignRow peer={p} />}
        onConfirm={doAssign} onClose={() => setAssigning(false)} />
    )}
    </>
  );
}

// Compact peer row for the Assign Peers modal - connection dot + name, address, owner.
function PeerAssignRow({ peer }: { peer: Peer }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className={cn('h-2 w-2 rounded-full shrink-0', peer.connected ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{peer.name || '-'}</div>
        <div className="text-[0.78rem] text-nb-gray-500 truncate">
          <span className="font-mono">{peer.ip || '-'}</span>{peer.owner_email ? ` · ${peer.owner_email}` : ''}
        </div>
      </div>
    </div>
  );
}

// Generic multi-select modal used by both "Assign Users" and "Assign Peers": a searchable,
// scrollable checkbox list of candidates (those NOT already in the group), then Assign.
function AssignModal<T extends { id: string }>({
  title, subtitle, icon, items, searchText, renderRow, onConfirm, onClose, confirmLabel, busy, emptyHint,
}: {
  title: string; subtitle: string; icon: React.ReactNode; items: T[];
  searchText: (i: T) => string; renderRow: (i: T) => React.ReactNode;
  onConfirm: (ids: string[]) => void; onClose: () => void; confirmLabel: string; busy: boolean; emptyHint: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return q ? items.filter((i) => searchText(i).toLowerCase().includes(q)) : items;
  }, [items, search, searchText]);
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <Modal open onClose={onClose} icon={icon} title={title} subtitle={subtitle} size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!selected.size || busy} onClick={() => onConfirm([...selected])}>
            <PlusCircle size={15} /> {busy ? 'Assigning…' : `${confirmLabel}${selected.size ? ` (${selected.size})` : ''}`}
          </Button>
        </>
      }>
      {items.length === 0 ? (
        <EmptyState title="Nothing to Assign" hint={emptyHint} />
      ) : (
        <div className="flex flex-col gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search…" />
          <div className="nb-scroll flex flex-col gap-1 max-h-[46vh] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-nb-gray-500">No matches.</div>
            ) : filtered.map((i) => (
              <button type="button" key={i.id} onClick={() => toggle(i.id)}
                className={cn('flex items-center gap-3 w-full text-left px-2.5 py-2 rounded-md border transition-colors',
                  selected.has(i.id) ? 'border-netbird/40 bg-netbird/[0.06]' : 'border-transparent hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900')}>
                <span onClick={(e) => e.stopPropagation()}><Checkbox checked={selected.has(i.id)} onChange={() => toggle(i.id)} /></span>
                <div className="min-w-0 flex-1">{renderRow(i)}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function GroupPolicies({ group, canManage }: { group: GroupDetailT; canManage: boolean }) {
  const policies = group.policies;
  // Clicking a policy opens the full policy editor (same modal as the Policies page) - the group
  // detail carries a summary, so resolve the full policy (with rules) from the policies list.
  const all = usePolicies().data || [];
  const [editing, setEditing] = useState<Policy | null>(null);
  // "Add Policy" opens the SAME create modal as the Policies page, but with THIS group prefilled
  // as the policy source (initialSources). Saving creates a standalone access-control policy;
  // useSavePolicy invalidates ['policies'] + ['group-detail'], so the new row appears here.
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        {canManage ? (
          <Button variant="secondary" onClick={() => setCreating(true)}><PlusCircle size={15} /> Add Policy</Button>
        ) : <span />}
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
      </div>
      <PolicyTable
        policies={policies}
        emptyHint={canManage
          ? 'No access-control policy references this group yet. Use Add Policy to create one with this group as the source.'
          : 'No access-control policy references this group.'}
        onRowClick={(row) => {
          const p = all.find((x) => (x.id || x.name) === row.id);
          if (p) setEditing(p);
        }}
        pagination={{ page, perPage, onPage: setPage, label: 'policies' }}
      />
      {editing && <PolicyModal policy={editing} onClose={() => setEditing(null)} />}
      {creating && <PolicyModal policy={null} initialSources={[group.id]} onClose={() => setCreating(false)} />}
    </>
  );
}

function GroupResources({ resources, canManage }: { resources: GroupResourceRef[]; canManage: boolean }) {
  const navigate = useNavigate();
  const { sorted, state } = useTableSort(resources, {
    name: (r) => r.name || r.id, type: (r) => r.type, address: (r) => r.address, network: (r) => r.network_name, status: (r) => (r.enabled !== false ? 1 : 0),
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);
  // Clicking a resource opens it in its network (same modal as the network's Resources tab).
  const openResource = (r: GroupResourceRef) => {
    if (r.network_id) navigate(`/networks/${encodeURIComponent(r.network_id)}?tab=resources&resource=${encodeURIComponent(r.id)}`);
  };
  // Resources are created INSIDE a network (a resource always belongs to one), so - mirroring the
  // official dashboard - "Create Resource" routes to the Networks page rather than opening a modal here.
  const createResource = () => navigate('/networks');
  if (!resources.length) {
    return (
      <>
        <EmptyState title="No Resources" hint="No network resources are assigned to this group." icon={<Layers3 size={22} />} />
        {canManage && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <Button variant="secondary" onClick={createResource}><PlusCircle size={15} /> Create Resource</Button>
            <p className="text-[0.78rem] text-nb-gray-500">Resources are created inside a network - assign this group there.</p>
          </div>
        )}
      </>
    );
  }
  return (
    <>
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      {canManage ? (
        <Button variant="secondary" onClick={createResource}><PlusCircle size={15} /> Create Resource <ArrowUpRight size={14} /></Button>
      ) : <span />}
      <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
    </div>
    <div className="hidden md:block">
    <Table>
      <THead>
        <SortTh label="Name" sortKey="name" state={state} />
        <SortTh label="Type" sortKey="type" state={state} />
        <SortTh label="Address" sortKey="address" state={state} />
        <SortTh label="Network" sortKey="network" state={state} />
        <SortTh label="Status" sortKey="status" state={state} />
      </THead>
      <TBody>
        {pageRows.map((r) => (
          <Tr key={r.id} onClick={r.network_id ? () => openResource(r) : undefined}>
            <Td><span className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{r.name || <span className="font-mono text-[0.78rem] text-nb-gray-500">{r.id}</span>}</span></Td>
            <Td><Badge tone="gray" icon={<Layers3 size={11} />}>{(r.type || 'resource').replace(/_/g, ' ')}</Badge></Td>
            <Td><span className="font-mono text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">{r.address || '-'}</span></Td>
            <Td><span className="text-sm text-nb-gray-600 dark:text-nb-gray-400">{r.network_name || '-'}</span></Td>
            <Td><EnabledBadge on={r.enabled !== false} /></Td>
          </Tr>
        ))}
      </TBody>
    </Table>
    </div>
    <MobileList>
      {pageRows.map((r) => (
        <DCard key={r.id} onClick={r.network_id ? () => openResource(r) : undefined}>
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 break-words">{r.name || <span className="font-mono text-[0.78rem] text-nb-gray-500">{r.id}</span>}</span>
            <span className="shrink-0"><EnabledBadge on={r.enabled !== false} /></span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="gray" icon={<Layers3 size={11} />}>{(r.type || 'resource').replace(/_/g, ' ')}</Badge>
          </div>
          <div className="mt-2 font-mono text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300 break-all">{r.address || '-'}</div>
          {r.network_name && <div className="mt-1.5"><KV label="Network">{r.network_name}</KV></div>}
        </DCard>
      ))}
    </MobileList>
    <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="resources" />
    </>
  );
}

function GroupRoutes({ routes }: { routes: GroupRoute[] }) {
  const { sorted, state } = useTableSort(routes, {
    network_id: (r) => r.network_id, network: (r) => r.network, metric: (r) => r.metric, masquerade: (r) => (r.masquerade ? 1 : 0), status: (r) => (r.enabled ? 1 : 0),
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);
  if (!routes.length) return <EmptyState title="No Network Routes" hint="No route references this group. Assign this group when creating a network route." icon={<RouteIcon size={22} />} />;
  return (
    <>
    <PerPageBar perPage={perPage} setPerPage={setPerPage} />
    <div className="hidden md:block">
    <Table>
      <THead>
        <SortTh label="Network ID" sortKey="network_id" state={state} />
        <SortTh label="Network / Domains" sortKey="network" state={state} />
        <SortTh label="Metric" sortKey="metric" state={state} />
        <SortTh label="Masquerade" sortKey="masquerade" state={state} />
        <SortTh label="Status" sortKey="status" state={state} />
      </THead>
      <TBody>
        {pageRows.map((r) => (
          <Tr key={r.id}>
            <Td>
              <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{r.network_id || '-'}</div>
              {r.description && <div className="text-[0.72rem] text-nb-gray-500">{r.description}</div>}
            </Td>
            <Td><span className="font-mono text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">{r.network || '-'}</span></Td>
            <Td><span className="font-mono text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">{r.metric ?? '-'}</span></Td>
            <Td>{r.masquerade ? <Badge tone="green">On</Badge> : <Badge tone="gray">Off</Badge>}</Td>
            <Td><EnabledBadge on={r.enabled} /></Td>
          </Tr>
        ))}
      </TBody>
    </Table>
    </div>
    <MobileList>
      {pageRows.map((r) => (
        <DCard key={r.id}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 break-all">{r.network_id || '-'}</div>
              {r.description && <div className="mt-0.5 text-[0.72rem] text-nb-gray-500 break-words">{r.description}</div>}
            </div>
            <span className="shrink-0"><EnabledBadge on={r.enabled} /></span>
          </div>
          <div className="mt-2.5 flex flex-col gap-1">
            <KV label="Network / Domains"><span className="font-mono">{r.network || '-'}</span></KV>
            <KV label="Metric"><span className="font-mono">{r.metric ?? '-'}</span></KV>
            <KV label="Masquerade">{r.masquerade ? 'On' : 'Off'}</KV>
          </div>
        </DCard>
      ))}
    </MobileList>
    <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="routes" />
    </>
  );
}

function GroupNameservers({ nameservers }: { nameservers: GroupNameserver[] }) {
  const { sorted, state } = useTableSort(nameservers, { name: (ns) => ns.name, status: (ns) => (ns.enabled ? 1 : 0) });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);
  if (!nameservers.length) return <EmptyState title="No Nameservers" hint="No nameserver group references this group. Assign this group when creating a nameserver." icon={<Server size={22} />} />;
  return (
    <>
    <PerPageBar perPage={perPage} setPerPage={setPerPage} />
    <div className="hidden md:block">
    <Table>
      <THead>
        <SortTh label="Name" sortKey="name" state={state} />
        <Th>Nameservers</Th>
        <Th>Domains</Th>
        <SortTh label="Status" sortKey="status" state={state} />
      </THead>
      <TBody>
        {pageRows.map((ns) => (
          <Tr key={ns.id}>
            <Td>
              <div className="flex items-center gap-2 text-sm text-nb-gray-800 dark:text-nb-gray-200">
                {ns.name || '-'}{ns.primary && <Badge tone="cyan">Primary</Badge>}
              </div>
            </Td>
            <Td><span className="font-mono text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">{ns.nameservers.join(', ') || '-'}</span></Td>
            <Td>{ns.domains.length ? <GroupChips items={ns.domains} /> : <span className="text-nb-gray-500 text-xs italic">All domains</span>}</Td>
            <Td><EnabledBadge on={ns.enabled} /></Td>
          </Tr>
        ))}
      </TBody>
    </Table>
    </div>
    <MobileList>
      {pageRows.map((ns) => (
        <DCard key={ns.id}>
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 flex items-center gap-2 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 break-words">
              {ns.name || '-'}{ns.primary && <Badge tone="cyan">Primary</Badge>}
            </span>
            <span className="shrink-0"><EnabledBadge on={ns.enabled} /></span>
          </div>
          <div className="mt-2 font-mono text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300 break-all">{ns.nameservers.join(', ') || '-'}</div>
          <div className="mt-2 flex items-start justify-between gap-3">
            <span className="shrink-0 text-[0.78rem] text-nb-gray-400 dark:text-nb-gray-500">Domains</span>
            <span className="min-w-0 text-right">{ns.domains.length ? <GroupChips items={ns.domains} /> : <span className="text-nb-gray-500 text-xs italic">All domains</span>}</span>
          </div>
        </DCard>
      ))}
    </MobileList>
    <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="nameservers" />
    </>
  );
}

function GroupZones({ zones }: { zones: GroupZone[] }) {
  const { sorted, state } = useTableSort(zones, { name: (z) => z.name, domain: (z) => z.domain, status: (z) => (z.enabled ? 1 : 0) });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);
  if (!zones.length) return <EmptyState title="No DNS Zones" hint="No DNS zone is distributed to this group. Assign this group when creating a DNS zone." icon={<Globe size={22} />} />;
  return (
    <>
    <PerPageBar perPage={perPage} setPerPage={setPerPage} />
    <div className="hidden md:block">
    <Table>
      <THead>
        <SortTh label="Name" sortKey="name" state={state} />
        <SortTh label="Domain" sortKey="domain" state={state} />
        <SortTh label="Status" sortKey="status" state={state} />
      </THead>
      <TBody>
        {pageRows.map((z) => (
          <Tr key={z.id}>
            <Td><span className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{z.name || '-'}</span></Td>
            <Td><span className="font-mono text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">{z.domain || '-'}</span></Td>
            <Td><EnabledBadge on={z.enabled} /></Td>
          </Tr>
        ))}
      </TBody>
    </Table>
    </div>
    <MobileList>
      {pageRows.map((z) => (
        <DCard key={z.id}>
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 break-words">{z.name || '-'}</span>
            <span className="shrink-0"><EnabledBadge on={z.enabled} /></span>
          </div>
          <div className="mt-2 font-mono text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300 break-all">{z.domain || '-'}</div>
        </DCard>
      ))}
    </MobileList>
    <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="zones" />
    </>
  );
}

function setupKeyTone(k: GroupSetupKey): { label: string; tone: 'green' | 'red' | 'gray' } {
  if (k.revoked) return { label: 'Revoked', tone: 'red' };
  if (!k.valid) return { label: k.state || 'Expired', tone: 'gray' };
  return { label: k.state || 'Valid', tone: 'green' };
}

function GroupSetupKeys({ group, canManage }: { group: GroupDetailT; canManage: boolean }) {
  const setupKeys = group.setupKeys;
  const [adding, setAdding] = useState(false);
  const { sorted, state } = useTableSort(setupKeys, {
    name: (k) => k.name, status: (k) => setupKeyTone(k).label, type: (k) => k.type, usage: (k) => k.used_times, expires: (k) => k.expires,
  });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25);
  if (!setupKeys.length) {
    return (
      <>
        <EmptyState title="No Setup Keys" hint="No setup key auto-assigns this group." icon={<KeyRound size={22} />} />
        {canManage && (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" onClick={() => setAdding(true)}><PlusCircle size={15} /> Add Setup Key</Button>
          </div>
        )}
        {adding && <SetupKeyCreateModal group={group} onClose={() => setAdding(false)} />}
      </>
    );
  }
  return (
    <>
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      {canManage ? (
        <Button variant="secondary" onClick={() => setAdding(true)}><PlusCircle size={15} /> Add Setup Key</Button>
      ) : <span />}
      <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
    </div>
    <div className="hidden md:block">
    <Table>
      <THead>
        <SortTh label="Name" sortKey="name" state={state} />
        <SortTh label="State" sortKey="status" state={state} />
        <SortTh label="Type" sortKey="type" state={state} />
        <SortTh label="Usage" sortKey="usage" state={state} />
        <SortTh label="Expires" sortKey="expires" state={state} />
      </THead>
      <TBody>
        {pageRows.map((k) => {
          const st = setupKeyTone(k);
          return (
            <Tr key={k.id}>
              <Td>
                <div className="flex items-center gap-2 text-sm text-nb-gray-800 dark:text-nb-gray-200">
                  {k.name || '-'}{k.ephemeral && <Badge tone="gray">Ephemeral</Badge>}
                </div>
              </Td>
              <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
              <Td><Badge tone="gray">{(k.type || 'reusable').replace(/_/g, ' ')}</Badge></Td>
              <Td><span className="font-mono text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">{k.used_times}{k.usage_limit ? ` / ${k.usage_limit}` : ''}</span></Td>
              <Td><span className="text-[0.82rem] text-nb-gray-500">{formatMaybeDate(k.expires || undefined)}</span></Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
    </div>
    <MobileList>
      {pageRows.map((k) => {
        const st = setupKeyTone(k);
        return (
          <DCard key={k.id}>
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 flex items-center gap-2 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 break-words">
                {k.name || '-'}{k.ephemeral && <Badge tone="gray">Ephemeral</Badge>}
              </span>
              <span className="shrink-0"><Badge tone={st.tone}>{st.label}</Badge></span>
            </div>
            <div className="mt-2.5 flex flex-col gap-1">
              <div className="flex items-start justify-between gap-3">
                <span className="shrink-0 text-[0.78rem] text-nb-gray-400 dark:text-nb-gray-500">Type</span>
                <Badge tone="gray">{(k.type || 'reusable').replace(/_/g, ' ')}</Badge>
              </div>
              <KV label="Usage"><span className="font-mono">{k.used_times}{k.usage_limit ? ` / ${k.usage_limit}` : ''}</span></KV>
              <KV label="Expires">{formatMaybeDate(k.expires || undefined)}</KV>
            </div>
          </DCard>
        );
      })}
    </MobileList>
    <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="setup keys" />
    {adding && <SetupKeyCreateModal group={group} onClose={() => setAdding(false)} />}
    </>
  );
}

// Small toggle switch (mirrors the official FancyToggleSwitch look) for the setup-key modal's
// reusable / ephemeral / extra-DNS options.
function SwitchRow({ checked, onChange, icon, label, hint }: {
  checked: boolean; onChange: (v: boolean) => void; icon: React.ReactNode; label: string; hint: string;
}) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className="flex items-center justify-between gap-4 w-full text-left rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">{icon} {label}</div>
        <p className="mt-0.5 text-[0.78rem] text-nb-gray-500">{hint}</p>
      </div>
      <span className={cn('relative h-6 w-11 rounded-full transition-colors shrink-0', checked ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700')}>
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

// Create a setup key scoped to THIS group: the key's auto_groups is fixed to the group, so any
// peer enrolled with it auto-joins here. Mirrors the official SetupKeyModal fields (Name, Reusable,
// Usage limit, Expires in days, Ephemeral, Allow extra DNS labels). The plaintext key is shown once
// (copy) and never re-fetched. The "All" group is implicit for every peer and can't be a setup-key
// auto-group, so a key created from "All" carries no auto_groups (it still works - every peer is in All).
function SetupKeyCreateModal({ group, onClose }: { group: GroupDetailT; onClose: () => void }) {
  const create = useCreateSetupKey();
  const isAll = group.name === 'All';
  const [name, setName] = useState('');
  const [reusable, setReusable] = useState(false);
  const [usageLimit, setUsageLimit] = useState('');
  const [expiresIn, setExpiresIn] = useState('7');
  const [ephemeral, setEphemeral] = useState(false);
  const [allowExtraDns, setAllowExtraDns] = useState(false);
  const [result, setResult] = useState<SetupKeyResult | null>(null);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim() || create.isPending) return;
    setError('');
    try {
      const key = await create.mutateAsync({
        name: name.trim(),
        type: reusable ? 'reusable' : 'one-off',
        expiresInDays: expiresIn.trim() === '' ? 0 : Number(expiresIn),
        usageLimit: reusable ? (usageLimit.trim() === '' ? 0 : Number(usageLimit)) : 1,
        ephemeral,
        autoGroups: isAll ? [] : [group.id],
        allowExtraDnsLabels: allowExtraDns,
      });
      setResult(key);
    } catch (e) { setError((e as Error).message || 'Failed to create the setup key.'); }
  };

  return (
    <Modal open onClose={onClose} size="lg" icon={<KeyRound size={18} />}
      title={result ? 'Setup Key Created' : 'Create Setup Key'}
      subtitle={result
        ? 'This key is shown only once - copy it and store it securely.'
        : isAll
          ? 'Register new machines in your network. Every peer is implicitly in the "All" group.'
          : `Peers enrolled with this key auto-join the "${group.name}" group.`}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={!name.trim() || create.isPending}>
              {create.isPending ? <Loader2 size={15} className="animate-spin" /> : <PlusCircle size={15} />}
              {create.isPending ? 'Creating…' : 'Create Setup Key'}
            </Button>
          </div>
        )
      }>
      {result ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-nb-gray-200 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-930/40 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-nb-gray-800 dark:text-nb-gray-100"><KeyRound size={12} /> {result.name || name.trim()}</div>
              <div className="mt-0.5 break-all font-mono text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300">{result.key}</div>
            </div>
            <CopyButton value={result.key} className="shrink-0" size={15} title="Copy Setup Key" />
          </div>
          <p className="text-[0.78rem] text-nb-gray-500">Store this key securely - it will not be shown again.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <Field label="Name">
            <FieldHint>Set an easily identifiable name for your key.</FieldHint>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., AWS Servers" autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          </Field>

          <SwitchRow checked={reusable} onChange={setReusable} icon={<Repeat size={15} />}
            label="Make This Key Reusable" hint="Use this type to enroll multiple peers." />

          <div className={cn('flex items-end justify-between gap-4', !reusable && 'opacity-50')}>
            <div className="min-w-0">
              <Label>Usage Limit</Label>
              <FieldHint>For example, set to 30 to enroll 30 peers.</FieldHint>
            </div>
            <Input type="number" min={1} disabled={!reusable} value={usageLimit} className="max-w-[200px]"
              onChange={(e) => setUsageLimit(e.target.value)} placeholder={reusable ? 'Unlimited' : '1'} />
          </div>

          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <Label>Expires In</Label>
              <FieldHint>Days until the key expires. Leave empty for no expiration.</FieldHint>
            </div>
            <Input type="number" min={1} value={expiresIn} className="max-w-[200px]"
              onChange={(e) => setExpiresIn(e.target.value)} placeholder="Unlimited" />
          </div>

          <SwitchRow checked={ephemeral} onChange={setEphemeral} icon={<PowerOff size={15} />}
            label="Ephemeral Peers" hint="Peers offline for over 10 minutes are removed automatically." />

          <SwitchRow checked={allowExtraDns} onChange={setAllowExtraDns} icon={<Globe size={15} />}
            label="Allow Extra DNS Labels" hint="Enable multiple subdomain labels when enrolling peers." />

          {!isAll && (
            <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-4 py-3">
              <Label>Auto-Assigned Group</Label>
              <div className="mt-1.5"><Badge tone="gray" icon={<FolderGit2 size={11} />}>{group.name}</Badge></div>
              <FieldHint>Peers enrolled with this key are automatically added to this group.</FieldHint>
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
