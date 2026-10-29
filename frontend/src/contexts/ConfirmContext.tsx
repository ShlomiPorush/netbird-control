import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [resolver, setResolver] = useState<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => setResolver(() => resolve));
  }, []);

  const close = (result: boolean) => {
    if (resolver) resolver(result);
    setResolver(null);
    setOpts(null);
  };

  // Enter confirms the dialog (Escape cancels via the Modal). Ignored while typing in
  // an input/textarea so it never fires unexpectedly.
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === 'Enter' && !typing) { e.preventDefault(); close(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts, resolver]);

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Modal
        open={!!opts}
        onClose={() => close(false)}
        title={opts?.title || 'Are You Sure?'}
        icon={<Trash2 size={18} />}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => close(false)}>Cancel</Button>
            <Button variant={opts?.danger === false ? 'primary' : 'danger'} size="sm" onClick={() => close(true)}>
              {opts?.confirmText || 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-[0.9rem] leading-relaxed text-nb-gray-600 dark:text-nb-gray-400">{opts?.message}</p>
      </Modal>
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const v = useContext(Ctx);
  if (!v) throw new Error('useConfirm must be used within ConfirmProvider');
  return v;
}
