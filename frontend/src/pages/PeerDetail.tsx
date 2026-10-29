import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  MonitorSmartphone, Globe, Network, MapPin, Barcode, History, CalendarDays,
  FolderGit2, ArrowRight, MonitorCog, Flag, Hash, Cpu, List, ArrowLeftRight, RefreshCw, Rows3,
  Code2, Terminal, LogIn, Tag as TagIcon, X as XIcon, Clock3, Stethoscope,
} from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { cn } from '@/lib/cn';
import { formatMaybeDate } from '@/lib/logfmt';
import { usePeerDetail, useLogs, usePeerTags, type LogParams } from '@/lib/queries';
import { useNetbirdRefresh, useRevokeBypass, useSavePeerMeta } from '@/lib/mutations';
import { complianceInfo, ComplianceBanner } from '@/components/peers/Compliance';
import { useViewer } from '@/contexts/ViewerContext';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useDebounced } from '@/lib/useDebounced';
import { useServerSort } from '@/lib/useTableSort';
import type { GroupRef, LogEvent, UserRef } from '@/lib/types';
import { Badge, Breadcrumbs, Button, EmptyState, LoadingState, Pagination, IconButton, SearchInput, Tabs, Copyable, ClearFiltersButton, Input, Textarea, FlagIcon } from '@/components/ui';
import type { TabItem } from '@/components/ui';
import type { Crumb } from '@/components/ui/PageHeader';
import { Segmented, ToolbarMenu } from '@/components/logs/toolbar';
import { ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { useUrlTab } from '@/lib/useUrlTab';
import { DateRangePicker } from '@/components/logs/DateRangePicker';
import { EventsTable } from '@/components/logs/EventsTable';
import { TrafficSummary } from '@/components/logs/TrafficSummary';
import { RawModal } from '@/components/logs/RawModal';

// 2-letter ISO country code → English country name (the flag itself is rendered with
// FlagIcon - a real image, since Windows has no color emoji font for flags).
function regionLabel(cc?: string, city?: string): string {
  let country = cc || '';
  if (cc && cc.length === 2) {
    try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of(cc.toUpperCase()) || cc; } catch { /* ignore */ }
  }
  return [country, city].filter(Boolean).join(', ');
}

type Tab = 'overview' | 'traffic';

export default function PeerDetail() {
  const { id = '' } = useParams();
  const { viewer, restricted, isAdmin } = useViewer();
  const { data: peer, isLoading, isError } = usePeerDetail(id);
  const [tab, setTab] = useUrlTab<Tab>(['overview', 'traffic'], 'overview');
  const [showRaw, setShowRaw] = useState(false);
  const revokeBypass = useRevokeBypass();
  const confirm = useConfirm();

  if (isLoading) return <LoadingState label="Loading peer…" />;
  if (isError || !peer) return <EmptyState title="Peer Not Found" hint="This peer may no longer exist, or you don't have access to it." />;

  const title = peer.name || peer.hostname || peer.ip || peer.id;
  const trafficQuery = peer.ip || peer.dns_label || peer.name || '';
  const tabs: TabItem[] = [
    { key: 'overview', label: 'Overview', icon: <List size={14} /> },
    { key: 'traffic', label: 'Traffic Events', icon: <ArrowLeftRight size={14} /> },
  ];
  const region = regionLabel(peer.country_code, peer.city_name);
  const compliance = complianceInfo(peer);
  // The server allows admins and the device owner to remove a bypass.
  const ownsDevice = !!viewer.user_id && (peer.user_id === viewer.user_id || (peer.user_id || '').endsWith('|' + viewer.user_id.split('|').pop()));
  const canRemoveBypass = !!peer.force_approved && (isAdmin || ownsDevice);
  const onRemoveBypass = async () => {
    const ok = await confirm({
      title: 'Revoke Bypass',
      message: `Remove the compliance bypass from "${title}"? The device will be blocked again until it passes the compliance checks.`,
      confirmText: 'Revoke Bypass',
    });
    if (!ok) return;
    try { await revokeBypass.mutateAsync(peer.id); }
    catch (e) { await confirm({ title: 'Failed to remove the bypass', message: (e as Error).message, confirmText: 'OK' }); }
  };
  const crumbs: Crumb[] = [
    { label: 'Peers', icon: <MonitorSmartphone size={14} />, to: '/peers' },
    { label: peer.ip || title },
  ];

  return (
    <div>
      <Breadcrumbs items={crumbs} />

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', peer.connected ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
            <h1 className="min-w-0 text-2xl font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{title}</h1>
            {peer.login_expired && <Badge tone="red" className="shrink-0">Login Required</Badge>}
            {peer.ephemeral && <Badge tone="gray" className="shrink-0">Ephemeral</Badge>}
          </div>
          {peer.kind === 'user-device' && (peer.owner_email || peer.owner_name) && (
            <div className="mt-1 pl-[22px]">
              {peer.user_id ? (
                <Link to={`/users/${encodeURIComponent(peer.user_id)}`}
                  className="inline-flex items-center gap-1 text-sm text-nb-blue-500 hover:underline">
                  {peer.owner_email || peer.owner_name} <ArrowRight size={13} />
                </Link>
              ) : (
                <span className="text-sm text-nb-gray-500">{peer.owner_email || peer.owner_name}</span>
              )}
            </div>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <Link to={`/troubleshoot?peer=${encodeURIComponent(peer.id)}`} title="Run connectivity diagnostics for this device"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-700 text-sm text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800 transition-colors">
            <Stethoscope size={15} /> <span className="hidden sm:inline">Diagnose</span>
          </Link>
          <button onClick={() => setShowRaw(true)} title="View the full NetBird peer object"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-700 text-sm text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800 transition-colors">
            <Code2 size={15} /> <span className="hidden sm:inline">View raw</span>
          </button>
        </div>
      </div>

      {compliance && (
        <div className="mb-6 max-w-3xl">
          <ComplianceBanner info={compliance} />
          {canRemoveBypass && (
            <div className="mt-2">
              <Button variant="secondary" size="sm" onClick={onRemoveBypass} disabled={revokeBypass.isPending}>
                {revokeBypass.isPending ? 'Removing…' : 'Revoke Bypass'}
              </Button>
            </div>
          )}
        </div>
      )}

      <Tabs items={tabs} value={tab} onChange={(k) => setTab(k as Tab)} className="mb-6" />

      {tab === 'traffic' ? (
        <PeerTrafficEvents query={trafficQuery} />
      ) : (
      <div className="grid lg:grid-cols-2 gap-8 items-start max-w-6xl">
        {/* Left: information card */}
        <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-940 divide-y divide-nb-gray-100 dark:divide-nb-gray-900/70">
          <InfoRow icon={<MapPin size={16} />} label="NetBird IP Address" value={<Copyable value={peer.ip || ''}><Mono>{peer.ip || '-'}</Mono></Copyable>} />
          <InfoRow icon={<Hash size={16} />} label="Public IP Address" value={<Copyable value={peer.connection_ip || ''}><Mono>{peer.connection_ip || '-'}</Mono></Copyable>} />
          {peer.ipv6 && <InfoRow icon={<Network size={16} />} label="IPv6 Address" value={<Copyable value={peer.ipv6}><Mono>{peer.ipv6}</Mono></Copyable>} />}
          {!!peer.network_addresses?.length && (
            <InfoRow icon={<Network size={16} />} label="Network Interfaces" value={
              <div className="flex flex-col items-start gap-1 sm:items-end">
                {peer.network_addresses.map((a) => (
                  <span key={`${a.ip}|${a.mac}`} className="inline-flex items-center gap-2">
                    {a.ip && <Mono>{a.ip}</Mono>}
                    {a.mac && <Copyable value={a.mac}><Mono>{a.mac}</Mono></Copyable>}
                  </span>
                ))}
              </div>
            } />
          )}
          <InfoRow icon={<Globe size={16} />} label="Domain Name" value={<Copyable value={peer.dns_label || ''}><Mono>{peer.dns_label || '-'}</Mono></Copyable>} />
          <InfoRow icon={<MonitorCog size={16} />} label="Hostname" value={peer.hostname || '-'} />
          <InfoRow icon={<Flag size={16} />} label="Region" value={
            region ? <span className="inline-flex items-center gap-1.5">{peer.country_code && <FlagIcon cc={peer.country_code} />}{region}</span> : '-'
          } />
          <InfoRow icon={<MonitorSmartphone size={16} />} label="Operating System" value={peer.os || '-'} />
          {peer.kernel_version && <InfoRow icon={<Cpu size={16} />} label="Kernel" value={<Mono>{peer.kernel_version}</Mono>} />}
          <InfoRow icon={<Terminal size={16} />} label="SSH Server" value={peer.ssh_enabled ? 'Enabled' : 'Disabled'} />
          <InfoRow icon={<Barcode size={16} />} label="Serial Number" value={peer.serial_number || '-'} />
          <InfoRow icon={<CalendarDays size={16} />} label="Registered On" value={formatMaybeDate(peer.created_at)} />
          <InfoRow icon={<LogIn size={16} />} label="Last Login" value={formatMaybeDate(peer.last_login)} />
          {peer.kind === 'user-device' && (
            <InfoRow icon={<Clock3 size={16} />} label="Session Expires" value={(() => {
              if (peer.login_expired) return <span className="text-red-500">Expired - login required</span>;
              if (!peer.login_expiration_enabled) return 'Never (expiration disabled for this peer)';
              if (!peer.session_expires_at) return '-';
              const ms = new Date(peer.session_expires_at).getTime() - Date.now();
              const left = ms <= 0 ? 'due now' : ms < 3600_000 ? `in ${Math.max(1, Math.round(ms / 60000))} min`
                : ms < 86400_000 ? `in ${Math.round(ms / 3600_000)} hour${Math.round(ms / 3600_000) === 1 ? '' : 's'}`
                  : `in ${Math.round(ms / 86400_000)} day${Math.round(ms / 86400_000) === 1 ? '' : 's'}`;
              return <span className={ms < 86400_000 ? 'text-amber-500' : undefined}>{formatMaybeDate(peer.session_expires_at)} ({left})</span>;
            })()} />
          )}
          <InfoRow icon={<History size={16} />} label="Last Seen" value={peer.connected ? 'Connected now' : formatMaybeDate(peer.last_seen)} />
          <InfoRow icon={<Network size={16} />} label="Agent Version" value={peer.version || '-'} />
          <InfoRow icon={<Network size={16} />} label="UI Version" value={peer.ui_version || '-'} />
        </div>

        {/* Right: session settings + assigned groups */}
        <div className="flex flex-col gap-4">
          <SettingPanel
            on={!!peer.login_expiration_enabled}
            title="Session Expiration"
            description="When enabled, SSO-login peers must re-authenticate after their session expires."
          />
          <SettingPanel
            on={!!peer.inactivity_expiration_enabled}
            title="Require login after disconnect"
            description="When enabled, peers must re-authenticate after disconnecting from management for a period of time."
          />

          <div className="mt-2">
            <h2 className="text-base font-semibold text-nb-gray-800 dark:text-nb-gray-100">Assigned Groups</h2>
            <p className="text-nb-gray-500 text-sm mb-3">Groups control what this peer can access.</p>
            <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-940 p-3">
              {peer.groups.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {peer.groups.map((g) => <GroupChip key={g.id || g.name} group={g} linkable={!restricted && !!g.id} />)}
                </div>
              ) : (
                <p className="text-sm text-nb-gray-500">Not assigned to any group.</p>
              )}
            </div>
          </div>

          <PeerMetaCard key={peer.id} peerId={peer.id} tags={peer.tags || []} note={peer.note || ''} editable={isAdmin} />
        </div>
      </div>
      )}

      {showRaw && <RawModal data={peer.raw ?? peer} onClose={() => setShowRaw(false)} title="Raw Peer Data" />}
    </div>
  );
}

// ─── Notes & Tags - operational metadata stored app-side (admins edit; others read) ───
function PeerMetaCard({ peerId, tags: initialTags, note: initialNote, editable }: {
  peerId: string; tags: string[]; note: string; editable: boolean;
}) {
  const save = useSavePeerMeta();
  const allTags = usePeerTags(editable).data || [];
  const [tags, setTags] = useState<string[]>(initialTags);
  const [note, setNote] = useState(initialNote);
  const [tagInput, setTagInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Hidden entirely for read-only viewers when there's nothing to show.
  if (!editable && !initialTags.length && !initialNote) return null;

  const dirty = note !== initialNote || JSON.stringify(tags) !== JSON.stringify(initialTags);
  const addTag = (raw: string) => {
    const v = raw.trim();
    if (!v || tags.includes(v)) { setTagInput(''); return; }
    setTags((p) => [...p, v]);
    setTagInput('');
  };
  const suggestions = allTags
    .filter((t) => !tags.includes(t) && (!tagInput.trim() || t.toLowerCase().includes(tagInput.trim().toLowerCase())))
    .slice(0, 6);

  const onSave = async () => {
    setError('');
    try {
      await save.mutateAsync({ id: peerId, note, tags });
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="mt-2">
      <h2 className="text-base font-semibold text-nb-gray-800 dark:text-nb-gray-100">Notes & Tags</h2>
      <p className="text-nb-gray-500 text-sm mb-3">Operational metadata stored in this app - whose device it is, why it exists.</p>
      <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-940 p-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-md border border-nb-gray-200 dark:border-nb-gray-800/60 bg-nb-gray-100 dark:bg-nb-gray-930/60 px-2 py-0.5 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-200">
              <TagIcon size={11} className="text-nb-gray-400" /> {t}
              {editable && (
                <button onClick={() => setTags((p) => p.filter((x) => x !== t))} title="Remove tag" className="text-nb-gray-400 hover:text-red-500">
                  <XIcon size={12} />
                </button>
              )}
            </span>
          ))}
          {!tags.length && !editable && <span className="text-sm text-nb-gray-500">No tags.</span>}
        </div>
        {editable && (
          <>
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); } }}
              placeholder="Add a tag and press Enter…"
            />
            {suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 -mt-1">
                <span className="text-[0.72rem] text-nb-gray-400">Existing:</span>
                {suggestions.map((t) => (
                  <button key={t} onClick={() => addTag(t)}
                    className="rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 px-2 py-0.5 text-[0.74rem] text-nb-gray-500 hover:text-netbird hover:border-netbird transition-colors">
                    + {t}
                  </button>
                ))}
              </div>
            )}
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Free-form note - e.g. client X's server, loaner laptop until August…" />
            <div className="flex items-center gap-3">
              <Button variant="primary" size="sm" onClick={onSave} disabled={!dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
              {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
              {error && <span className="text-sm text-red-500">{error}</span>}
            </div>
          </>
        )}
        {!editable && initialNote && <p className="text-sm text-nb-gray-600 dark:text-nb-gray-300 whitespace-pre-wrap">{initialNote}</p>}
      </div>
    </div>
  );
}

type Direction = 'inbound' | 'outbound';

function last7Days(): DateRange {
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 7); from.setHours(0, 0, 0, 0);
  const to = new Date(now); to.setHours(23, 59, 59, 999);
  return { from, to };
}

function PeerTrafficEvents({ query }: { query: string }) {
  const [direction, setDirection] = useState<Direction>('outbound');
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<DateRange | undefined>(last7Days);
  const [perPage, setPerPage] = useState(25);
  const [page, setPage] = useState(1);
  const [raw, setRaw] = useState<LogEvent | null>(null);
  // Summary (aggregated conversations) is the default, same as the Activity page.
  const [view, setView] = useState<'summary' | 'detailed'>(() => (localStorage.getItem('nb_traffic_view') === 'detailed' ? 'detailed' : 'summary'));
  const switchView = (v: string) => { setView(v as 'summary' | 'detailed'); try { localStorage.setItem('nb_traffic_view', v); } catch { /* ignore */ } };

  const dSearch = useDebounced(search);
  // This tab's own sort state (independent of the Activity page); feeds both views.
  const { sort, dir, state: sortState, params: sortParams } = useServerSort();
  useEffect(() => { setPage(1); }, [query, direction, dSearch, range, perPage, sort, dir]);

  // Outbound = peer is the source; Inbound = peer is the destination. The user's own
  // search box uses the free-text `search` param on top of the peer scope.
  const params: LogParams = {
    page,
    // The server paginates by FLOWS (grouped events), so a page renders exactly perPage rows
    // and the footer total matches what's shown.
    per_page: perPage,
    search: dSearch || undefined,
    source: direction === 'outbound' ? query : undefined,
    destination: direction === 'inbound' ? query : undefined,
    from: range?.from ? range.from.toISOString() : undefined,
    to: range?.to ? range.to.toISOString() : undefined,
    ...sortParams,
  };
  const { data, isLoading, isFetching, refetch } = useLogs(params, view === 'detailed');
  const refresh = useNetbirdRefresh();
  const events = data?.events || [];
  const usersMap: Record<string, UserRef> = data?.users || {};
  const totalPages = Math.max(Math.ceil((data?.total || 0) / perPage), 1);

  if (!query) return <EmptyState title="No Traffic Events" hint="This peer has no address to match events against." />;

  return (
    <div>
      <p className="text-[0.95rem] text-nb-gray-500 dark:text-nb-gray-400 mb-5">
        Here you can see all the {direction} traffic events for this peer.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by ip, port, peer or resource…" />
        <Segmented
          options={[{ value: 'summary', label: 'Summary' }, { value: 'detailed', label: 'Detailed' }]}
          value={view}
          onChange={switchView}
        />
        <Segmented
          options={[{ value: 'inbound', label: 'Inbound' }, { value: 'outbound', label: 'Outbound' }]}
          value={direction}
          onChange={(v) => setDirection(v as Direction)}
        />
        <DateRangePicker value={range} onChange={setRange} />
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton active={!!search} onClear={() => { setSearch(''); setRange(last7Days()); }} />
        <IconButton onClick={async () => { await refresh.mutateAsync(); refetch(); }} title="Refresh" className="h-[42px] w-[42px] ml-auto">
          <RefreshCw size={15} className={cn((refresh.isPending || isFetching) && 'animate-spin')} />
        </IconButton>
      </div>

      {view === 'summary' ? (
        <TrafficSummary perPage={perPage} sortState={sortState}
          onDrill={(r) => {
            // The peer itself is fixed by the direction filter; search for the other side.
            setSearch(direction === 'outbound' ? (r.destinationName || r.destinationHost) : (r.sourceName || r.sourceHost));
            switchView('detailed');
          }}
          filters={{
          search: dSearch || undefined,
          source: direction === 'outbound' ? query : undefined,
          destination: direction === 'inbound' ? query : undefined,
          from: range?.from ? range.from.toISOString() : undefined,
          to: range?.to ? range.to.toISOString() : undefined,
          ...sortParams,
        }} />
      ) : (
        <>
          {isLoading ? <LoadingState /> : <EventsTable events={events} usersMap={usersMap} maxGroups={perPage} onRaw={setRaw} showRouter={false} minWidth={820} sortState={sortState} />}
          {!!events.length && <Pagination page={page} totalPages={totalPages} onPage={setPage} total={data?.total} totalCapped={data?.totalCapped} label="events" />}
        </>
      )}
      <RawModal data={raw} onClose={() => setRaw(null)} />
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[0.82rem]">{children}</span>;
}

// Read-only switch mirroring NetBird's toggles (this app doesn't edit peers).
function SettingPanel({ on, title, description }: { on: boolean; title: string; description: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 rounded-md border p-3.5',
      on ? 'border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/40' : 'border-nb-gray-200 dark:border-nb-gray-900')}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">{title}</div>
        <p className="text-[0.8rem] text-nb-gray-500 mt-0.5">{description}</p>
      </div>
      <span title={on ? 'Enabled' : 'Disabled'}
        className={cn('relative inline-flex h-5 w-9 items-center rounded-full shrink-0', on ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700')}>
        <span className={cn('inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform', on ? 'translate-x-[18px]' : 'translate-x-[3px]')} />
      </span>
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
    // Stacked on phones (long values like IPv6 / kernel wrap in full); label-left value-right on ≥sm.
    <div className="flex flex-col items-start gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="inline-flex items-center gap-2.5 text-sm text-nb-gray-500 dark:text-nb-gray-400 shrink-0">
        <span className="text-nb-gray-400">{icon}</span> {label}
      </span>
      <span className="min-w-0 w-full break-all text-sm text-nb-gray-800 dark:text-nb-gray-200 sm:w-auto sm:break-normal sm:text-right sm:truncate">{value}</span>
    </div>
  );
}
