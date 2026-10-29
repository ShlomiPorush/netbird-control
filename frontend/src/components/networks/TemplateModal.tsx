import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Modal, Input, SelectMenu, Field, Button, PortSelector } from '@/components/ui';
import { useSaveTemplate } from '@/lib/mutations';
import type { Template } from '@/lib/types';
import { cn } from '@/lib/cn';

const PORTS_HINT = 'Allow network traffic and access only to specified ports. Select ports or port ranges between 1 and 65535.';

export function TemplateModal({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const save = useSaveTemplate();
  const [name, setName] = useState(template?.name || '');
  const [protocol, setProtocol] = useState(template?.protocol || 'all');
  const [ports, setPorts] = useState<string[]>(template?.ports || []);
  const [description, setDescription] = useState(template?.description || '');
  const [error, setError] = useState('');

  const showPorts = protocol === 'tcp' || protocol === 'udp';

  const submit = async () => {
    if (!name.trim()) { setError('Name is required.'); return; }
    setError('');
    const payload = {
      name: name.trim(),
      protocol,
      ports: showPorts ? ports : [],
      description: description.trim(),
    };
    try {
      await save.mutateAsync({ id: template?.id, payload });
      onClose();
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={<SlidersHorizontal size={18} />}
      title={template ? 'Edit Template' : 'Add Template'}
      subtitle="A reusable protocol/port preset for resource policies."
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending}>{save.isPending ? '…' : 'Save'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Web (443)" /></Field>
        <Field label="Protocol">
          <SelectMenu value={protocol} onChange={(v) => setProtocol(v)} searchable={false}
            options={[
              { value: 'all', label: 'All' },
              { value: 'tcp', label: 'TCP' },
              { value: 'udp', label: 'UDP' },
              { value: 'icmp', label: 'ICMP' },
            ]} />
        </Field>
        <div className={cn(!showPorts && 'hidden')}>
          <Field label="Ports" hint={PORTS_HINT}>
            <PortSelector value={ports} onChange={setPorts} />
          </Field>
        </div>
        <Field label="Description (Optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
