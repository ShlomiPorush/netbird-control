import { useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import { useNetworks, useNetworkDefaultProfiles, useAccessProfiles } from '@/lib/queries';
import { useTableSort } from '@/lib/useTableSort';
import type { Network } from '@/lib/types';
import { Badge, Button, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td } from '@/components/ui';
import { GrantsModal } from '@/components/networks/GrantsModal';

export function NetworkAccess() {
  const { data, isLoading } = useNetworks();
  const { data: defaultsMap } = useNetworkDefaultProfiles();
  const { data: profiles } = useAccessProfiles();
  const [grants, setGrants] = useState<Network | null>(null);
  const list = data || [];

  // id → name for shared profiles, to render the default-profile chips.
  const profName = useMemo(() => {
    const m = new Map((profiles || []).filter((p) => p.shared).map((p) => [p.id, p.name]));
    return (id: number) => m.get(id);
  }, [profiles]);
  const defaultsOf = (id: string): number[] => (defaultsMap?.[id] || []);

  const { sorted, state } = useTableSort(list, {
    name: (n) => n.name || n.id,
    editable: (n) => (n.grants?.length ? n.grants.map((g) => g.name).join(', ') : 'Admins only'),
    defaultProfile: (n) => (defaultsOf(n.id).map(profName).filter(Boolean) as string[]).join(', '),
  });
  return (
    <div>
      <p className="text-nb-gray-500 text-sm mb-5">Choose which AD groups may edit or view (read-only) each network, and an optional default Access Profile for new resources there.</p>
      {isLoading ? <LoadingState /> : !list.length ? <EmptyState title="No Networks" /> : (
        <Table>
          <THead>
            <SortTh label="Network" sortKey="name" state={state} />
            <SortTh label="Access" sortKey="editable" state={state} />
            <SortTh label="Default Profile" sortKey="defaultProfile" state={state} />
            <Th className="text-right">{''}</Th>
          </THead>
          <TBody>
            {sorted.map((n) => {
              const defNames = defaultsOf(n.id).map(profName).filter(Boolean) as string[];
              return (
                <Tr key={n.id} onClick={() => setGrants(n)}>
                  <Td><span className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{n.name || n.id}</span></Td>
                  <Td>
                    {n.grants?.length
                      ? <div className="flex flex-wrap gap-1.5">{n.grants.map((g) => (
                          <Badge key={g.id} tone={g.access === 'view' ? 'cyan' : g.access === 'source' ? 'orange' : 'gray'} icon={g.access === 'view' ? <Eye size={11} /> : undefined}>{g.name}</Badge>
                        ))}</div>
                      : <Badge tone="orange">Admins Only</Badge>}
                  </Td>
                  <Td>
                    {defNames.length
                      ? <div className="flex flex-wrap gap-1.5">{defNames.map((name) => <Badge key={name} tone="cyan">{name}</Badge>)}</div>
                      : <span className="text-nb-gray-500 text-xs">-</span>}
                  </Td>
                  <Td className="text-right" onClick={(e) => e.stopPropagation()}><Button variant="secondary" size="sm" onClick={() => setGrants(n)}>Manage</Button></Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}
      {grants && (
        <GrantsModal
          networkId={grants.id}
          networkName={grants.name || grants.id}
          currentGrants={grants.grants || []}
          currentDefaultProfileIds={defaultsOf(grants.id)}
          onClose={() => setGrants(null)}
        />
      )}
    </div>
  );
}
