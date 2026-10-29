import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { formatMaybeDate } from '@/lib/logfmt';
import { useTableSort } from '@/lib/useTableSort';
import type { DetailPeer } from '@/lib/types';
import { EmptyState, Table, THead, SortTh, TBody, Tr, Td } from '@/components/ui';

/** Read-only peers table used inside the group and user detail pages. Rows link to
 *  the peer detail page. */
export function PeersMiniTable({ peers, showOwner = false }: { peers: DetailPeer[]; showOwner?: boolean }) {
  const navigate = useNavigate();
  const { sorted, state } = useTableSort(peers, {
    name: (p) => p.name,
    address: (p) => p.dns_label || p.ip,
    os: (p) => p.os,
    owner: (p) => p.owner_email,
    last_seen: (p) => p.last_seen,
  });
  if (!peers.length) return <EmptyState title="No Peers" hint="No peers are assigned here." />;
  return (
    <>
    <div className="hidden md:block">
    <Table>
      <THead>
        <SortTh label="Name" sortKey="name" state={state} />
        <SortTh label="Address" sortKey="address" state={state} />
        <SortTh label="OS" sortKey="os" state={state} />
        {showOwner ? <SortTh label="Owner" sortKey="owner" state={state} /> : null}
        <SortTh label="Last Seen" sortKey="last_seen" state={state} />
      </THead>
      <TBody>
        {sorted.map((p) => (
          <Tr key={p.id} onClick={() => navigate(`/peers/${encodeURIComponent(p.id)}`)}>
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
            {showOwner ? <Td><span className="text-sm text-nb-gray-600 dark:text-nb-gray-400">{p.owner_email || '-'}</span></Td> : null}
            <Td><span className="text-[0.82rem] text-nb-gray-500">{p.connected ? 'Connected' : formatMaybeDate(p.last_seen)}</span></Td>
          </Tr>
        ))}
      </TBody>
    </Table>
    </div>

    {/* Mobile: cards instead of a wide table */}
    <div className="md:hidden flex flex-col gap-2.5">
      {sorted.map((p) => (
        <div key={p.id} onClick={() => navigate(`/peers/${encodeURIComponent(p.id)}`)}
          className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors">
          <div className="flex items-center gap-2.5">
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
            {p.version && <span>· {p.version}</span>}
            {showOwner && p.owner_email && <span className="break-all">· {p.owner_email}</span>}
          </div>
        </div>
      ))}
    </div>
    </>
  );
}
