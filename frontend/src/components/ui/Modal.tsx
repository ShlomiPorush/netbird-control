import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { lockBodyScroll, unlockBodyScroll } from '@/lib/useScrollLock';

// Everything Tab can land on inside the dialog (for the focus trap).
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Stack of open modals - only the TOPMOST one handles Escape and traps Tab, so a
// confirm dialog stacked on a modal closes alone and owns the keyboard.
const _modalStack: symbol[] = [];

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Explicit max-width utility (e.g. 'max-w-[660px]') that overrides the `size` map when set. */
  widthClass?: string;
  /** Override the header icon box classes (e.g. a gradient for posture-check modals). */
  iconWrapClass?: string;
  /** Tabs row rendered under the header (e.g. Resource / Access Control). */
  tabs?: ReactNode;
}

const sizes = { sm: 'max-w-[440px]', md: 'max-w-[560px]', lg: 'max-w-[820px]' };

// Scroll locking lives in lib/useScrollLock (shared with GlobalSearch, the mobile
// drawer, and any other full-screen overlay) - it must lock the html element, not just
// body, or the global `html { overflow-x: hidden }` rule defeats it.

export function Modal({ open, onClose, title, subtitle, icon, children, footer, size = 'md', widthClass, iconWrapClass, tabs }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const stackToken = useRef<symbol | undefined>(undefined);
  if (!stackToken.current) stackToken.current = Symbol('modal');

  // Register on the modal stack while open (topmost = last).
  useEffect(() => {
    if (!open) return;
    const token = stackToken.current!;
    _modalStack.push(token);
    return () => { const i = _modalStack.indexOf(token); if (i >= 0) _modalStack.splice(i, 1); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (_modalStack[_modalStack.length - 1] !== stackToken.current) return; // not topmost
      if (e.key === 'Escape') { onClose(); return; }
      // Focus trap: keep Tab / Shift+Tab cycling inside the dialog.
      if (e.key === 'Tab' && panelRef.current) {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
          .filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && (active === first || !panelRef.current.contains(active))) { e.preventDefault(); last.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Initial focus into the dialog on open; restore focus to the opener on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = panelRef.current?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')
      || panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    // preventScroll: focusing a field inside the fixed dialog must never nudge the (now locked)
    // background scroll position.
    el?.focus({ preventScroll: true });
    return () => { opener?.focus?.(); };
  }, [open]);

  // Block background scrolling while open (released when it closes/unmounts).
  useEffect(() => {
    if (!open) return;
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, [open]);

  if (!open) return null;

  return createPortal(
    // Backdrop: clicking it does NOT close the modal (only the X / Cancel / Escape do).
    <div className="fixed inset-0 z-1000 flex items-start justify-center px-4 pb-4 pt-[7vh] bg-black/50 animate-fade-in">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={cn(
          'w-full flex flex-col max-h-[86vh] rounded-xl border shadow-2xl',
          'bg-white border-nb-gray-200 dark:bg-nb-gray-950 dark:border-nb-gray-900',
          widthClass || sizes[size],
        )}
      >
        {(title || icon) && (
          <div className={cn(
            'flex items-start justify-between gap-3 px-6',
            // When tabs follow the header, the tab row owns the only divider (matching
            // NetBird); without tabs the header keeps its own bottom border.
            tabs ? 'pt-5 pb-3' : 'py-4 border-b border-nb-gray-100 dark:border-nb-gray-900/80',
          )}>
            <div className="flex items-center gap-3 min-w-0">
              {icon && (
                <div className={cn('flex items-center justify-center h-10 w-10 rounded-md shrink-0', iconWrapClass || 'bg-netbird-950 border border-netbird text-netbird shadow-xs')}>
                  {icon}
                </div>
              )}
              <div className="min-w-0">
                <h2 id={titleId} className="text-[1.1rem] font-semibold text-nb-gray-900 dark:text-nb-gray-50 truncate">{title}</h2>
                {subtitle && <p className="mt-0.5 text-[0.8rem] text-nb-gray-500 dark:text-nb-gray-500">{subtitle}</p>}
              </div>
            </div>
            <button onClick={onClose} title="Close" aria-label="Close dialog" className="text-nb-gray-400 hover:text-red-500 transition-colors p-1 shrink-0">
              <X size={20} />
            </button>
          </div>
        )}
        {tabs && <div className="px-6 border-b border-nb-gray-100 dark:border-nb-gray-900/80">{tabs}</div>}
        <div className="px-6 py-5 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-nb-gray-100 dark:border-nb-gray-900/80">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
