import { useState, type ReactNode } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/cn';

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch { /* fall through to legacy path */ }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(ta);
}

/** A small icon button that copies `value` to the clipboard, with a brief check on success. */
export function CopyButton({ value, className, title = 'Copy', size = 13 }: { value: string; className?: string; title?: string; size?: number }) {
  const [done, setDone] = useState(false);
  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    await copyText(value);
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={done ? 'Copied!' : title}
      aria-label={done ? 'Copied' : title}
      className={cn('inline-flex items-center justify-center text-nb-gray-400 hover:text-netbird transition-colors', className)}
    >
      {done ? <Check size={size} className="text-green-500" /> : <Copy size={size} />}
    </button>
  );
}

/**
 * Wraps a value with a copy icon that appears on hover (and on keyboard focus).
 * Children render the visible value; `value` is what gets copied.
 */
export function Copyable({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  if (!value) return <>{children}</>;
  return (
    <span className={cn('group/copy inline-flex items-center gap-1.5 max-w-full', className)}>
      {children}
      <CopyButton value={value} className="opacity-0 group-hover/copy:opacity-100 focus:opacity-100 shrink-0" />
    </span>
  );
}
