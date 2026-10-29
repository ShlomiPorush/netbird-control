import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  Users as UsersIcon, User2, Mail, Shield, Activity as ActivityIcon, History,
  FolderGit2, RefreshCw, Rows3, Trash2, Ban, ShieldCheck, KeyRound,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { initials, avatarColor } from '@/lib/str';
import { formatMaybeDate } from '@/lib/logfmt';
import { useUserDetail } from '@/lib/queries';
import { useNetbirdRefresh, useDeleteUser, useSetUserBlocked, useResetUserMfa } from '@/lib/mutations';
import { useViewer } from '@/contexts/ViewerContext';
import { useConfirm } from '@/contexts/ConfirmContext';
import type { UserDetail as UserDetailT, GroupRef, DetailPeer } from '@/lib/types';
import { Badge, Breadcrumbs, Button, EmptyState, LoadingState, SearchInput, IconButton, Pagination } from '@/components/ui';
import type { Crumb } from '@/components/ui/PageHeader';
import { Segmented, ToolbarMenu } from '@/components/logs/toolbar';
import { ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { PeersMiniTable } from '@/components/users/PeersMiniTable';
import { ResendInviteButton } from '@/components/users/ResendInviteButton';

function statusBadge(u: UserDetailT): { label: string; tone: 'green' | 'red' | 'yellow' | 'gray' } {
  if (u.is_blocked) return { label: 'Blocked', tone: 'red' };
  const s = (u.status || '').toLowerCase();
  if (s === 'active') return { label: 'Active', tone: 'green' };
  // Invited = the NetBird invitation was sent but the user hasn't signed in yet.
  if (s === 'invited') return { label: 'Invited', tone: 'yellow' };
  return { label: u.status || 'Unknown', tone: 'gray' };
}

export default function UserDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { viewer, restricted, tenantAdmin } = useViewer();
  const { data: user, isLoading, isError, refetch, isFetching } = useUserDetail(id);
  const refresh = useNetbirdRefresh();
  const del = useDeleteUser();
  const block = useSetUserBlocked();
  const resetMfa = useResetUserMfa();
  const confirm = useConfirm();

  // Deleting a user DELETES THEIR PEERS (NetBird semantics) - the confirm says so, in the
  // official dashboard's wording. Hooks stay above the early returns.
  const onDelete = async () => {
    if (!user) return;
    const label = user.name && user.email ? `${user.name} (${user.email})` : (user.name || user.email || user.id);
    const ok = await confirm({
      title: 'Delete User?',
      message: `Deleting "${label}" will remove their devices and remove dashboard access. This action cannot be undone.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try { await del.mutateAsync(user.id); navigate('/users'); }
    catch (e) { await confirm({ title: 'Delete Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  // Block / unblock, worded like the official dashboard ("<name> will be blocked from signing in").
  const onToggleBlock = async () => {
    if (!user) return;
    const nm = user.name || user.email || user.id;
    const blocking = !user.is_blocked;
    const ok = await confirm({
      title: blocking ? 'Block User?' : 'Unblock User?',
      message: blocking ? `${nm} will be blocked from signing in.` : `${nm} will be able to sign in again.`,
      confirmText: blocking ? 'Block' : 'Unblock',
    });
    if (!ok) return;
    try { await block.mutateAsync({ id: user.id, blocked: blocking }); refetch(); }
    catch (e) { await confirm({ title: 'Action Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  // Reset MFA - NetBird clears the user's MFA methods; they set them up again on next login.
  const onResetMfa = async () => {
    if (!user) return;
    const nm = user.name || user.email || user.id;
    const ok = await confirm({
      title: 'Reset MFA?',
      message: `This resets ${nm}'s MFA methods; they set it up again on next login.`,
      confirmText: 'Reset MFA',
    });
    if (!ok) return;
    try { await resetMfa.mutateAsync(user.id); refetch(); }
    catch (e) { await confirm({ title: 'Reset MFA Failed', message: (e as Error).message, confirmText: 'OK' }); }
  };

  if (isLoading) return <LoadingState label="Loading user…" />;
  if (isError || !user) return <EmptyState title="User Not Found" hint="This user may no longer exist." />;

  const name = user.name || user.email || user.id;
  const st = statusBadge(user);
  // The owner can't be deleted, and an admin doesn't get a button to delete themselves.
  const isSelf = (!!viewer.email && (user.email || '').toLowerCase() === viewer.email.toLowerCase())
    || (!!viewer.user_id && user.id === viewer.user_id);
  const isOwner = (user.role || '').toLowerCase() === 'owner';
  const canDelete = tenantAdmin && !isOwner && !isSelf;
  // Blocking the owner or yourself is refused/self-defeating, so those never get the button.
  const canBlock = tenantAdmin && !isOwner && !isSelf;
  // Service users have no MFA, so Reset MFA never applies to them.
  const canResetMfa = tenantAdmin && !user.is_service_user;
  const mfaReady = user.mfa_supported !== false;

  // Non-admins reach this page only for their own profile; don't link to the
  // admin-only Users & Groups list or group detail pages.
  const crumbs: Crumb[] = restricted
    ? [{ label: 'My Account', icon: <User2 size={14} /> }, { label: name }]
    : [{ label: 'Users & Groups', icon: <UsersIcon size={14} />, to: '/users' }, { label: name }];

  return (
    <div className="max-w-6xl">
      <Breadcrumbs items={crumbs} />

      {/* Header */}
      <div className="flex items-center gap-3 mb-6 md:mb-8">
        <div className="grid place-items-center h-10 w-10 md:h-11 md:w-11 rounded-full bg-nb-gray-100 dark:bg-nb-gray-900 text-base font-medium uppercase shrink-0"
          style={{ color: avatarColor(name) }}>
          {initials(name)}
        </div>
        <h1 className="min-w-0 text-xl md:text-2xl font-medium text-nb-gray-800 dark:text-nb-gray-100 flex items-center gap-2.5">
          <span className="truncate">{name}</span>
          {user.is_service_user && <Badge tone="gray" className="shrink-0">Service User</Badge>}
        </h1>
        {/* Admin actions - resend a pending invite, reset MFA, block/unblock, delete. */}
        {tenantAdmin && (st.label === 'Invited' || canResetMfa || canBlock || canDelete) && (
          <div className="ml-auto shrink-0 flex items-center gap-2">
            {st.label === 'Invited' && <ResendInviteButton userId={user.id} email={user.email} variant="button" />}
            {canResetMfa && (
              // NetBird MFA reset runs on the AUTH service, unreachable through the management API on
              // some deployments - disable with an explanatory tooltip when the probe says so.
              <span title={mfaReady ? undefined : 'NetBird MFA reset is not available through the management API on this deployment.'}>
                <Button variant="secondary" size="sm" onClick={onResetMfa} disabled={resetMfa.isPending || !mfaReady}>
                  <KeyRound size={14} /> {resetMfa.isPending ? 'Resetting…' : 'Reset MFA'}
                </Button>
              </span>
            )}
            {canBlock && (
              user.is_blocked ? (
                <Button variant="secondary" size="sm" onClick={onToggleBlock} disabled={block.isPending}>
                  <ShieldCheck size={14} /> {block.isPending ? 'Unblocking…' : 'Unblock User'}
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={onToggleBlock} disabled={block.isPending}
                  className="text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:border-red-500/40 hover:bg-red-500/10">
                  <Ban size={14} /> {block.isPending ? 'Blocking…' : 'Block User'}
                </Button>
              )
            )}
            {canDelete && (
              <Button variant="secondary" size="sm" onClick={onDelete} disabled={del.isPending}
                className="text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:border-red-500/40 hover:bg-red-500/10">
                <Trash2 size={14} /> {del.isPending ? 'Deleting…' : 'Delete User'}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Top: info card (left) + auto-assigned groups & role (right) */}
      <div className="grid lg:grid-cols-2 gap-10 items-start mb-10">
        <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-940 divide-y divide-nb-gray-100 dark:divide-nb-gray-900/70">
          <InfoRow icon={<User2 size={16} />} label="Name" value={user.name || user.id} />
          <InfoRow icon={<Mail size={16} />} label="E-Mail" value={user.email || '-'} />
          <InfoRow icon={<ActivityIcon size={16} />} label="Status" value={
            <span className="inline-flex items-center gap-2">
              <span className={cn('h-2 w-2 rounded-full', st.tone === 'green' ? 'bg-green-500' : st.tone === 'red' ? 'bg-red-500' : st.tone === 'yellow' ? 'bg-yellow-400' : 'bg-nb-gray-400')} />
              {st.label}
            </span>
          } />
          <InfoRow icon={<History size={16} />} label="Last Login" value={formatMaybeDate(user.last_login) || 'Never'} />
        </div>

        <div className="flex flex-col gap-8">
          <div>
            <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Auto-Assigned Groups</div>
            <p className="text-nb-gray-500 text-[0.8rem] mb-3">Groups assigned to peers added by this user.</p>
            <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-940 p-3 min-h-[52px]">
              {user.groups.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {user.groups.map((g) => <GroupChip key={g.id} group={g} linkable={!restricted && !!g.id} />)}
                </div>
              ) : (
                <p className="text-sm text-nb-gray-500">Not a member of any group.</p>
              )}
            </div>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">User Role</div>
              <p className="text-nb-gray-500 text-[0.8rem]">The access permissions assigned to this user.</p>
            </div>
            <div className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900 text-sm text-nb-gray-800 dark:text-nb-gray-100 capitalize shrink-0">
              <Shield size={14} className="text-nb-gray-400" /> {user.role || 'user'}
            </div>
          </div>
        </div>
      </div>

      {/* Peers */}
      <PeersSection peers={user.peers} onRefresh={async () => { await refresh.mutateAsync(); refetch(); }} isFetching={refresh.isPending || isFetching} />
    </div>
  );
}

type PeerFilter = 'all' | 'online' | 'offline';

function PeersSection({ peers, onRefresh, isFetching }: { peers: DetailPeer[]; onRefresh: () => void; isFetching: boolean }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PeerFilter>('all');
  const [perPage, setPerPage] = useState(25);
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    const q = search.toLowerCase().trim();
    return peers.filter((p) =>
      (filter === 'all' || (filter === 'online' ? p.connected : !p.connected)) &&
      (!q || (p.name || '').toLowerCase().includes(q) || (p.ip || '').toLowerCase().includes(q) || (p.dns_label || '').toLowerCase().includes(q)),
    );
  }, [peers, search, filter]);

  useEffect(() => { setPage(1); }, [search, filter, perPage]);

  const totalPages = Math.max(Math.ceil(rows.length / perPage), 1);
  const pageRows = rows.slice((page - 1) * perPage, page * perPage);

  return (
    <div>
      <h2 className="text-xl font-semibold text-nb-gray-900 dark:text-nb-gray-50">{peers.length} Peer{peers.length === 1 ? '' : 's'}</h2>
      <p className="text-nb-gray-500 text-sm mb-5">View all peers registered by this user.</p>

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, IP or group…" />
        <Segmented
          options={[{ value: 'all', label: 'All' }, { value: 'online', label: 'Online' }, { value: 'offline', label: 'Offline' }]}
          value={filter}
          onChange={(v) => setFilter(v as PeerFilter)}
        />
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <IconButton onClick={onRefresh} title="Refresh" className="h-[42px] w-[42px] ml-auto">
          <RefreshCw size={15} className={cn(isFetching && 'animate-spin')} />
        </IconButton>
      </div>

      <PeersMiniTable peers={pageRows} />
      {!!rows.length && <Pagination page={page} totalPages={totalPages} onPage={setPage} total={rows.length} label="peers" />}
    </div>
  );
}

function GroupChip({ group, linkable }: { group: GroupRef; linkable: boolean }) {
  const badge = (
    <Badge tone="gray" icon={<FolderGit2 size={11} />}
      className={linkable ? 'hover:border-netbird/40 hover:text-netbird transition-colors cursor-pointer' : undefined}>
      {group.name}
    </Badge>
  );
  return linkable ? <Link to={`/groups/${encodeURIComponent(group.id)}`}>{badge}</Link> : badge;
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    // Stacked on phones (long values wrap in full); label-left value-right on ≥sm.
    <div className="flex flex-col items-start gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="inline-flex items-center gap-2.5 text-sm text-nb-gray-500 dark:text-nb-gray-400 shrink-0">
        <span className="text-nb-gray-400">{icon}</span> {label}
      </span>
      <span className="min-w-0 w-full break-all text-sm text-nb-gray-800 dark:text-nb-gray-200 sm:w-auto sm:break-normal sm:text-right sm:truncate">{value}</span>
    </div>
  );
}
