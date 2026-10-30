import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Rows3, Shield, Users, Package, MonitorSmartphone, EyeOff, Eye, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useCleanupScan } from '@/lib/queries';
import { useSetCleanupIgnore } from '@/lib/mutations';
import { formatTimestamp } from '@/lib/logfmt';
import { useTableSort } from '@/lib/useTableSort';
import { useClientPagination, ROWS_PER_PAGE_OPTIONS } from '@/lib/useClientPagination';
import type { CleanupCategory, CleanupIgnored, CleanupReport } from '@/lib/types';
import {
  SearchInput, SelectMenu, IconButton, EmptyState, LoadingState, Pagination, Badge,
  Table, THead, Th, SortTh, TBody, Tr, Td, ClearFiltersButton,
} from '@/components/ui';
import { ToolbarMenu } from '@/components/logs/toolbar';

// One flattened finding - every category renders through the same standard table.
interface Finding {
  key: string;
  category: CleanupCategory;
  /** The raw object id - what the ignore toggle is keyed on. */
  id: string;
  name: string;
  detail: string;
  link?: string;
  /** Numeric sort hint (stale peers sort by days). */
  weight: number;
}

const CATEGORY_META: Record<CleanupCategory, { label: string; tone: 'red' | 'orange' | 'cyan' | 'gray'; explain: string }> = {
  'orphaned-policy': { label: 'Orphaned Policy', tone: 'red', explain: 'References a group or resource that no longer exists' },
  'ineffective-policy': { label: 'Ineffective Policy', tone: 'orange', explain: 'Enabled but grants nothing' },
  'empty-group': { label: 'Unused Group', tone: 'gray', explain: 'No members and not referenced anywhere' },
  'unreachable-resource': { label: 'Unreachable Resource', tone: 'cyan', explain: 'No enabled policy points at it' },
  'stale-peer': { label: 'Stale Device', tone: 'orange', explain: 'Offline for a long time' },
};

const CATEGORY_OPTIONS = [
  { value: '', label: 'All Categories' },
  { value: 'orphaned-policy', label: 'Orphaned Policies' },
  { value: 'ineffective-policy', label: 'Ineffective Policies' },
  { value: 'empty-group', label: 'Unused Groups' },
  { value: 'unreachable-resource', label: 'Unreachable Resources' },
  { value: 'stale-peer', label: 'Stale Devices' },
];

const STALE_OPTIONS = [30, 60, 90, 180].map((d) => ({ value: String(d), label: `Not Seen ${d}+ Days` }));

// Shared row builders - the same code renders live findings AND the ignored list.
function buildFinding(category: CleanupCategory, item: Record<string, unknown>): Finding {
  const s = (k: string) => String(item[k] ?? '');
  switch (category) {
    case 'orphaned-policy': {
      const missing = (item.missing as { kind: string }[]) || [];
      const kinds = [...new Set(missing.map((m) => m.kind))].join(' and ');
      return {
        key: `op:${s('id')}`, category, id: s('id'), name: s('name'),
        detail: `References ${missing.length === 1 ? 'a deleted' : `${missing.length} deleted`} ${kinds}${missing.length === 1 ? '' : 's'}${item.enabled ? '' : ' - policy is disabled'}`,
        link: '/policies', weight: 0,
      };
    }
    case 'ineffective-policy':
      return { key: `ip:${s('id')}`, category, id: s('id'), name: s('name'), detail: `Grants nothing: ${s('reason')}`, link: '/policies', weight: 0 };
    case 'empty-group':
      return {
        key: `g:${s('id')}`, category, id: s('id'), name: s('name'),
        detail: `No members, no resources, not referenced by any policy, route, DNS or setup key${s('issued') === 'integration' ? ' - synced from your identity provider, delete it there' : ''}`,
        link: `/groups/${encodeURIComponent(s('id'))}`, weight: 0,
      };
    case 'unreachable-resource':
      return {
        key: `r:${s('id')}`, category, id: s('id'), name: s('name'),
        detail: `${s('address')}${s('network') ? ` · ${s('network')}` : ''} - no enabled policy points at it, so nobody can reach it`,
        link: s('networkId') ? `/networks/${encodeURIComponent(s('networkId'))}?resource=${encodeURIComponent(s('id'))}` : undefined, weight: 0,
      };
    case 'stale-peer':
      return {
        key: `pe:${s('id')}`, category, id: s('id'), name: s('name'),
        detail: `Last seen ${item.days} days ago (${formatTimestamp(s('lastSeen'))})${s('owner') ? ` · ${s('owner')}` : ''}${s('kind') === 'server' ? ' · server' : ''}`,
        link: `/peers/${encodeURIComponent(s('id'))}`, weight: Number(item.days) || 0,
      };
  }
}

function reportFindings(data: CleanupReport): Finding[] {
  return [
    ...data.orphanedPolicies.map((x) => buildFinding('orphaned-policy', x as unknown as Record<string, unknown>)),
    ...data.ineffectivePolicies.map((x) => buildFinding('ineffective-policy', x as unknown as Record<string, unknown>)),
    ...data.emptyGroups.map((x) => buildFinding('empty-group', x as unknown as Record<string, unknown>)),
    ...data.unreachableResources.map((x) => buildFinding('unreachable-resource', x as unknown as Record<string, unknown>)),
    ...data.stalePeers.map((x) => buildFinding('stale-peer', x as unknown as Record<string, unknown>)),
  ];
}

export default function Cleanup() {
  const [staleDays, setStaleDays] = useState(30);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [showIgnored, setShowIgnored] = useState(false);
  const { data, isLoading, isFetching, refetch } = useCleanupScan(staleDays);
  const setIgnore = useSetCleanupIgnore();

  const findings = useMemo<Finding[]>(() => (data ? reportFindings(data) : []), [data]);
  const ignoredFindings = useMemo<Finding[]>(
    () => (data?.ignored || []).map((x: CleanupIgnored) => buildFinding(x.category, x as unknown as Record<string, unknown>)),
    [data],
  );

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of findings) m[f.category] = (m[f.category] || 0) + 1;
    return m;
  }, [findings]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return findings.filter((f) =>
      (!category || f.category === category)
      && (!q || f.name.toLowerCase().includes(q) || f.detail.toLowerCase().includes(q)));
  }, [findings, search, category]);

  const { sorted, state: sortState } = useTableSort(filtered, {
    type: (f) => CATEGORY_META[f.category].label,
    name: (f) => f.name.toLowerCase(),
    detail: (f) => (f.weight ? -f.weight : f.detail.toLowerCase()),
  }, { key: 'type' });
  const { pageRows, page, setPage, perPage, setPerPage, totalPages, total } = useClientPagination(sorted, 25, [search, category, staleDays]);

  const toggleIgnore = (f: Finding, ignore: boolean) =>
    setIgnore.mutate({ category: f.category, id: f.id, name: f.name, ignore });

  const tiles: { cat: CleanupCategory; icon: React.JSX.Element }[] = [
    { cat: 'orphaned-policy', icon: <Shield size={15} /> },
    { cat: 'ineffective-policy', icon: <Shield size={15} /> },
    { cat: 'empty-group', icon: <Users size={15} /> },
    { cat: 'unreachable-resource', icon: <Package size={15} /> },
    { cat: 'stale-peer', icon: <MonitorSmartphone size={15} /> },
  ];

  return (
    <div>
      <p className="text-nb-gray-500 text-sm mb-5">
        Leftovers that accumulate over time - dangling policies, unused groups, unreachable resources and
        long-offline devices. Nothing is deleted automatically; review and clean what you recognize - or mark a
        finding as <b>ignored</b> when it is deliberate (e.g. a resource kept without default policies, reachable
        only via access requests).
      </p>

      {isLoading ? <LoadingState /> : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
            {tiles.map(({ cat, icon }) => {
              const meta = CATEGORY_META[cat];
              const n = counts[cat] || 0;
              const active = category === cat;
              return (
                <button
                  key={cat} type="button"
                  onClick={() => setCategory(active ? '' : cat)}
                  title={meta.explain}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors cursor-pointer',
                    active
                      ? 'border-netbird/60 bg-netbird/5'
                      : 'border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 hover:border-nb-gray-300 dark:hover:border-nb-gray-700',
                  )}
                >
                  <div className="flex items-center gap-2 text-nb-gray-500 text-[0.75rem]">{icon}<span className="truncate">{meta.label}s</span></div>
                  <div className={cn('mt-1 text-xl font-semibold tabular-nums', n ? 'text-nb-gray-900 dark:text-nb-gray-100' : 'text-nb-gray-400 dark:text-nb-gray-600')}>{n}</div>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3 mb-5">
            <SearchInput value={search} onChange={setSearch} placeholder="Search findings…" />
            <div className="w-56"><SelectMenu value={category} onChange={setCategory} searchable={false} options={CATEGORY_OPTIONS} /></div>
            <div className="w-48"><SelectMenu value={String(staleDays)} onChange={(v) => setStaleDays(Number(v))} searchable={false} options={STALE_OPTIONS} /></div>
            <ToolbarMenu icon={<Rows3 size={15} />} label={`${perPage} rows per page`} value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={ROWS_PER_PAGE_OPTIONS} align="end" width={185} />
            <ClearFiltersButton active={!!search || !!category} onClear={() => { setSearch(''); setCategory(''); }} />
            <div className="ml-auto flex items-center gap-3">
              {data?.scannedAt && <span className="text-[0.75rem] text-nb-gray-500 hidden sm:inline">Scanned {formatTimestamp(data.scannedAt)}</span>}
              <IconButton onClick={() => refetch()} title="Rescan" className="h-[42px] w-[42px]">
                <RefreshCw size={15} className={cn(isFetching && 'animate-spin')} />
              </IconButton>
            </div>
          </div>

          {!findings.length ? (
            <EmptyState title="All Clean" hint="No dangling policies, unused groups, unreachable resources or stale devices were found." />
          ) : !filtered.length ? (
            <EmptyState title="No Matching Findings" hint="Try clearing the search or the category filter." />
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <THead>
                    <SortTh label="Type" sortKey="type" state={sortState} />
                    <SortTh label="Name" sortKey="name" state={sortState} />
                    <SortTh label="Details" sortKey="detail" state={sortState} />
                    <Th> </Th>
                  </THead>
                  <TBody>
                    {pageRows.map((f) => {
                      const meta = CATEGORY_META[f.category];
                      return (
                        <Tr key={f.key}>
                          <Td><Badge tone={meta.tone}>{meta.label}</Badge></Td>
                          <Td>
                            {f.link
                              ? <Link to={f.link} className="text-sm font-medium text-nb-gray-900 dark:text-nb-gray-100 hover:text-netbird break-all">{f.name}</Link>
                              : <span className="text-sm font-medium text-nb-gray-900 dark:text-nb-gray-100 break-all">{f.name}</span>}
                          </Td>
                          <Td><span className="text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">{f.detail}</span></Td>
                          <Td>
                            <span className="flex items-center gap-2 justify-end whitespace-nowrap">
                              {f.link && <Link to={f.link} className="text-[0.8rem] text-netbird hover:underline">Open</Link>}
                              <button type="button" onClick={() => toggleIgnore(f, true)} disabled={setIgnore.isPending}
                                title="Ignore - this is known and deliberate; it will stop appearing here and in the weekly digest"
                                className="text-nb-gray-400 hover:text-nb-gray-700 dark:hover:text-nb-gray-200 transition-colors">
                                <EyeOff size={15} />
                              </button>
                            </span>
                          </Td>
                        </Tr>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
              <div className="md:hidden flex flex-col gap-2.5">
                {pageRows.map((f) => {
                  const meta = CATEGORY_META[f.category];
                  return (
                    <div key={f.key} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        <span className="flex items-center gap-3">
                          {f.link && <Link to={f.link} className="text-[0.8rem] text-netbird hover:underline shrink-0">Open</Link>}
                          <button type="button" onClick={() => toggleIgnore(f, true)} disabled={setIgnore.isPending} title="Ignore"
                            className="text-nb-gray-400 hover:text-nb-gray-700 dark:hover:text-nb-gray-200">
                            <EyeOff size={15} />
                          </button>
                        </span>
                      </div>
                      <div className="mt-2 text-sm font-medium break-all text-nb-gray-900 dark:text-nb-gray-100">{f.name}</div>
                      <div className="mt-1 text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300">{f.detail}</div>
                    </div>
                  );
                })}
              </div>
              <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} label="findings" />
            </>
          )}

          {ignoredFindings.length > 0 && (
            <div className="mt-6">
              <button type="button" onClick={() => setShowIgnored((v) => !v)}
                className="inline-flex items-center gap-1.5 text-[0.85rem] text-nb-gray-500 hover:text-nb-gray-700 dark:hover:text-nb-gray-300 transition-colors">
                {showIgnored ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {ignoredFindings.length} Ignored Finding{ignoredFindings.length === 1 ? '' : 's'}
              </button>
              {showIgnored && (
                <div className="mt-2.5 flex flex-col gap-2">
                  {ignoredFindings.map((f) => {
                    const meta = CATEGORY_META[f.category];
                    return (
                      <div key={`ign:${f.key}`} className="flex flex-wrap items-center gap-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/40 px-3.5 py-2.5 opacity-75">
                        <Badge tone="gray">{meta.label}</Badge>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-nb-gray-700 dark:text-nb-gray-200 break-all">{f.name}</span>
                          <span className="block text-[0.76rem] text-nb-gray-500">{f.detail}</span>
                        </span>
                        <button type="button" onClick={() => toggleIgnore(f, false)} disabled={setIgnore.isPending}
                          title="Stop ignoring - the finding returns to the list and the weekly digest"
                          className="inline-flex items-center gap-1.5 text-[0.8rem] text-nb-gray-500 hover:text-netbird transition-colors shrink-0">
                          <Eye size={14} /> Unignore
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
