import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, SearchIcon, XIcon, CornerDownLeft, Copy, ClipboardPaste, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { registerPopup } from '@/lib/popupBus';

interface Props {
  value: string[];
  onChange: (ports: string[]) => void;
  disabled?: boolean;
}

const isValidPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;

function isValidToken(v: string): boolean {
  const t = v.trim();
  if (/^\d{1,5}-\d{1,5}$/.test(t)) {
    const [s, e] = t.split('-').map(Number);
    return isValidPort(s) && isValidPort(e) && s < e;
  }
  return isValidPort(Number(t));
}

// Faithful port of NetBird's PortSelector: port/range chips + a popover where you
// type a port or a range and press Enter to add it.
export function PortSelector({ value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, above: false });

  const trimmed = search.trim();
  const canAdd = useMemo(() => !!trimmed && isValidToken(trimmed) && !value.includes(trimmed), [trimmed, value]);
  const invalidTyped = !!trimmed && !isValidToken(trimmed);

  // Only one popup panel open app-wide (see lib/popupBus).
  useEffect(() => { if (open) return registerPopup(() => setOpen(false)); }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const above = spaceBelow < 260 && r.top > spaceBelow;
      setPos({ left: r.left, top: above ? r.top : r.bottom, width: r.width, above });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const add = (token: string) => {
    const t = token.trim();
    if (!isValidToken(t) || value.includes(t)) return;
    onChange([...value, t]);
    setSearch('');
  };
  const remove = (token: string) => onChange(value.filter((p) => p !== token));

  // Copy/paste the whole port list - policies often carry dozens of ports, and re-typing
  // them into another policy was painful. Copy → "80, 443, 39100-39200"; paste accepts any
  // comma/space/newline separated mix and keeps only valid, non-duplicate tokens.
  const [copied, setCopied] = useState(false);
  const [pasteState, setPasteState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copyPorts = async () => {
    try {
      await navigator.clipboard.writeText(value.join(', '));
      setCopied(true); setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable - nothing to signal */ }
  };
  const pastePorts = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const tokens = text.replace(/\s*-\s*/g, '-').split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean).filter(isValidToken);
      const merged = [...value];
      for (const t of tokens) if (!merged.includes(t)) merged.push(t);
      if (merged.length > value.length) { onChange(merged); setPasteState('ok'); }
      else setPasteState('fail');
    } catch { setPasteState('fail'); }
    setTimeout(() => setPasteState('idle'), 1200);
  };

  return (
    <>
      <div
        ref={triggerRef}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          'min-h-[48px] w-full relative items-center',
          'border border-neutral-200 dark:border-nb-gray-700 justify-between py-2 px-3',
          'rounded-md bg-white text-sm dark:bg-nb-gray-900/40 flex dark:text-neutral-400/70 text-neutral-500 cursor-pointer dark:hover:bg-nb-gray-900/50 transition-all',
          disabled && 'opacity-60 pointer-events-none',
        )}
      >
        <div className="flex items-center gap-2 flex-wrap h-full">
          {value.map((x) => (
            <PortChip key={x} label={x} onRemove={() => remove(x)} />
          ))}
          {value.length === 0 && <span className="pl-1">Select ports...</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {value.length > 0 && (
            <button type="button" onClick={copyPorts} title="Copy all ports"
              className="p-1.5 rounded-md text-nb-gray-400 hover:text-nb-gray-700 dark:hover:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800 transition-colors">
              {copied ? <Check size={15} className="text-green-500" /> : <Copy size={15} />}
            </button>
          )}
          <button type="button" onClick={pastePorts} title="Paste ports (e.g. 80, 443, 39100-39200)"
            className="p-1.5 rounded-md text-nb-gray-400 hover:text-nb-gray-700 dark:hover:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800 transition-colors">
            {pasteState === 'ok' ? <Check size={15} className="text-green-500" />
              : pasteState === 'fail' ? <XIcon size={15} className="text-red-500" />
              : <ClipboardPaste size={15} />}
          </button>
          <ChevronsUpDown size={18} className="shrink-0" onClick={() => !disabled && setOpen((o) => !o)} />
        </div>
      </div>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, zIndex: 1100 }}
          className={cn(pos.above ? '-translate-y-full -mt-2.5' : 'mt-2.5')}
        >
          <div className="rounded-md border border-neutral-200 dark:border-nb-gray-900 bg-white dark:bg-nb-gray-950 shadow-lg shadow-nb-gray-950 overflow-hidden">
            <div className="relative border-b border-neutral-200 dark:border-nb-gray-700">
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(search); } }}
                placeholder='Add a port or a range e.g. 80 or 1-1023 and press "Enter" to add...'
                className="min-h-[42px] w-full bg-transparent text-sm outline-hidden font-light dark:text-nb-gray-100 dark:placeholder:text-nb-gray-400 placeholder:text-neutral-500 pl-10 pr-12"
              />
              <div className="absolute left-0 top-0 h-full flex items-center pl-4 text-nb-gray-400"><SearchIcon size={14} /></div>
              <div className="absolute right-0 top-0 h-full flex items-center pr-4">
                <div className="flex items-center bg-nb-gray-100 dark:bg-nb-gray-800 py-1 px-1.5 rounded-[4px] border border-nb-gray-300 dark:border-nb-gray-500 text-nb-gray-500 dark:text-nb-gray-300">
                  <CornerDownLeft size={10} />
                </div>
              </div>
            </div>

            <div className={cn('flex flex-col gap-1', (value.length || trimmed) && 'p-2')}>
              {invalidTyped && (
                <div className="text-[0.8rem] text-neutral-500 dark:text-nb-gray-300 px-1 py-1">
                  Please add a valid port or port range (e.g. 80, 443, 1-1023)
                </div>
              )}
              {canAdd && (
                <div
                  onClick={() => add(trimmed)}
                  className="text-xs flex justify-between py-2 px-3 cursor-pointer items-center rounded-md hover:bg-nb-gray-100 dark:hover:bg-nb-gray-910 transition-colors"
                >
                  <PortBadge label={trimmed} />
                  <span className="text-neutral-500 dark:text-nb-gray-300">
                    Add by pressing <span className="font-bold text-netbird">'Enter'</span>
                  </span>
                </div>
              )}
              <div className="nb-scroll max-h-[180px] overflow-y-auto flex flex-col gap-1">
                {value.map((option) => (
                  <div
                    key={option}
                    onClick={() => remove(option)}
                    className="text-xs flex justify-between py-2 px-3 cursor-pointer items-center rounded-md hover:bg-nb-gray-100 dark:hover:bg-nb-gray-910 transition-colors"
                  >
                    <PortBadge label={option} />
                    <CheckboxBox checked />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// Badge variant "gray" (uppercase tracking-wider font-medium py-1)
function PortBadge({ label }: { label: string }) {
  return (
    <span className="relative z-10 whitespace-nowrap rounded-md flex gap-1.5 items-center justify-center uppercase tracking-wider font-medium text-[0.75rem] py-1 px-3 border bg-nb-gray-100 dark:bg-nb-gray-930/60 border-nb-gray-200 dark:border-nb-gray-800/40 text-nb-gray-600 dark:text-nb-gray-300">
      {label}
    </span>
  );
}

function PortChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <div
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
      className="relative z-10 whitespace-nowrap rounded-md flex gap-1.5 items-center justify-center uppercase tracking-wider font-medium text-[0.75rem] py-1 px-3 border cursor-pointer transition-all bg-nb-gray-100 hover:bg-nb-gray-200 dark:bg-nb-gray-930/60 dark:hover:bg-nb-gray-900 border-nb-gray-200 dark:border-nb-gray-800/40 text-nb-gray-600 dark:text-nb-gray-300"
    >
      {label}
      <XIcon size={12} className="cursor-pointer shrink-0" />
    </div>
  );
}

function CheckboxBox({ checked }: { checked: boolean }) {
  return (
    <div className="h-5 w-5">
      <div className={cn(
        'h-5 w-5 rounded-[4px] border flex items-center justify-center',
        checked ? 'bg-netbird border-netbird text-white' : 'border-neutral-300 dark:border-nb-gray-900 dark:bg-nb-gray-950',
      )}>
        {checked && <span className="text-[11px] leading-none">✓</span>}
      </div>
    </div>
  );
}
