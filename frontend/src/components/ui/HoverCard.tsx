import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

// A hover popover for table cells. The card is rendered in a fixed-position PORTAL so the
// table's `overflow-x-auto` wrapper can't clip it (which pushed the old absolute popups
// under the row). Both the trigger AND the card share the open/close handlers with a short
// close delay, so moving the mouse from the trigger onto the card keeps it open - letting
// you scroll a long list instead of it vanishing the instant you move.
export function HoverCard({
  trigger, children, width = 300, className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  const open = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom;
    const above = below < 240 && r.top > below;
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
  };
  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPos(null), 140);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <div ref={ref} className="inline-block" onMouseEnter={open} onMouseLeave={close}>
      {trigger}
      {pos && createPortal(
        <div
          style={{ position: 'fixed', left: pos.left, top: pos.top, width, transform: pos.above ? 'translateY(-100%)' : undefined }}
          onMouseEnter={open}
          onMouseLeave={close}
          className="z-1100"
        >
          <div className={cn('rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 shadow-2xl p-3', className)}>
            {children}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
