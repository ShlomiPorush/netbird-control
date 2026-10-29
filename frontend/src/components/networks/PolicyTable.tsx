import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FolderGit2, ShieldCheck, ArrowRight, ArrowLeftRight, Share2, MonitorSmartphone, Layers3, Layers } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTableSort } from '@/lib/useTableSort';
import type { PolicyGroupRef, PolicyResourceRef } from '@/lib/types';
import { Badge, EmptyState, Table, THead, Th, SortTh, TBody, Tr, Td, HoverCard, Pagination } from '@/components/ui';

export interface PolicyRow {
  id: string;
  name: string;
  enabled: boolean;
  sources: PolicyGroupRef[];
  destinations: PolicyGroupRef[];
  destinationResources?: PolicyResourceRef[]; // one per rule that targets a resource directly
  bidirectional: boolean;
  protocol: string;
  ports: string[];
  /** Set when a shared Access Profile owns this policy - shown as a badge (managed there). */
  profileName?: string;
}

// A policy can target specific resources directly (a rule's `destinationResource`) instead of
// groups — show every such resource across the rules, not just the first rule.
function DestinationCell({ p }: { p: PolicyRow }) {
  const res = p.destinationResources || [];
  if (res.length) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {res.map((r) => <Badge key={r.id} tone="gray" icon={<Share2 size={11} />}>{r.name}</Badge>)}
      </div>
    );
  }
  return <GroupsCell items={p.destinations} metric="resources" />;
}

const linkBadge = 'hover:border-netbird/40 hover:text-netbird transition-colors cursor-pointer';

function GroupLink({ group }: { group: PolicyGroupRef }) {
  return (
    <Link to={`/groups/${encodeURIComponent(group.id)}`}>
      <Badge tone="gray" icon={<FolderGit2 size={11} />} className={linkBadge}>{group.name}</Badge>
    </Link>
  );
}

// Sources/Destinations cell - a single group links straight to it, multiple collapse to
// "N Groups"; hovering reveals the "Assigned Groups" popup (each group + its count). The popup
// is rendered in a fixed-position portal so it's never clipped by the table's overflow.
function GroupsCell({ items, metric }: { items: PolicyGroupRef[]; metric: 'peers' | 'resources' }) {
  if (!items.length) return <span className="text-nb-gray-500 text-xs italic">All</span>;
  // A single group is shown inline (its badge already links to the group). The floating breakdown
  // popup is only for the collapsed "N Groups" case, where the individual groups aren't visible -
  // showing it for one group just duplicates the visible badge as a detached floating card.
  if (items.length === 1) return <GroupLink group={items[0]} />;

  return (
    <HoverCard
      trigger={<Badge tone="gray" icon={<FolderGit2 size={11} />} className="cursor-default">{items.length} Groups</Badge>}
    >
      <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-2.5">Assigned Groups</div>
      <div className="nb-scroll flex flex-col gap-2 max-h-72 overflow-y-auto overflow-x-hidden">
        {items.map((g) => (
          <div key={g.id} className="flex items-center gap-2.5 min-w-0">
            {/* The group name takes the remaining width and truncates, so a long name can't
                push the row past the popup's edge. */}
            <Link to={`/groups/${encodeURIComponent(g.id)}`} className="min-w-0 flex-1">
              <Badge tone="gray" icon={<FolderGit2 size={11} className="shrink-0" />} className={cn(linkBadge, 'flex w-full min-w-0')}>
                <span className="truncate">{g.name}</span>
              </Badge>
            </Link>
            <ArrowRight size={14} className="text-nb-gray-400 shrink-0" />
            <Link to={`/groups/${encodeURIComponent(g.id)}?tab=${metric === 'peers' ? 'peers' : 'resources'}`} className="shrink-0" title={`View this group's ${metric}`}>
              <Badge tone="gray" className={cn(linkBadge)} icon={metric === 'peers' ? <MonitorSmartphone size={11} /> : <Layers3 size={11} />}>
                {metric === 'peers'
                  ? `${g.peers_count} Peer${g.peers_count === 1 ? '' : 's'}`
                  : `${g.resources_count} Resource${g.resources_count === 1 ? '' : 's'}`}
              </Badge>
            </Link>
          </div>
        ))}
      </div>
    </HoverCard>
  );
}

function DirectionPill({ bidirectional }: { bidirectional: boolean }) {
  return (
    <span
      title={bidirectional ? 'Bidirectional' : 'One-way'}
      className="inline-flex items-center justify-center min-w-[64px] h-7 px-3 rounded-md border border-nb-blue-400/40 bg-nb-blue-400/10 text-nb-blue-600 dark:text-nb-blue-400"
    >
      {bidirectional ? <ArrowLeftRight size={15} /> : <ArrowRight size={15} />}
    </span>
  );
}

/** NetBird-style access-control policy table (Name / Sources / Direction / Destinations
 *  / Proto & Ports). Shared by the Group detail and Network detail pages. When `onRowClick`
 *  / `rowActions` are passed (admin Policies page) rows become clickable with a trailing
 *  actions cell. */
export function PolicyTable({
  policies, emptyHint = 'No access-control policy found.', onRowClick, rowActions, pagination,
}: {
  policies: PolicyRow[];
  emptyHint?: string;
  onRowClick?: (p: PolicyRow) => void;
  rowActions?: (p: PolicyRow) => ReactNode;
  // Optional client pagination (the admin Policies page). Sorting happens first, then this
  // slices the current page; the parent owns the page/perPage state + the toolbar control.
  pagination?: { page: number; perPage: number; onPage: (p: number) => void; label?: string };
}) {
  const { sorted, state } = useTableSort(policies, {
    name: (p) => p.name,
    sources: (p) => p.sources.length,
    direction: (p) => (p.bidirectional ? 1 : 0),
    destinations: (p) => p.destinations.length,
    proto: (p) => p.protocol,
  });
  if (!policies.length) return <EmptyState title="No Policies" hint={emptyHint} icon={<ShieldCheck size={22} />} />;
  const totalPages = pagination ? Math.max(1, Math.ceil(sorted.length / pagination.perPage)) : 1;
  const pageRows = pagination
    ? sorted.slice((pagination.page - 1) * pagination.perPage, pagination.page * pagination.perPage)
    : sorted;
  return (
    <>
    <div className="hidden md:block">
    <Table>
      <THead>
        <SortTh label="Name" sortKey="name" state={state} />
        <SortTh label="Sources" sortKey="sources" state={state} />
        <SortTh label="Direction" sortKey="direction" state={state} />
        <SortTh label="Destinations" sortKey="destinations" state={state} />
        <SortTh label="Proto & Ports" sortKey="proto" state={state} />
        {rowActions && <Th className="text-right">{''}</Th>}
      </THead>
      <TBody>
        {pageRows.map((p) => (
          <Tr key={p.id} onClick={onRowClick ? () => onRowClick(p) : undefined} className={onRowClick ? 'cursor-pointer' : undefined}>
            <Td>
              <div className="flex items-center gap-2.5">
                <span className={cn('h-2 w-2 rounded-full shrink-0', p.enabled ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
                <span className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{p.name || '-'}</span>
                {p.profileName && (
                  <span className="shrink-0" title={`Managed by the "${p.profileName}" Access Profile - edit it under Operations → Access Profiles`}>
                    <Badge tone="cyan" icon={<Layers size={11} />}>Profile</Badge>
                  </span>
                )}
              </div>
            </Td>
            <Td><GroupsCell items={p.sources} metric="peers" /></Td>
            <Td><DirectionPill bidirectional={p.bidirectional} /></Td>
            <Td><DestinationCell p={p} /></Td>
            <Td>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge tone="gray" icon={<Share2 size={11} />} className="uppercase">{p.protocol || 'all'}</Badge>
                <Badge tone="gray" className="uppercase">{p.ports.length ? p.ports.join(', ') : 'all'}</Badge>
              </div>
            </Td>
            {rowActions && (
              <Td className="text-right" onClick={(e) => e.stopPropagation()}>{rowActions(p)}</Td>
            )}
          </Tr>
        ))}
      </TBody>
    </Table>
    </div>

    {/* Mobile: cards instead of a wide table */}
    <div className="md:hidden flex flex-col gap-2.5">
      {pageRows.map((p) => (
        <div key={p.id} onClick={onRowClick ? () => onRowClick(p) : undefined}
          className={cn('rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5', onRowClick && 'cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors')}>
          <div className="flex items-center gap-2.5">
            <span className={cn('h-2 w-2 rounded-full shrink-0', p.enabled ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
            <span className="flex-1 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{p.name || '-'}</span>
            {p.profileName && (
              <span className="shrink-0" title={`Managed by the "${p.profileName}" Access Profile`}>
                <Badge tone="cyan" icon={<Layers size={11} />}>Profile</Badge>
              </span>
            )}
            {rowActions && <div className="shrink-0 -mr-1" onClick={(e) => e.stopPropagation()}>{rowActions(p)}</div>}
          </div>
          <div className="mt-3 flex items-center gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
            <GroupsCell items={p.sources} metric="peers" />
            <DirectionPill bidirectional={p.bidirectional} />
            <DestinationCell p={p} />
          </div>
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            <Badge tone="gray" icon={<Share2 size={11} />} className="uppercase">{p.protocol || 'all'}</Badge>
            <Badge tone="gray" className="uppercase">{p.ports.length ? p.ports.join(', ') : 'all'}</Badge>
          </div>
        </div>
      ))}
    </div>
    {pagination && (
      <Pagination page={pagination.page} totalPages={totalPages} onPage={pagination.onPage} total={sorted.length} label={pagination.label || 'policies'} />
    )}
    </>
  );
}
