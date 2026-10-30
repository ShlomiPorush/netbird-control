import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Rows3, FolderGit2, Layers3, Users as UsersIcon, MonitorSmartphone, ShieldCheck, Route as RouteIcon, Server, Globe, KeyRound, Trash2, Filter, ChevronsUpDown, ChevronRight, Activity, UserPlus, Mail, User as UserIcon, Eye, Network as NetworkIcon, Cog, RefreshCw, Plus, Star, Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useUsers, useGroups, useInviteDefaultGroups } from '@/lib/queries';
import { useDeleteGroup, useBulkDeleteGroups, useInviteUser, useCreateGroup, useNetbirdRefresh, useSaveInviteDefaultGroups, useDeleteUser } from '@/lib/mutations';
import { useQueryClient } from '@tanstack/react-query';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useViewer } from '@/contexts/ViewerContext';
import { useTableSort } from '@/lib/useTableSort';
import { formatMaybeDate } from '@/lib/logfmt';
import { initials, avatarColor, ucLabel } from '@/lib/str';
import type { NbUser, NbGroup, GroupRef } from '@/lib/types';
import { SearchInput, Badge, Button, IconButton, Checkbox, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td, PageHeader, Pagination, RowMenu, MenuItem, HoverCard, PillTabs, Modal, Field, FieldHint, Input, SelectMenu, GroupMultiSelect } from '@/components/ui';
import { ToolbarMenu } from '@/components/logs/toolbar';
import { ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { IssuedChip } from '@/components/groups/IssuedChip';
import { ResendInviteButton } from '@/components/users/ResendInviteButton';

type Tab = 'users' | 'groups';

export default function Users() {
  const [params, setParams] = useSearchParams();
  const { tenantAdmin } = useViewer();
  const [inviting, setInviting] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const tab: Tab = params.get('tab') === 'groups' ? 'groups' : 'users';
  const setTab = (t: Tab) => setParams(t === 'groups' ? { tab: 'groups' } : {}, { replace: true });
  const tabs: { key: Tab; label: string }[] = [
    { key: 'users', label: 'Users' },
    { key: 'groups', label: 'Groups' },
  ];

  // Count of the active tab → "105 Users" / "12 Groups" title, like NetBird. Only the
  // active tab's list is fetched here (the other is disabled to avoid extra load).
  const usersCount = useUsers(tab === 'users').data?.length;
  const groupsCount = useGroups(tab === 'groups').data?.length;
  const count = tab === 'users' ? usersCount : groupsCount;
  const noun = tab === 'users' ? 'Users' : 'Groups';
  const description = tab === 'users'
    ? 'Manage users and their permissions. Same-domain email users are added automatically on first sign-in.'
    : 'Organize peers, users and resources into groups to manage access.';

  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm mb-3 text-nb-gray-400">
        <UsersIcon size={14} /> Users & Groups
        <span className="text-nb-gray-300 dark:text-nb-gray-700">›</span> {noun}
      </div>

      {/* Primary action sits beside the page title, as on the Networks / Policies pages.
          Inviting works in MSP tenant mode too - the API call carries the tenant context. */}
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title={count != null ? `${count} ${noun}` : noun}
          description={description}
        />
        {tab === 'users' && tenantAdmin && (
          <Button variant="primary" onClick={() => setInviting(true)}><UserPlus size={15} /> Invite User</Button>
        )}
        {tab === 'groups' && tenantAdmin && (
          <Button variant="primary" onClick={() => setCreatingGroup(true)}><Plus size={15} /> Create Group</Button>
        )}
      </div>
      <PillTabs className="mb-5" items={tabs} value={tab} onChange={(k) => setTab(k as Tab)} />

      {tab === 'users' ? <UsersTab /> : <GroupsTab />}
      {inviting && <InviteUserModal onClose={() => setInviting(false)} />}
      {creatingGroup && <CreateGroupModal onClose={() => setCreatingGroup(false)} />}
    </div>
  );
}

// Roles a human user can be invited with, matching the dashboard's UserRoleSelector
// (ownership is transferred, never assigned at invite time).
const INVITE_ROLES: { value: string; label: string; icon: LucideIcon }[] = [
  { value: 'user', label: 'User', icon: UserIcon },
  { value: 'auditor', label: 'Auditor', icon: Eye },
  { value: 'network_admin', label: 'Network Admin', icon: NetworkIcon },
  { value: 'admin', label: 'Admin', icon: Cog },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Invite a user - a faithful port of the dashboard's UserInviteModal (cloud mode): the
// backend posts to NetBird's /api/users and NetBird e-mails the invitation itself.
/* Create Group - official-dashboard parity (icon + title + Name field), no docs footer. */
function CreateGroupModal({ onClose }: { onClose: () => void }) {
  const create = useCreateGroup();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    if (!name.trim() || create.isPending) return;
    setError('');
    try { await create.mutateAsync(name.trim()); onClose(); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open onClose={onClose} size="sm" icon={<FolderGit2 size={18} />}
      title="Create Group" subtitle="Create a group to manage and organize access in your network."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!name.trim() || create.isPending}>
            <Plus size={15} /> {create.isPending ? 'Creating…' : 'Create Group'}
          </Button>
        </div>
      }>
      <Field label="Name" hint="Set an easily identifiable name for your group">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Developers" autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      </Field>
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
    </Modal>
  );
}

/* Toolbar refresh - re-pulls from NetBird (works in tenant context) then refetches the lists. */
function RefreshButton({ keys }: { keys: string[] }) {
  const qc = useQueryClient();
  const refresh = useNetbirdRefresh();
  return (
    <IconButton title="Refresh" className="h-[42px] w-[42px]" onClick={async () => {
      await refresh.mutateAsync().catch(() => { });
      keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    }}>
      <RefreshCw size={15} className={cn(refresh.isPending && 'animate-spin')} />
    </IconButton>
  );
}

function InviteUserModal({ onClose }: { onClose: () => void }) {
  const { data: groups } = useGroups();
  const { data: defaults } = useInviteDefaultGroups();
  const invite = useInviteUser();
  const saveDefaults = useSaveInviteDefaultGroups();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('user');
  const [autoGroups, setAutoGroups] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [savedDefault, setSavedDefault] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  // The "All" group is implicit for every peer - NetBird's own selector hides it here.
  const groupOpts = useMemo(() => (groups || []).filter((g) => g.name !== 'All').map((g) => ({ id: g.id, name: g.name })), [groups]);
  const canSubmit = !!name.trim() && EMAIL_RE.test(email.trim()) && !invite.isPending;

  // Prefill from the account's saved default, ONCE per opening and only after both lists are in -
  // ids of deleted groups are dropped so the picker never shows a dangling selection. After that
  // the admin's edits own the field (no re-prefill on refetch).
  const defaultIds = useMemo(() => {
    if (!defaults || !groups) return null;
    const live = new Set(groupOpts.map((g) => g.id));
    return (defaults.groups || []).filter((id) => live.has(id));
  }, [defaults, groups, groupOpts]);

  useEffect(() => {
    if (prefilled || !defaultIds) return;
    setPrefilled(true);
    if (defaultIds.length) setAutoGroups(defaultIds);
  }, [defaultIds, prefilled]);

  // Offer "Save Selection As Default" only when the selection actually differs from what is
  // stored (order-insensitive) - otherwise the button is noise.
  const differsFromDefault = useMemo(() => {
    if (!defaultIds) return false;
    if (defaultIds.length !== autoGroups.length) return true;
    const a = [...defaultIds].sort().join('|');
    const b = [...autoGroups].sort().join('|');
    return a !== b;
  }, [defaultIds, autoGroups]);

  useEffect(() => { setSavedDefault(false); }, [autoGroups]);

  const saveAsDefault = async () => {
    if (saveDefaults.isPending) return;
    try {
      await saveDefaults.mutateAsync(autoGroups);
      setSavedDefault(true);
    } catch (e) { setError((e as Error).message || 'Failed to save the default.'); }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setError('');
    try {
      await invite.mutateAsync({ name: name.trim(), email: email.trim(), role, autoGroups });
      onClose();
    } catch (e) { setError((e as Error).message || 'Failed to send the invitation.'); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<UserPlus size={18} />}
      title="Invite User"
      subtitle="Invite a user to your network and set their permissions."
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit}>
            <Mail size={14} /> {invite.isPending ? 'Sending…' : 'Send Invitation'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <InviteAvatarStrip />
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="John Doe" autoFocus maxLength={100} />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} placeholder="hello@netbird.io" />
        </Field>
        <Field label="Role">
          <SelectMenu
            value={role}
            onChange={setRole}
            options={INVITE_ROLES.map((r) => ({ value: r.value, label: r.label, icon: <r.icon size={15} /> }))}
          />
        </Field>
        <Field label="Auto-Assigned Groups" hint="Groups will be assigned to peers added by this user.">
          <GroupMultiSelect groups={groupOpts} value={autoGroups} onChange={setAutoGroups} placeholder="Select group(s)…" />
          <div className="mt-1.5 h-5">
            {savedDefault ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-green-600 dark:text-green-500">
                <Check size={12} /> Saved As Default
              </span>
            ) : differsFromDefault && (
              <button type="button" onClick={saveAsDefault} disabled={saveDefaults.isPending}
                className="inline-flex items-center gap-1.5 text-xs text-nb-gray-500 hover:text-netbird disabled:opacity-60">
                <Star size={12} /> {saveDefaults.isPending ? 'Saving…' : 'Save Selection As Default'}
              </button>
            )}
          </div>
        </Field>
        {error && <p className="text-sm text-red-500">{error}</p>}
        {!error && <FieldHint>NetBird e-mails the invitation - the user appears as Invited until they sign in.</FieldHint>}
      </div>
    </Modal>
  );
}

// Decorative nod to the dashboard's avatar strip: a row of muted initial circles around an
// orange user tile. Purely visual (aria-hidden), and readable in both themes.
function InviteAvatarStrip() {
  const names = ['AR', 'MK', 'TL', 'SD'];
  return (
    <div aria-hidden className="flex items-center justify-center -space-x-2 pb-1">
      {names.slice(0, 2).map((n) => <StripCircle key={n} label={n} />)}
      <span className="relative z-10 grid place-items-center h-11 w-11 rounded-full border-4 border-white dark:border-nb-gray-950 bg-netbird-950 text-netbird ring-1 ring-netbird/60">
        <UserIcon size={18} />
      </span>
      {names.slice(2).map((n) => <StripCircle key={n} label={n} />)}
    </div>
  );
}

function StripCircle({ label }: { label: string }) {
  return (
    <span className="grid place-items-center h-9 w-9 rounded-full border-4 border-white dark:border-nb-gray-950 bg-nb-gray-100 dark:bg-nb-gray-900 text-[0.68rem] font-medium"
      style={{ color: avatarColor(label) }}>
      {label}
    </span>
  );
}


type StatusF = 'all' | 'active' | 'pending' | 'invited' | 'blocked';

// Semantic status (label + dot colour), mirroring the NetBird dashboard's UserStatusCell.
function statusOf(u: NbUser): { key: StatusF | 'unknown'; label: string; dot: string } {
  if (u.is_blocked || (u.status || '').toLowerCase() === 'blocked') return { key: 'blocked', label: 'Blocked', dot: 'bg-red-500' };
  if (u.pending_approval) return { key: 'pending', label: 'Pending', dot: 'bg-netbird' };
  const s = (u.status || '').toLowerCase();
  if (s === 'invited') return { key: 'invited', label: 'Invited', dot: 'bg-yellow-400' };
  if (s === 'active') return { key: 'active', label: 'Active', dot: 'bg-green-500' };
  return { key: 'unknown', label: u.status || 'Unknown', dot: 'bg-nb-gray-400' };
}

// Name cell: colour-hashed avatar (initial) + name (with a "You" chip for the signed-in user)
// and the e-mail underneath - matching the dashboard's UserNameCell.
function UserNameCell({ u, isYou }: { u: NbUser; isYou: boolean }) {
  const display = u.name || u.email || u.id;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="grid place-items-center h-9 w-9 rounded-full bg-nb-gray-100 dark:bg-nb-gray-900 text-[0.82rem] font-medium uppercase shrink-0"
        style={{ color: avatarColor(display) }}>
        {initials(display)}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{display}</span>
          {isYou && <span className="shrink-0 rounded-full bg-nb-blue-400/10 border border-nb-blue-400/30 text-nb-blue-600 dark:text-nb-blue-400 text-[0.6rem] font-semibold uppercase tracking-wider px-1.5 py-0.5 leading-none">You</span>}
          {u.is_service_user && <Badge tone="gray" className="shrink-0">Service</Badge>}
        </div>
        {u.email && u.name && <div className="text-[0.78rem] text-nb-gray-500 truncate">{u.email}</div>}
      </div>
    </div>
  );
}

// Auto-assigned groups: a "N Groups" chip that reveals the full list on hover (portal popover).
function UserGroupsCell({ groups }: { groups: GroupRef[] }) {
  const navigate = useNavigate();
  if (!groups.length) return <span className="text-nb-gray-500 text-sm">-</span>;
  return (
    <HoverCard
      width={280}
      trigger={<Badge tone="gray" icon={<FolderGit2 size={11} />} className="cursor-default">{groups.length} Group{groups.length === 1 ? '' : 's'}</Badge>}
    >
      <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-2.5">Auto-Assigned Groups</div>
      <div className="nb-scroll flex flex-col gap-1.5 max-h-72 overflow-y-auto overflow-x-hidden">
        {groups.map((g) => (
          <button key={g.id} type="button" onClick={() => navigate(`/groups/${encodeURIComponent(g.id)}`)} className="text-left">
            <Badge tone="gray" icon={<FolderGit2 size={11} className="shrink-0" />} className="flex w-full min-w-0 hover:border-netbird/40 hover:text-netbird">
              <span className="truncate">{g.name}</span>
            </Badge>
          </button>
        ))}
      </div>
    </HoverCard>
  );
}

// A user's human label for confirmations - name + e-mail when both are known, so the admin
// can tell two same-named people apart before an irreversible delete.
function userLabel(u: NbUser) {
  if (u.name && u.email) return `${u.name} (${u.email})`;
  return u.name || u.email || u.id;
}

// The owner can never be deleted (NetBird refuses), and admins don't get a button to delete
// themselves. The backend enforces both regardless - this only keeps the UI honest.
function userDeletable(u: NbUser, isYou: boolean) {
  return (u.role || '').toLowerCase() !== 'owner' && !isYou;
}

function UsersTab() {
  const navigate = useNavigate();
  const { data, isLoading } = useUsers();
  const { viewer, tenantAdmin } = useViewer();
  const del = useDeleteUser();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusF>('all');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const list = data || [];
  const myEmail = (viewer.email || '').toLowerCase();
  // Either identifier proves it's the signed-in admin - the NetBird id is exact, the e-mail
  // covers viewers whose id isn't resolved.
  const isYou = (u: NbUser) => (!!myEmail && (u.email || '').toLowerCase() === myEmail)
    || (!!viewer.user_id && u.id === viewer.user_id);

  // Official-dashboard wording: deleting a user DELETES THEIR PEERS, so the warning says so.
  const onDelete = async (u: NbUser) => {
    const ok = await confirm({
      title: 'Delete User?',
      message: `Deleting "${userLabel(u)}" will remove their devices and remove dashboard access. This action cannot be undone.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try { await del.mutateAsync(u.id); }
    catch (e) { await confirm({ title: 'Delete Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  const rows = useMemo(() => {
    const q = search.toLowerCase().trim();
    return list.filter((u) => {
      if (status !== 'all' && statusOf(u).key !== status) return false;
      return !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (u.role || '').toLowerCase().includes(q);
    });
  }, [list, search, status]);

  const { sorted, state } = useTableSort(rows, {
    name: (u) => u.name || u.email,
    role: (u) => u.role,
    status: (u) => statusOf(u).label,
    groups: (u) => u.groups?.length || 0,
    last_login: (u) => u.last_login,
  });

  useEffect(() => { setPage(1); }, [search, status, perPage]);

  const totalPages = Math.max(Math.ceil(sorted.length / perPage), 1);
  const pageRows = useMemo(() => sorted.slice((page - 1) * perPage, page * perPage), [sorted, page, perPage]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, email or role…" />
        <UserStatusFilter value={status} onChange={setStatus} />
        {status !== 'all' && <button onClick={() => setStatus('all')} className="text-[0.8rem] text-netbird hover:underline">Clear</button>}
        <div className="ml-auto flex items-center gap-3">
          <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
          <RefreshButton keys={['users']} />
        </div>
      </div>

      {isLoading ? <LoadingState /> : !rows.length ? (
        <EmptyState title="No Users" hint={search || status !== 'all' ? 'No users match your filters.' : 'Users are loaded from the NetBird API.'} />
      ) : (
        <>
          <div className="hidden md:block">
          <Table>
            <THead>
              <SortTh label="Name" sortKey="name" state={state} />
              <SortTh label="Role" sortKey="role" state={state} />
              <SortTh label="Status" sortKey="status" state={state} />
              <SortTh label="Groups" sortKey="groups" state={state} />
              <SortTh label="Last Login" sortKey="last_login" state={state} />
              {tenantAdmin && <Th className="w-24">{''}</Th>}
            </THead>
            <TBody>
              {pageRows.map((u) => {
                const st = statusOf(u);
                return (
                  <Tr key={u.id} onClick={() => navigate(`/users/${encodeURIComponent(u.id)}`)}>
                    <Td><UserNameCell u={u} isYou={isYou(u)} /></Td>
                    <Td>{u.role ? <Badge tone="gray">{ucLabel(u.role)}</Badge> : <span className="text-nb-gray-500">-</span>}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-2 text-sm text-nb-gray-600 dark:text-nb-gray-300">
                        <span className={cn('h-2 w-2 rounded-full', st.dot)} /> {st.label}
                      </span>
                    </Td>
                    <Td onClick={(e) => e.stopPropagation()}><UserGroupsCell groups={u.groups || []} /></Td>
                    <Td><span className="text-[0.82rem] text-nb-gray-500">{formatMaybeDate(u.last_login)}</span></Td>
                    {tenantAdmin && (
                      <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-2">
                          {st.key === 'invited' && <ResendInviteButton userId={u.id} email={u.email} />}
                          {userDeletable(u, isYou(u)) && (
                            <IconButton onClick={() => onDelete(u)} title="Delete User" disabled={del.isPending}
                              className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                          )}
                        </div>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </TBody>
          </Table>
          </div>

          {/* Mobile: cards instead of a table */}
          <div className="md:hidden flex flex-col gap-2.5">
            {pageRows.map((u) => {
              const st = statusOf(u);
              return (
                <div key={u.id} onClick={() => navigate(`/users/${encodeURIComponent(u.id)}`)}
                  className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors">
                  <div className="flex items-center gap-2.5">
                    <div className="min-w-0 flex-1"><UserNameCell u={u} isYou={isYou(u)} /></div>
                    <span className="inline-flex items-center gap-1.5 shrink-0 text-[0.78rem] text-nb-gray-500"><span className={cn('h-2 w-2 rounded-full', st.dot)} /> {st.label}</span>
                    {tenantAdmin && (st.key === 'invited' || userDeletable(u, isYou(u))) && (
                      <span className="shrink-0 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {st.key === 'invited' && <ResendInviteButton userId={u.id} email={u.email} />}
                        {userDeletable(u, isYou(u)) && (
                          <IconButton onClick={() => onDelete(u)} title="Delete User" disabled={del.isPending}
                            className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.78rem] text-nb-gray-500">
                    {u.role && <Badge tone="gray">{ucLabel(u.role)}</Badge>}
                    {!!u.groups?.length && <Badge tone="gray" icon={<FolderGit2 size={11} />}>{u.groups.length} Group{u.groups.length === 1 ? '' : 's'}</Badge>}
                    <span>Last login: {formatMaybeDate(u.last_login)}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={rows.length} label="users" />
        </>
      )}
    </div>
  );
}

// Status filter for the Users table (All / Active / Pending / Invited / Blocked), matching
// the dashboard's user status filter.
function UserStatusFilter({ value, onChange }: { value: StatusF; onChange: (v: StatusF) => void }) {
  const [open, setOpen] = useState(false);
  const opts: { v: StatusF; label: string; dot: string }[] = [
    { v: 'all', label: 'All', dot: 'bg-nb-gray-400' },
    { v: 'active', label: 'Active', dot: 'bg-green-500' },
    { v: 'pending', label: 'Pending', dot: 'bg-netbird' },
    { v: 'invited', label: 'Invited', dot: 'bg-yellow-400' },
    { v: 'blocked', label: 'Blocked', dot: 'bg-red-500' },
  ];
  return (
    <div className="relative">
      <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
        <Filter size={16} /> Filters
        {value !== 'all' && <span className="ml-0.5 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-netbird text-white text-[0.65rem] font-semibold">1</span>}
        <ChevronsUpDown size={14} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1.5 z-50 w-44 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
            <div className="px-2.5 pt-1 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-nb-gray-400">Status</div>
            {opts.map((o) => (
              <button key={o.v} onClick={() => { onChange(o.v); setOpen(false); }}
                className={cn('flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-sm text-sm', value === o.v ? 'bg-netbird/10 text-netbird' : 'text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900')}>
                <span className={cn('h-2 w-2 rounded-full', o.dot)} /> {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CountChip({ icon, count }: { icon: React.ReactNode; count: number }) {
  return (
    <Badge tone="gray" icon={icon} className={cn('tabular-nums', count === 0 && 'opacity-40')}>{count}</Badge>
  );
}

// Usage columns shown in the Groups table (mirrors the NetBird dashboard).
const COUNT_COLS: { key: keyof NbGroup; icon: LucideIcon; label: string }[] = [
  { key: 'users_count', icon: UsersIcon, label: 'Users' },
  { key: 'peers_count', icon: MonitorSmartphone, label: 'Peers' },
  { key: 'policies_count', icon: ShieldCheck, label: 'Policies' },
  { key: 'resources_count', icon: Layers3, label: 'Network Resources' },
  { key: 'routes_count', icon: RouteIcon, label: 'Network Routes' },
  { key: 'nameservers_count', icon: Server, label: 'Nameservers' },
  { key: 'zones_count', icon: Globe, label: 'Zones' },
  { key: 'setup_keys_count', icon: KeyRound, label: 'Setup Keys' },
];

function inUse(g: NbGroup) {
  return COUNT_COLS.some((c) => (g[c.key] as number) > 0);
}

// Config references (not mere membership) that block deletion - NetBird rejects deleting a
// group still linked to a policy/route/DNS/zone/setup-key/resource.
const REF_COLS: (keyof NbGroup)[] = ['policies_count', 'resources_count', 'routes_count', 'nameservers_count', 'zones_count', 'setup_keys_count'];
function referencedCount(g: NbGroup) {
  return REF_COLS.reduce((n, k) => n + ((g[k] as number) || 0), 0);
}

type UsageF = 'all' | 'used' | 'unused';

// A group is safe to bulk/single delete when it isn't the immutable "All" group and isn't
// referenced by any policy/route/DNS config (membership-only groups are still deletable).
function deletable(g: NbGroup) {
  return g.name !== 'All' && referencedCount(g) === 0;
}

function GroupsTab() {
  const navigate = useNavigate();
  const { data, isLoading } = useGroups();
  const del = useDeleteGroup();
  const bulkDel = useBulkDeleteGroups();
  const confirm = useConfirm();
  const canBulk = useViewer().isAdmin;
  const [search, setSearch] = useState('');
  const [usage, setUsage] = useState<UsageF>('all');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const list = data || [];

  const onDelete = async (g: NbGroup) => {
    const extra = (g.peers_count || g.users_count)
      ? ` It will be unassigned from ${g.peers_count} peer(s) and ${g.users_count} user(s).`
      : '';
    const ok = await confirm({
      title: 'Delete group?',
      message: `"${g.name}" will be permanently removed from NetBird.${extra} This can't be undone.`,
      confirmText: 'Delete',
    });
    if (ok) {
      try { await del.mutateAsync(g.id); }
      catch (e) { await confirm({ title: 'Delete failed', message: (e as Error).message, confirmText: 'OK' }); }
    }
  };

  const rows = useMemo(() => {
    const q = search.toLowerCase().trim();
    return list.filter((g) => {
      if (usage === 'used' && !inUse(g)) return false;
      if (usage === 'unused' && inUse(g)) return false;
      return !q || g.name.toLowerCase().includes(q);
    });
  }, [list, search, usage]);

  const { sorted, state } = useTableSort(rows, {
    name: (g) => g.name,
    ...Object.fromEntries(COUNT_COLS.map((c) => [c.key, (g: NbGroup) => g[c.key]])),
  });

  useEffect(() => { setPage(1); setSelected(new Set()); }, [search, usage, perPage]);

  const totalPages = Math.max(Math.ceil(sorted.length / perPage), 1);
  const pageRows = useMemo(() => sorted.slice((page - 1) * perPage, page * perPage), [sorted, page, perPage]);

  // ── Bulk selection (admin) - only delete-safe groups on the current page are selectable ──
  const selectableIds = useMemo(() => pageRows.filter(deletable).map((g) => g.id), [pageRows]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelected = selectableIds.some((id) => selected.has(id));
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allSelected) selectableIds.forEach((id) => next.delete(id));
    else selectableIds.forEach((id) => next.add(id));
    return next;
  });
  const toggleOne = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const onBulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const ok = await confirm({
      title: `Delete ${ids.length} group${ids.length === 1 ? '' : 's'}?`,
      message: `${ids.length} selected group${ids.length === 1 ? '' : 's'} will be permanently removed from NetBird. This can't be undone.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      const res = await bulkDel.mutateAsync(ids);
      setSelected(new Set());
      if (res?.failed?.length) {
        await confirm({ title: `${res.failed.length} couldn’t be deleted`, message: res.failed.map((f) => `• ${f.error}`).join('\n'), confirmText: 'OK' });
      }
    } catch (e) { await confirm({ title: 'Delete failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search group by name…" />
        <UsageFilter value={usage} onChange={setUsage} />
        {usage !== 'all' && <button onClick={() => setUsage('all')} className="text-[0.8rem] text-netbird hover:underline">Clear</button>}
        <div className="ml-auto flex items-center gap-3">
          <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
          <RefreshButton keys={['groups']} />
        </div>
      </div>

      {canBulk && selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-3 py-2 rounded-md border border-netbird/30 bg-netbird/5">
          <span className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">{selected.size} selected</span>
          <Button variant="danger" size="sm" onClick={onBulkDelete} disabled={bulkDel.isPending}>
            <Trash2 size={14} /> {bulkDel.isPending ? 'Deleting…' : `Delete ${selected.size}`}
          </Button>
          <button onClick={() => setSelected(new Set())} className="text-[0.8rem] text-nb-gray-500 hover:underline">Clear</button>
        </div>
      )}

      {isLoading ? <LoadingState /> : !rows.length ? (
        <EmptyState title="No Groups" hint={search || usage !== 'all' ? 'No groups match your filters.' : 'Groups are loaded from the NetBird API.'} icon={<FolderGit2 size={22} />} />
      ) : (
        <>
          <div className="hidden md:block">
          <Table>
            <THead>
              {canBulk && (
                <Th className="w-10 pl-2">
                  <input
                    type="checkbox"
                    aria-label="Select all deletable groups"
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={!selectableIds.length}
                    className="h-4 w-4 align-middle rounded-sm border-nb-gray-300 dark:border-nb-gray-700 accent-netbird focus:ring-netbird/40 disabled:opacity-40"
                  />
                </Th>
              )}
              <SortTh label="Name" sortKey="name" state={state} />
              {COUNT_COLS.map((c) => {
                const Icon = c.icon;
                return <SortTh key={c.key} sortKey={c.key} state={state} align="center" className="text-center"
                  label={<span title={c.label} className="inline-flex"><Icon size={13} /></span>} />;
              })}
              <Th className="w-10">{''}</Th>
            </THead>
            <TBody>
              {pageRows.map((g) => (
                <Tr key={g.id} onClick={() => navigate(`/groups/${encodeURIComponent(g.id)}`)} className={selected.has(g.id) ? 'bg-netbird/6!' : undefined}>
                  {canBulk && (
                    <Td className="pl-2" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(g.id)}
                        disabled={!deletable(g)}
                        onChange={() => toggleOne(g.id)}
                        title={deletable(g) ? undefined : (g.name === 'All' ? 'The “All” group can’t be deleted' : 'In use - remove its references first')}
                      />
                    </Td>
                  )}
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <span className="grid place-items-center h-7 w-7 rounded-md bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500 shrink-0">
                        <FolderGit2 size={14} />
                      </span>
                      <span className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate">{g.name}</span>
                      <IssuedChip issued={g.issued} />
                      <span className={cn('h-2 w-2 rounded-full shrink-0', inUse(g) ? 'bg-green-500' : 'bg-nb-gray-300 dark:bg-nb-gray-700')} title={inUse(g) ? 'In use' : 'Unused'} />
                    </div>
                  </Td>
                  {COUNT_COLS.map((c) => {
                    const Icon = c.icon;
                    return <Td key={c.key} className="text-center"><CountChip icon={<Icon size={11} />} count={g[c.key] as number} /></Td>;
                  })}
                  <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                    <GroupRowMenu g={g} onDelete={() => onDelete(g)} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          </div>

          {/* Mobile: cards instead of a wide table */}
          <div className="md:hidden flex flex-col gap-2.5">
            {pageRows.map((g) => (
              <div key={g.id} onClick={() => navigate(`/groups/${encodeURIComponent(g.id)}`)}
                className={cn('rounded-lg border bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors',
                  selected.has(g.id) ? 'border-netbird/40 bg-netbird/6!' : 'border-nb-gray-200 dark:border-nb-gray-800')}>
                <div className="flex items-center gap-2.5">
                  {canBulk && (
                    <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selected.has(g.id)} disabled={!deletable(g)} onChange={() => toggleOne(g.id)}
                        title={deletable(g) ? undefined : (g.name === 'All' ? 'The “All” group can’t be deleted' : 'In use - remove its references first')} />
                    </span>
                  )}
                  <span className="grid place-items-center h-7 w-7 rounded-md bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-500 shrink-0"><FolderGit2 size={14} /></span>
                  <span className="flex-1 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{g.name}</span>
                  <IssuedChip issued={g.issued} />
                  <span className={cn('h-2 w-2 rounded-full shrink-0', inUse(g) ? 'bg-green-500' : 'bg-nb-gray-300 dark:bg-nb-gray-700')} />
                  <div className="shrink-0 -mr-1" onClick={(e) => e.stopPropagation()}><GroupRowMenu g={g} onDelete={() => onDelete(g)} /></div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {COUNT_COLS.filter((c) => (g[c.key] as number) > 0).map((c) => {
                    const Icon = c.icon;
                    return <Badge key={c.key} tone="gray" icon={<Icon size={11} />}>{g[c.key] as number} {c.label}</Badge>;
                  })}
                  {!inUse(g) && <span className="text-[0.78rem] text-nb-gray-500">Unused</span>}
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={totalPages} onPage={setPage} total={rows.length} label="groups" />
        </>
      )}
    </div>
  );
}

// Filters dropdown for the Groups table - a "Usage" submenu (All / Used / Unused), matching
// the NetBird groups filter.
function UsageFilter({ value, onChange }: { value: UsageF; onChange: (v: UsageF) => void }) {
  const [open, setOpen] = useState(false);
  const opts: { v: UsageF; label: string; dot: string }[] = [
    { v: 'all', label: 'All', dot: 'bg-nb-gray-400' },
    { v: 'used', label: 'Used', dot: 'bg-green-500' },
    { v: 'unused', label: 'Unused', dot: 'bg-nb-gray-500 dark:bg-nb-gray-600' },
  ];
  return (
    <div className="relative">
      <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
        <Filter size={16} /> Filters
        {value !== 'all' && <span className="ml-0.5 inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-netbird text-white text-[0.65rem] font-semibold">1</span>}
        <ChevronsUpDown size={14} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1.5 z-50 w-44 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
            <div className="group/usage relative">
              <button className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-sm text-sm text-nb-gray-700 dark:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900">
                <span className="flex items-center gap-2"><Activity size={14} className="text-nb-gray-400" /> Usage</span>
                <ChevronRight size={14} className="text-nb-gray-400" />
              </button>
              <div className="invisible opacity-0 group-hover/usage:visible group-hover/usage:opacity-100 transition-opacity absolute left-full top-0 z-50 w-40 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5">
                {opts.map((o) => (
                  <button key={o.v} onClick={() => { onChange(o.v); setOpen(false); }}
                    className={cn('flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-sm text-sm', value === o.v ? 'bg-netbird/10 text-netbird' : 'text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900')}>
                    <span className={cn('h-2 w-2 rounded-full', o.dot)} /> {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Per-row ⋮ menu for groups. Delete is offered only when the group is safe to remove:
// the "All" group is protected, and groups referenced by policies/routes/DNS/etc. show
// why they can't be deleted instead.
function GroupRowMenu({ g, onDelete }: { g: NbGroup; onDelete: () => void }) {
  const isAll = g.name === 'All';
  const refs = referencedCount(g);
  const blocked = isAll || refs > 0;
  const reason = isAll
    ? 'The “All” group can’t be deleted.'
    : `In use by ${refs} policy / route / DNS reference${refs === 1 ? '' : 's'}. Remove those first.`;

  return (
    <RowMenu width={240}>
      {(close) => (
        blocked ? (
          <div className="px-2.5 py-2">
            <div className="flex items-center gap-2 text-sm text-nb-gray-400"><Trash2 size={14} /> Can’t delete</div>
            <p className="mt-1 text-[0.76rem] leading-snug text-nb-gray-500">{reason}</p>
          </div>
        ) : (
          <MenuItem icon={<Trash2 size={14} />} danger onClick={() => { close(); onDelete(); }}>Delete group</MenuItem>
        )
      )}
    </RowMenu>
  );
}
