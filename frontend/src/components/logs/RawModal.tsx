import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

export function RawModal({ data, onClose, title = 'Raw Webhook Data' }: { data: unknown; onClose: () => void; title?: string }) {
  const [copied, setCopied] = useState(false);
  const display = data && typeof data === 'object' && 'raw_json' in (data as Record<string, unknown>)
    ? (data as Record<string, unknown>).raw_json
    : data;
  const json = JSON.stringify(display, null, 2);

  const copy = () => {
    navigator.clipboard.writeText(json).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <Modal
      open={!!data}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied!' : 'Copy JSON'}
        </Button>
      }
    >
      <pre className="text-[0.8rem] leading-relaxed font-mono text-nb-blue-700 dark:text-nb-blue-300 bg-nb-gray-100 dark:bg-black/40 rounded-lg p-4 overflow-auto max-h-[60vh] whitespace-pre-wrap wrap-break-word">
        {json}
      </pre>
    </Modal>
  );
}
