import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { loadGuacamole, loadKeyboardLayout, type Guac, type RemoteProtocol } from '@/lib/remoteAccess';
import type { ScreenApi } from './GuacScreen';

// The session bar's tools: its menus, the special keys, the on-screen keyboard, the device
// keyboard and the screenshot.

const K = {
  ctrl: 0xffe3, alt: 0xffe9, shift: 0xffe1, win: 0xffeb, del: 0xffff, tab: 0xff09, esc: 0xff1b,
  f4: 0xffc1, f5: 0xffc2, print: 0xff61, left: 0xff51, right: 0xff53,
};
const ch = (c: string) => c.charCodeAt(0);

interface SpecialKey { label: string; combo: string; keys: number[] }

/** Key combinations a browser can't send itself (the local system takes them) or a phone has no key for. */
export const SPECIAL_KEYS: Record<RemoteProtocol, SpecialKey[]> = {
  rdp: [
    { label: 'Security Options', combo: 'Ctrl+Alt+Del', keys: [K.ctrl, K.alt, K.del] },
    { label: 'Start Menu', combo: 'Win', keys: [K.win] },
    { label: 'Switch Windows', combo: 'Alt+Tab', keys: [K.alt, K.tab] },
    { label: 'Task Manager', combo: 'Ctrl+Shift+Esc', keys: [K.ctrl, K.shift, K.esc] },
    { label: 'Run', combo: 'Win+R', keys: [K.win, ch('r')] },
    { label: 'Lock', combo: 'Win+L', keys: [K.win, ch('l')] },
    { label: 'Close Window', combo: 'Alt+F4', keys: [K.alt, K.f4] },
    { label: 'Print Screen', combo: 'PrtSc', keys: [K.print] },
  ],
  ssh: [
    { label: 'Interrupt', combo: 'Ctrl+C', keys: [K.ctrl, ch('c')] },
    { label: 'End Of Input', combo: 'Ctrl+D', keys: [K.ctrl, ch('d')] },
    { label: 'Suspend', combo: 'Ctrl+Z', keys: [K.ctrl, ch('z')] },
    { label: 'Clear Screen', combo: 'Ctrl+L', keys: [K.ctrl, ch('l')] },
    { label: 'Escape', combo: 'Esc', keys: [K.esc] },
    { label: 'Tab', combo: 'Tab', keys: [K.tab] },
  ],
  web: [
    { label: 'Address Bar', combo: 'Ctrl+L', keys: [K.ctrl, ch('l')] },
    { label: 'New Tab', combo: 'Ctrl+T', keys: [K.ctrl, ch('t')] },
    { label: 'Close Tab', combo: 'Ctrl+W', keys: [K.ctrl, ch('w')] },
    { label: 'Next Tab', combo: 'Ctrl+Tab', keys: [K.ctrl, K.tab] },
    { label: 'Previous Tab', combo: 'Ctrl+Shift+Tab', keys: [K.ctrl, K.shift, K.tab] },
    { label: 'Reload', combo: 'F5', keys: [K.f5] },
    { label: 'Back', combo: 'Alt+Left', keys: [K.alt, K.left] },
    { label: 'Forward', combo: 'Alt+Right', keys: [K.alt, K.right] },
  ],
};

export const FONT_MIN = 8, FONT_MAX = 32;

/** A touch screen: the keyboard button then offers the device's own keyboard too. */
export const hasTouch = () => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

const visibleItems = (panel: HTMLElement | null) =>
  Array.from(panel?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || []).filter((b) => b.offsetParent !== null);

/**
 * A button of the session bar that opens a menu under it. The menu is drawn in the session view
 * (`container`), not in the bar: the bar slides with a transform, which would carry it along.
 * While the menu has the focus, keys stay with it (Escape, Tab, the arrows, Space and Enter on a
 * row) instead of the remote side. Closed, it gives the keys back to the session: the focus does
 * not return to its button, where Enter or Space would otherwise stay on the bar.
 */
export function BarMenu({ title, icon, container, width = 248, pressed, onOpenChange, children }: {
  title: string; icon: ReactNode; container: RefObject<HTMLElement | null>; width?: number; pressed?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The menu's rows; `close` closes it. */
  children: (close: () => void) => ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const reportRef = useRef(onOpenChange);
  reportRef.current = onOpenChange;
  const open = !!pos;
  const close = useCallback(() => {
    // Off the button too (a pointer click left it there), so keys go to the session.
    if (panel.current?.contains(document.activeElement) || document.activeElement === btn.current) (document.activeElement as HTMLElement).blur();
    setPos(null);
    reportRef.current?.(false);
  }, []);
  const toggle = () => {
    if (open || !btn.current) { close(); return; }
    const r = btn.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top: r.bottom + 10 });
    reportRef.current?.(true);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape and Tab leave the menu (WAI-ARIA menu pattern).
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = visibleItems(panel.current);
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      list[e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length].focus();
    };
    const onResize = () => close();
    // The first row takes the focus; with none to take (all disabled), the menu itself does.
    const t = window.setTimeout(() => (visibleItems(panel.current)[0] || panel.current)?.focus(), 0);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  return (
    <>
      <button ref={btn} type="button" onClick={toggle} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open}
        className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-nb-gray-300 transition-colors hover:bg-nb-gray-800 hover:text-white focus-visible:outline-2 focus-visible:outline-netbird-400',
          (open || pressed) && 'bg-nb-gray-800 text-white')}>
        {icon}
      </button>
      {open && container.current && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => close()} />
          <div ref={panel} role="menu" aria-label={title} tabIndex={-1} style={{ left: pos.left, top: pos.top, width }}
            // Focus moving out of the menu (a click elsewhere) closes it.
            onBlur={(e) => { if (!panel.current?.contains(e.relatedTarget as Node | null)) close(); }}
            className="fixed z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-xl border border-nb-gray-800 bg-nb-gray-940 p-1.5 shadow-2xl outline-hidden">
            {children(close)}
          </div>
        </>,
        container.current,
      )}
    </>
  );
}

/** One row of a bar menu: an action, with its keys or a check mark on the right. */
export function MenuRow({ icon, label, hint, checked, disabled, onClick, className }: {
  icon?: ReactNode; label: string; hint?: string; checked?: boolean; disabled?: boolean; onClick: () => void; className?: string;
}) {
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} onClick={onClick} disabled={disabled}
      className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-nb-gray-200 hover:bg-nb-gray-900 focus-visible:bg-nb-gray-900 focus-visible:outline-hidden disabled:opacity-40 disabled:hover:bg-transparent', className)}>
      {icon && <span className="shrink-0 text-nb-gray-400">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <kbd className="shrink-0 rounded-md bg-nb-gray-900 px-1.5 py-0.5 font-mono text-[0.7rem] text-nb-gray-400 ring-1 ring-inset ring-nb-gray-800">{hint}</kbd>}
      {checked && <Check size={15} className="shrink-0 text-netbird-400" />}
    </button>
  );
}

/**
 * The official on-screen keyboard (Guacamole.OnScreenKeyboard with the web client's US layout).
 * It sends to the session it opened for; closing it lets go of every key it holds down, such as a
 * Shift it latched.
 */
export function ScreenKeyboard({ target, onClose, onHeight }: {
  target: { current: ScreenApi | null }; onClose: () => void;
  /** The panel's height: the session gives it the bottom of the window, so nothing typed is hidden. */
  onHeight: (px: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const heightRef = useRef(onHeight);
  heightRef.current = onHeight;
  useEffect(() => {
    const p = panel.current;
    if (!p) return;
    const watch = new ResizeObserver(() => heightRef.current(p.offsetHeight + 16));
    watch.observe(p);
    return () => { watch.disconnect(); heightRef.current(0); };
  }, []);
  useEffect(() => {
    const el = box.current;
    let disposed = false;
    let watch: ResizeObserver | null = null;
    let onResize = () => { };
    const held = new Set<number>();
    Promise.all([loadGuacamole(), loadKeyboardLayout()]).then(([G, layout]: [Guac, Guac]) => {
      if (disposed || !el) return;
      const osk = new G.OnScreenKeyboard(layout);
      osk.onkeydown = (k: number) => { held.add(k); target.current?.sendKey(true, k); };
      osk.onkeyup = (k: number) => { held.delete(k); target.current?.sendKey(false, k); };
      el.appendChild(osk.getElement());
      // The keyboard's height follows its width; at most 40% of the window keeps the session in sight.
      const fit = () => {
        if (!el.clientWidth) return;
        osk.resize(el.clientWidth);
        const h = osk.getElement().offsetHeight, max = window.innerHeight * 0.4;
        if (h > max) osk.resize(Math.floor((el.clientWidth * max) / h));
      };
      fit();
      watch = new ResizeObserver(fit);
      watch.observe(el);
      onResize = fit;
      window.addEventListener('resize', onResize);
    }).catch((e: Error) => { if (!disposed) setError(e.message); });
    return () => {
      disposed = true;
      watch?.disconnect();
      window.removeEventListener('resize', onResize);
      for (const k of held) target.current?.sendKey(false, k);
      el?.replaceChildren();
    };
  }, [target]);
  return (
    <div ref={panel} className="nb-osk absolute bottom-2 left-1/2 z-30 w-[calc(100%-1rem)] max-w-[68rem] -translate-x-1/2 rounded-2xl border border-nb-gray-800 bg-nb-gray-940/95 p-2 shadow-[0_-16px_40px_-14px_rgba(0,0,0,0.7)] backdrop-blur-md">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-xs font-semibold text-nb-gray-400">Keyboard</span>
        <button type="button" onClick={onClose} aria-label="Close The Keyboard" title="Close The Keyboard"
          className="rounded-md p-1 text-nb-gray-400 hover:bg-nb-gray-800 hover:text-white"><X size={14} /></button>
      </div>
      {error ? <p className="px-1 pb-1 text-sm text-red-300">{error} Close it and open it again.</p> : <div ref={box} className="text-center" />}
    </div>
  );
}

export const KEY_ROW_HEIGHT = 48;

const ROW_MODIFIERS = [
  { label: 'Ctrl', keysym: K.ctrl },
  { label: 'Alt', keysym: K.alt },
  { label: 'Win', keysym: K.win, rdpOnly: true },
];
const ROW_KEYS = [
  { label: 'Esc', keysym: K.esc },
  { label: 'Tab', keysym: K.tab },
  { label: 'Left', keysym: 0xff51, icon: <ArrowLeft size={16} /> },
  { label: 'Up', keysym: 0xff52, icon: <ArrowUp size={16} /> },
  { label: 'Down', keysym: 0xff54, icon: <ArrowDown size={16} /> },
  { label: 'Right', keysym: 0xff53, icon: <ArrowRight size={16} /> },
  { label: 'Del', keysym: K.del },
];

export function KeyRow({ protocol, latched, onKey, onLatch }: {
  protocol: RemoteProtocol; latched: number[]; onKey: (keysym: number) => void; onLatch: (modifiers: number[]) => void;
}) {
  const keepKeyboardOpen = (e: ReactPointerEvent) => e.preventDefault();
  const key = 'flex h-9 min-w-0 max-w-16 flex-1 items-center justify-center rounded-lg text-[0.78rem] font-semibold text-nb-gray-200 ring-1 ring-inset ring-nb-gray-800 active:bg-nb-gray-800';
  return (
    <div role="toolbar" aria-label="Extra Keys" style={{ height: KEY_ROW_HEIGHT }}
      className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-1 border-t border-nb-gray-800 bg-nb-gray-940/95 px-1.5 backdrop-blur-md">
      {ROW_MODIFIERS.filter((m) => !m.rdpOnly || protocol === 'rdp').map((m) => {
        const on = latched.includes(m.keysym);
        return (
          <button key={m.label} type="button" aria-pressed={on} onPointerDown={keepKeyboardOpen}
            onClick={() => onLatch(on ? latched.filter((k) => k !== m.keysym) : [...latched, m.keysym])}
            className={cn(key, on && 'bg-netbird text-white ring-netbird')}>{m.label}</button>
        );
      })}
      <span className="mx-0.5 h-5 w-px shrink-0 bg-nb-gray-800" />
      {ROW_KEYS.map((k) => (
        <button key={k.label} type="button" aria-label={k.label} onPointerDown={keepKeyboardOpen} onClick={() => onKey(k.keysym)} className={key}>
          {k.icon || k.label}
        </button>
      ))}
    </div>
  );
}

export interface DeviceKeyboardControl { open: () => void; close: () => void }

/**
 * The device's own keyboard (a phone or a tablet): Guacamole.InputSink, the library's hidden field
 * for this, has the focus while it is open. The session's Guacamole.Keyboard listens to the whole
 * page, so it gets the keys and the text the device types (also composed words, in any language)
 * from the field, as it does from a physical keyboard. The field is in the page only while the
 * user keeps it open: an InputSink focuses itself on any key press, which a tablet's physical
 * keyboard would otherwise do too.
 */
export function DeviceKeyboard({ control, onOpenChange }: {
  control: { current: DeviceKeyboardControl | null };
  onOpenChange: (open: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef(onOpenChange);
  reportRef.current = onOpenChange;
  useEffect(() => {
    const host = hostRef.current;
    let field: HTMLTextAreaElement | null = null;
    let disposed = false;
    const onFocus = () => reportRef.current(true);
    // Closed (the user hid it, or the focus moved on): out of the page again.
    const onBlur = () => { reportRef.current(false); window.setTimeout(() => { if (field && document.activeElement !== field) field.remove(); }, 0); };
    loadGuacamole().then((G) => {
      if (disposed || !host) return;
      const f = getSink(G);
      field = f;
      f.setAttribute('data-remote-keys', '');
      f.setAttribute('aria-label', 'Device Keyboard');
      f.setAttribute('autocapitalize', 'off');
      f.setAttribute('autocorrect', 'off');
      f.setAttribute('autocomplete', 'off');
      f.setAttribute('spellcheck', 'false');
      f.tabIndex = -1;
      // 16px: a smaller font makes iOS zoom the page in when the field takes the focus.
      f.style.fontSize = '16px';
      f.addEventListener('focus', onFocus);
      f.addEventListener('blur', onBlur);
      // Focused inside the tap itself: a phone shows its keyboard only then.
      control.current = {
        open: () => {
          if (document.activeElement === f) f.blur();
          host.appendChild(f);
          f.focus();
        },
        close: () => { if (document.activeElement === f) f.blur(); else f.remove(); },
      };
    }).catch(() => { /* the session itself reports a library that did not load */ });
    return () => {
      disposed = true;
      if (field) {
        field.blur();
        field.removeEventListener('focus', onFocus);
        field.removeEventListener('blur', onBlur);
        field.remove();
      }
      control.current = null;
    };
  }, [control]);
  return <div ref={hostRef} />;
}

// One field for the page: an InputSink also listens to the document for good.
let sink: HTMLTextAreaElement | null = null;
function getSink(G: Guac): HTMLTextAreaElement {
  sink ||= new G.InputSink().getElement() as HTMLTextAreaElement;
  return sink;
}

/** Save the remote screen as a PNG named after the session and the local time. */
export async function saveScreenshot(api: ScreenApi | null | undefined, title: string) {
  const blob = await api?.screenshot();
  if (!blob) return false;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const name = `${title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'session'}-${stamp}.png`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
