import { Share2 } from 'lucide-react';
import { Modal, Spinner } from '@/components/ui';
import { useNetworkDetail } from '@/lib/queries';
import { ResourceModal } from './ResourceModal';

// "Add As Resource" from Remote Access and Troubleshoot: the Networks page's own Add Resource form
// for the chosen network, with the same data that page passes (the network's resources for the
// duplicate checks, and its duplicate setting), prefilled with the address that was checked.
// The save is the ordinary POST /api/networks/:id/resources.
export function AddResourceModal({ networkId, address, onCreated, onUncertain, onClose }: {
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
