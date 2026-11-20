import { useState } from 'react';
import { ChevronRight, Share2 } from 'lucide-react';
import { Modal, Spinner } from '@/components/ui';
import { useNetworkDetail } from '@/lib/queries';
import { ResourceModal } from './ResourceModal';

// "Add As Resource" from Remote Access and Troubleshoot, all in one modal: first the network (when
// the user may add to more than one), then the Networks page's own Add Resource form for it, with
// the same data that page passes (the network's resources for the duplicate checks, and its
// duplicate setting), prefilled with the address that was checked. The save is the ordinary
// POST /api/networks/:id/resources.
export function AddResourceModal({ networks, address, onCreated, onUncertain, onClose }: {
  networks: { id: string; name: string }[];
  address: string;
  onCreated: (resourceId: string) => void;
  onUncertain: () => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(networks.length === 1 ? networks[0].id : null);
  if (!chosen) {
    return (
      <Modal open onClose={onClose} icon={<Share2 size={18} />} title="Add Resource"
        subtitle={`Choose the network ${address} is added to.`}>
        <ul className="flex flex-col gap-2 py-1">
          {networks.map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => setChosen(n.id)} title={n.name || n.id}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-nb-gray-200 px-4 py-3 text-left text-[0.92rem] font-medium text-nb-gray-800 transition-colors hover:border-netbird-500 hover:bg-netbird-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-netbird-700 dark:border-nb-gray-800 dark:text-nb-gray-100 dark:hover:border-netbird-500 dark:hover:bg-nb-gray-900 dark:focus-visible:outline-netbird-400">
                <span className="truncate">{n.name || n.id}</span>
                <ChevronRight size={16} className="shrink-0 text-nb-gray-400" />
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    );
  }
  return <AddToNetwork networkId={chosen} address={address} onCreated={onCreated} onUncertain={onUncertain} onClose={onClose} />;
}

function AddToNetwork({ networkId, address, onCreated, onUncertain, onClose }: {
  networkId: string;
  address: string;
  onCreated: (resourceId: string) => void;
  onUncertain: () => void;
  onClose: () => void;
}) {
  const detail = useNetworkDetail(networkId);
  if (!detail.data) {
    return (
      <Modal open onClose={onClose} icon={<Share2 size={18} />} title="Add Resource" size="lg"
        subtitle="Add a resource to this network and control which peers can access it.">
        {detail.isError
          ? <p className="py-6 text-sm text-red-500">The network couldn't be loaded. Close this and try again.</p>
          : <div className="flex justify-center py-10"><Spinner /></div>}
      </Modal>
    );
  }
  const resources = detail.data.resources || [];
  return (
    <ResourceModal
      networkId={networkId}
      resource={null}
      existingNames={resources.map((r) => r.name || '')}
      existingResources={resources.map((r) => ({ name: r.name || '', address: r.address || '' }))}
      allowDuplicates={detail.data.allowDuplicates}
      initialAddress={address}
      onCreated={onCreated}
      onUncertain={onUncertain}
      onClose={onClose}
    />
  );
}
