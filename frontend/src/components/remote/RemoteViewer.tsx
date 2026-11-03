import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardPaste, Keyboard, Maximize2, Power, X } from 'lucide-react';
import { useScrollLock } from '@/lib/useScrollLock';
import { loadGuacamole, remoteApi, type Guac, type GuacStatus, type RemoteProtocol } from '@/lib/remoteAccess';
import { Button, Textarea } from '@/components/ui';

export type ViewerEvent =
  | { type: 'channel-open' }
  | { type: 'connected' }
  /** The remote side drew real content (the screen is no longer one flat color). */
  | { type: 'painted' }
  /** Nothing was drawn within the wait - show whatever is there without claiming success. */
  | { type: 'paint-timeout' }
  | { type: 'required'; params: string[] }
  | { type: 'error'; status: GuacStatus }
  | { type: 'closed' };

const LEASE_MS = 60_000;
const PAINT_WAIT_MS = 20_000;

// Remote content has arrived once the display holds more than one color. The first sync (and the
// blank frame guacd duplicates on join) is a single flat color, so it never counts.
function hasContent(canvas: HTMLCanvasElement): boolean {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return false;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, w, h).data;
  let first = -1;
  const steps = 24;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const x = Math.floor(((i + 0.5) * w) / steps), y = Math.floor(((j + 0.5) * h) / steps);
      const o = (y * w + x) * 4;
      const v = (data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3];
      if (first === -1) first = v; else if (v !== first) return true;
    }
  }
  return false;
}
// Ctrl, Alt and Delete keysyms.
const CTRL_ALT_DEL = [0xffe3, 0xffe9, 0xffff];

const isTyping = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);
};

/**
 * Full-screen remote session. Runs the official Guacamole client over the app's tunnel
 * (/api/remote-access/tunnel?token=…). The parent owns the step list and forms: it receives
 * every state change through `onEvent` and renders them in `overlay`.
 */
export function RemoteViewer({ sessionId, token, protocol, title, clipboard, overlay, onEvent, onClose, submitRef }: {
  sessionId: string;
  token: string;
  protocol: RemoteProtocol;
  title: string;
  clipboard: boolean;
  overlay?: ReactNode;
  onEvent: (e: ViewerEvent) => void;
  onClose: () => void;
  /** Filled with a function that sends values for parameters guacd asked for ("required"). */
  submitRef: { current: ((values: Record<string, string>) => void) | null };
}) {
  useScrollLock(true);
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<Guac>(null);
  const guacRef = useRef<Guac>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const [clipOpen, setClipOpen] = useState(false);
  const [clipText, setClipText] = useState('');

  useEffect(() => {
    let disposed = false;
    let keyboard: Guac = null;
    let lease: number | undefined;
    let resizeTimer: number | undefined;
    let paintTimer: number | undefined;
    let releaseKeys: () => void = () => { };
    const onFocusIn = () => { if (isTyping()) releaseKeys(); };
    const host = hostRef.current;
    const emit = (e: ViewerEvent) => { if (!disposed) onEventRef.current(e); };

    loadGuacamole().then((G) => {
      if (disposed || !host) return;
      guacRef.current = G;
      const tunnel = new G.WebSocketTunnel('/api/remote-access/tunnel');
      // The tunnel answers pings, so a long wait (typing a password) never looks like a timeout.
      tunnel.receiveTimeout = 30000;
      const client = new G.Client(tunnel);
      clientRef.current = client;
      const display = client.getDisplay();
      const el: HTMLElement = display.getElement();
      el.style.cursor = 'none';
      host.appendChild(el);

      tunnel.onstatechange = (st: number) => { if (st === G.Tunnel.State.OPEN) emit({ type: 'channel-open' }); };
      client.onstatechange = (st: number) => {
        if (st === G.Client.State.CONNECTED) {
          emit({ type: 'connected' });
          const started = Date.now();
          window.clearInterval(paintTimer);
          paintTimer = window.setInterval(() => {
            let painted = false;
            try { painted = hasContent(display.flatten()); } catch { painted = false; }
            if (painted) { window.clearInterval(paintTimer); emit({ type: 'painted' }); }
            else if (Date.now() - started > PAINT_WAIT_MS) { window.clearInterval(paintTimer); emit({ type: 'paint-timeout' }); }
          }, 300);
        }
        if (st === G.Client.State.DISCONNECTED) emit({ type: 'closed' });
      };
      client.onerror = (status: GuacStatus) => emit({ type: 'error', status: { code: status.code, message: status.message } });
      client.onrequired = (params: string[]) => emit({ type: 'required', params });
      client.onclipboard = (stream: Guac, mimetype: string) => {
        if (!/^text\//.test(mimetype)) return;
        const reader = new G.StringReader(stream);
        let text = '';
        reader.ontext = (t: string) => { text += t; };
        reader.onend = () => setClipText(text);
      };
      submitRef.current = (values) => {
        for (const [name, value] of Object.entries(values)) {
          const stream = client.createArgumentValueStream('text/plain', name);
          const writer = new G.StringWriter(stream);
          writer.sendText(value);
          writer.sendEnd();
        }
      };

      // Mouse: the remote draws its own cursor.
      const mouse = new G.Mouse(el);
      mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guac) => client.sendMouseState(e.state, true));
      display.oncursor = (canvas: HTMLCanvasElement, x: number, y: number) => { el.style.cursor = `url(${canvas.toDataURL()}) ${x} ${y}, auto`; };

      // Keyboard: everything goes to the remote except while typing in our own fields. A key the
      // remote saw go down always gets its release, even if focus moved into one of our fields.
      keyboard = new G.Keyboard(document);
      const kb = keyboard;
      const pressed = new Set<number>();
      kb.onkeydown = (keysym: number) => { if (isTyping()) return true; pressed.add(keysym); client.sendKeyEvent(1, keysym); return false; };
      kb.onkeyup = (keysym: number) => { if (pressed.delete(keysym)) client.sendKeyEvent(0, keysym); };
      // Lost focus (another window, a field of ours): release everything held, so nothing stays
      // pressed or auto-repeats on the remote side.
      releaseKeys = () => {
        kb.reset();
        for (const k of pressed) client.sendKeyEvent(0, k);
        pressed.clear();
      };
      window.addEventListener('blur', releaseKeys);
      document.addEventListener('focusin', onFocusIn);

      // Size: ask the remote for the viewport size; scale down only if it answers bigger.
      const fit = () => {
        const w = host.clientWidth, h = host.clientHeight;
        const dw = display.getWidth(), dh = display.getHeight();
        if (dw && dh) display.scale(Math.min(w / dw, h / dh, 1));
      };
      display.onresize = fit;
      const onResize = () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => { client.sendSize(host.clientWidth, host.clientHeight); fit(); }, 250);
      };
      window.addEventListener('resize', onResize);

      client.connect('token=' + encodeURIComponent(token));

      // Lease: an ordinary signed-in request every minute. When the sign-in ends it stops being
      // renewed and the server closes the session.
      lease = window.setInterval(() => {
        remoteApi.lease(sessionId).catch(() => { /* the server decides; it closes the tunnel */ });
      }, LEASE_MS);

      const cleanup = () => window.removeEventListener('resize', onResize);
      (host as unknown as { _cleanup?: () => void })._cleanup = cleanup;
    }).catch((err: Error) => emit({ type: 'error', status: { code: -1, message: err.message } }));

    const onUnload = () => { try { clientRef.current?.disconnect(); } catch { /* closing */ } };
    window.addEventListener('beforeunload', onUnload);

    return () => {
      disposed = true;
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('blur', releaseKeys);
      document.removeEventListener('focusin', onFocusIn);
      window.clearInterval(lease);
      window.clearTimeout(resizeTimer);
      window.clearInterval(paintTimer);
      (host as unknown as { _cleanup?: () => void })?._cleanup?.();
      if (keyboard) { keyboard.onkeydown = null; keyboard.onkeyup = null; keyboard.reset(); }
      try { clientRef.current?.disconnect(); } catch { /* already closed */ }
      clientRef.current = null;
      submitRef.current = null;
      if (host) host.replaceChildren();
    };
  }, [sessionId, token, submitRef]);

  const sendCtrlAltDel = () => {
    const c = clientRef.current;
    if (!c) return;
    for (const k of CTRL_ALT_DEL) c.sendKeyEvent(1, k);
    for (const k of [...CTRL_ALT_DEL].reverse()) c.sendKeyEvent(0, k);
  };
  const sendClipboard = () => {
    const c = clientRef.current, G = guacRef.current;
    if (!c || !G) return;
    const writer = new G.StringWriter(c.createClipboardStream('text/plain'));
    writer.sendText(clipText);
    writer.sendEnd();
  };
  const fullscreen = () => { hostRef.current?.parentElement?.requestFullscreen?.().catch(() => { }); };

  return createPortal(
    <div className="dark fixed inset-0 z-1050 flex flex-col bg-nb-gray-950 text-nb-gray-100" role="dialog" aria-modal="true" aria-label={`Remote session: ${title}`}>
      <div className="flex items-center gap-2 h-11 px-3 border-b border-nb-gray-800 bg-nb-gray-940 shrink-0">
        <span className="text-xs font-semibold rounded-md border border-nb-gray-700 px-1.5 py-0.5 uppercase tracking-wide text-nb-gray-300">{protocol}</span>
        <span className="text-sm font-medium truncate">{title}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {protocol === 'rdp' && (
            <Button size="sm" variant="ghost" onClick={sendCtrlAltDel} title="Send Ctrl+Alt+Del"><Keyboard size={15} /> Ctrl+Alt+Del</Button>
          )}
          {clipboard && (
            <Button size="sm" variant="ghost" onClick={() => setClipOpen((v) => !v)} title="Clipboard"><ClipboardPaste size={15} /> Clipboard</Button>
          )}
          <Button size="sm" variant="ghost" onClick={fullscreen} title="Full Screen"><Maximize2 size={15} /></Button>
          <Button size="sm" variant="danger" onClick={onClose}><Power size={15} /> Disconnect</Button>
        </div>
      </div>
      <div className="relative flex-1 min-h-0">
        <div ref={hostRef} className="absolute inset-0 overflow-hidden flex items-center justify-center" />
        {clipOpen && clipboard && (
          <div className="absolute right-3 top-3 z-10 w-80 rounded-lg border border-nb-gray-800 bg-nb-gray-950 p-3 shadow-2xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold">Clipboard</span>
              <button onClick={() => setClipOpen(false)} aria-label="Close clipboard" className="text-nb-gray-400 hover:text-red-500 p-1"><X size={16} /></button>
            </div>
            <p className="text-[0.75rem] text-nb-gray-400 mb-2">Text copied on the remote side shows up here. Paste text here and send it to the remote clipboard.</p>
            <Textarea value={clipText} onChange={(e) => setClipText(e.target.value)} rows={5} />
            <div className="flex gap-2 mt-2">
              <Button size="sm" variant="primary" onClick={sendClipboard}>Send To Remote</Button>
              <Button size="sm" onClick={() => { navigator.clipboard?.writeText(clipText).catch(() => { }); }}>Copy Here</Button>
            </div>
          </div>
        )}
        {overlay && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-nb-gray-950/80 backdrop-blur-xs p-4">
            {overlay}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
