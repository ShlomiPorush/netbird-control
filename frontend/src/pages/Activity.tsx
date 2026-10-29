import { useMemo, useState, useEffect } from 'react';
import { RefreshCw, Rows3 } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { cn } from '@/lib/cn';
import { useLogs, useLogUsers, type LogParams } from '@/lib/queries';
import { useNetbirdRefresh } from '@/lib/mutations';
import { useViewer } from '@/contexts/ViewerContext';
import { useDebounced } from '@/lib/useDebounced';
import { useServerSort } from '@/lib/useTableSort';
import { formatUserId } from '@/lib/logfmt';
import type { LogEvent, UserRef } from '@/lib/types';
import { SearchInput, IconButton, LogLoader, useSettledDelay, Pagination, PageHeader, ClearFiltersButton } from '@/components/ui';
import { ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import { DateRangePicker, defaultLogRange } from '@/components/logs/DateRangePicker';
import { UserSelect } from '@/components/logs/UserSelect';
import { Segmented, ToolbarMenu, FilterPopover } from '@/components/logs/toolbar';
import { EventsTable } from '@/components/logs/EventsTable';
import { RawModal } from '@/components/logs/RawModal';
import { TrafficSummary } from '@/components/logs/TrafficSummary';

type TrafficView = 'summary' | 'detailed';
const VIEW_KEY = 'nb_traffic_view';

export default function Activity() {
  const { restricted, can } = useViewer();
  // Non-admins normally see only their own traffic; the 'activity.all' permission lifts that.
  const seesAll = !restricted || can('activity.all');
  // Summary (aggregated conversations) is the default; the raw event list is behind "Detailed".
  const [view, setView] = useState<TrafficView>(() => (localStorage.getItem(VIEW_KEY) === 'detailed' ? 'detailed' : 'summary'));
  const switchView = (v: string) => { setView(v as TrafficView); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [type, setType] = useState('All');
  const [protocol, setProtocol] = useState('');
  const [user, setUser] = useState('');
  // Defaults to the last 7 days (see defaultLogRange) - the grouped views aggregate the whole
  // selected range, so All Time as a DEFAULT re-scanned the entire history on every visit.
  const [range, setRange] = useState<DateRange | undefined>(() => defaultLogRange());
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [raw, setRaw] = useState<LogEvent | null>(null);

  const dSearch = useDebounced(search);
  const dSource = useDebounced(source);
  const dDest = useDebounced(destination);
  // One sort state shared by both views; its params flow into whichever endpoint is active.
  const { sort, dir, state: sortState, params: sortParams } = useServerSort();

  // Reset to page 1 whenever a filter or the sort changes.
  useEffect(() => { setPage(1); }, [dSearch, dSource, dDest, type, protocol, user, range, perPage, sort, dir]);

  const params: LogParams = {
    page,
    // The server paginates by FLOWS (grouped events), so a page renders exactly perPage rows
    // and the footer total matches what's shown.
    per_page: perPage,
    search: dSearch || undefined,
    source: dSource || undefined,
    destination: dDest || undefined,
    type: type !== 'All' ? type : undefined,
    protocol: protocol || undefined,
    user: user || undefined,
    from: range?.from ? range.from.toISOString() : undefined,
    to: range?.to ? range.to.toISOString() : undefined,
    ...sortParams,
  };

  const { data, isLoading, isFetching, refetch } = useLogs(params, view === 'detailed');
  // Hold the branded loader a beat past the query settling, so its counter can show 100%.
  const loader = useSettledDelay(isLoading);
  const refresh = useNetbirdRefresh();
  const logUsers = useLogUsers(seesAll).data;
  const usersMap: Record<string, UserRef> = data?.users || {};
  const events = data?.events || [];

  const totalPages = Math.max(Math.ceil((data?.total || 0) / perPage), 1);

  const userList = useMemo(() =>
    (logUsers || []).map((u) => ({ id: u.user_id, name: u.display_name || formatUserId(u.user_id), email: u.email || '' })),
  [logUsers]);

  return (
    <div>
      <PageHeader
        title="Traffic Events"
        description="Browse and search the traffic events captured for your network."
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by ip, port, peer or resource…" />
        <Segmented
          options={[{ value: 'summary', label: 'Summary' }, { value: 'detailed', label: 'Detailed' }]}
          value={view}
          onChange={switchView}
        />
        <Segmented
          options={[{ value: 'All', label: 'All' }, { value: 'P2P', label: 'P2P' }, { value: 'Routed', label: 'Routed' }, { value: 'Proxy', label: 'Proxy' }]}
          value={type}
          onChange={setType}
        />
        <DateRangePicker value={range} onChange={setRange} />
        {seesAll && <UserSelect users={userList} value={user} onChange={setUser} />}
        <FilterPopover
          protocol={protocol} onProtocol={setProtocol}
          source={source} onSource={setSource}
          destination={destination} onDestination={setDestination}
          onClear={() => { setProtocol(''); setSource(''); setDestination(''); }}
        />
        <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
        <ClearFiltersButton
          active={!!search || !!source || !!destination || type !== 'All' || !!protocol || !!user || !!range}
          onClear={() => { setSearch(''); setSource(''); setDestination(''); setType('All'); setProtocol(''); setUser(''); setRange(undefined); }}
        />
        <IconButton onClick={async () => { await refresh.mutateAsync(); refetch(); }} title="Refresh" className="h-[42px] w-[42px] ml-auto">
          <RefreshCw size={15} className={cn((refresh.isPending || isFetching) && 'animate-spin')} />
        </IconButton>
      </div>

      {view === 'summary' ? (
        <TrafficSummary perPage={perPage} sortState={sortState}
          onDrill={(r) => {
            // Jump to Detailed pre-filtered to just this pair.
            setSource(r.sourceHost || r.sourceName);
            setDestination(r.destinationName || r.destinationHost);
            switchView('detailed');
          }}
          filters={{
          search: dSearch || undefined,
          source: dSource || undefined,
          destination: dDest || undefined,
          type: type !== 'All' ? type : undefined,
          protocol: protocol || undefined,
          user: user || undefined,
          from: range?.from ? range.from.toISOString() : undefined,
          to: range?.to ? range.to.toISOString() : undefined,
          ...sortParams,
        }} />
      ) : (
        <>
          {loader.visible ? (
            <LogLoader done={loader.done} label="Loading Events…" />
          ) : (
            <EventsTable events={events} usersMap={usersMap} maxGroups={perPage} onRaw={setRaw} sortState={sortState} />
          )}

          {!loader.visible && !!events.length && (
            <Pagination page={page} totalPages={totalPages} onPage={setPage} total={data?.total} totalCapped={data?.totalCapped} label="events" />
          )}
        </>
      )}

      <RawModal data={raw} onClose={() => setRaw(null)} />
    </div>
  );
}
