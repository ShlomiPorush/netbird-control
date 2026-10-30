import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/lib/cn';
import { registerPopup } from '@/lib/popupBus';
import { IconButton } from './Button';

// A ⋮ dropdown for table rows. The menu is rendered in a fixed-position PORTAL (not
// absolutely inside the cell) so the table's `overflow-x-auto` wrapper can't clip it -
// which is what made row menus get cut off and add a stray scrollbar. It positions
// itself under the trigger, clamped to the viewport, and closes on outside click,
// scroll, resize, or Escape.
export function RowMenu({
  children, width = 180, align = 'right', title = 'More', icon,
}: {
  /** Render menu contents; call the passed `close` to dismiss after an action. */
  children: (close: () => void) => ReactNode;
  width?: number;
  align?: 'left' | 'right';
  title?: string;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const place = () => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = align === 'right'
      ? Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
      : Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({ left, top: r.bottom + 4 });
  };
  const close = () => setOpen(false);
  const toggle = () => { if (open) { close(); return; } place(); setOpen(true); };

  // Only one popup panel open app-wide (see lib/popupBus).
  useEffect(() => { if (open) return registerPopup(close); }, [open]);

  // Close (rather than chase the anchor) when the page moves out from under the menu.
  // Arrow keys move focus between the menu's action buttons (they're real <button>s,
  // so Enter/Space activate natively); focus returns to the ⋮ trigger on close.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || []);
      if (!items.length) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items[next].focus();
    };
    // Put focus into the menu so arrow keys work immediately.
    const t = setTimeout(() => panelRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus(), 0);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('keydown', onKey);
      anchorRef.current?.querySelector('button')?.focus();
    };
  }, [open]);

  return (
    <div ref={anchorRef} className="relative inline-block">
      <IconButton onClick={toggle} title={title}>{icon || <MoreVertical size={16} />}</IconButton>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-1090" onClick={close} />
          <div
            ref={panelRef}
            role="menu"
            style={{ position: 'fixed', left: pos.left, top: pos.top, width }}
            className="z-1100 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-xl p-1.5"
          >
            {children(close)}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// A single action row inside a RowMenu.
export function MenuItem({
  icon, children, onClick, danger,
}: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-sm text-sm text-left',
        'focus-visible:outline-hidden focus-visible:bg-nb-gray-100 dark:focus-visible:bg-nb-gray-900',
        danger
          ? 'text-red-600 dark:text-red-500 hover:bg-red-500/10'
          : 'text-nb-gray-700 dark:text-nb-gray-200 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-900',
      )}
    >
      {icon}
      {children}
    </button>
  );
}
