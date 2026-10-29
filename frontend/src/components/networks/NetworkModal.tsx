import { useState } from 'react';
import { GitFork } from 'lucide-react';
import { Modal, Field, Input, Textarea, Button, Checkbox, FieldHint } from '@/components/ui';
import { useCreateNetwork, useUpdateNetwork } from '@/lib/mutations';
import type { Network } from '@/lib/types';

// Create + edit modal for a network. Name/description go to NetBird (the same POST/PUT the
// official dashboard's NetworkModal makes); "Allow Duplicate Addresses" is this app's own
// per-network opt-out of the duplicate/overlapping-address guard on resources.
export function NetworkModal({ network, onClose, onCreated }: {
  network?: Pick<Network, 'id' | 'name' | 'description' | 'allowDuplicates'> | null; // absent = create
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const create = useCreateNetwork();
  const update = useUpdateNetwork();
  const isEdit = !!network;
  const [name, setName] = useState(network?.name || '');
  const [description, setDescription] = useState(network?.description || '');
  const [allowDup, setAllowDup] = useState(!!network?.allowDuplicates);
  const [error, setError] = useState('');
  const busy = create.isPending || update.isPending;

  const submit = async () => {
    if (!name.trim()) { setError('Name is required.'); return; }
    setError('');
    try {
      if (isEdit && network) {
        await update.mutateAsync({ id: network.id, name: name.trim(), description: description.trim(), allowDuplicates: allowDup });
        onClose();
      } else {
        const out = await create.mutateAsync({ name: name.trim(), description: description.trim() });
        if (out?.id && allowDup) await update.mutateAsync({ id: out.id, allowDuplicates: true });
        if (out?.id && onCreated) onCreated(out.id); else onClose();
      }
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<GitFork size={18} />}
      title={isEdit ? 'Edit Network' : 'Create Network'}
      subtitle={isEdit ? (network?.name || network?.id) : 'Add a new network. You can add resources and routing peers to it afterwards.'}
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save Changes' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} placeholder="e.g. Production" autoFocus maxLength={60} />
        </Field>
        <Field label="Description (Optional)">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="e.g. Production servers and databases" />
        </Field>
        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <Checkbox checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} className="mt-0.5" />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm text-nb-gray-800 dark:text-nb-gray-100">Allow Duplicate Addresses</span>
            <FieldHint>
              Skip the duplicate/overlapping-address check for resources in this network - for setups that
              intentionally reuse the same addresses (e.g. identical private ranges behind different routing peers).
            </FieldHint>
          </span>
        </label>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
