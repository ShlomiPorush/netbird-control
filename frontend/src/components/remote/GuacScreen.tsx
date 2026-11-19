import { useEffect, useRef } from 'react';
import { loadGuacamole, remoteApi, type Guac, type GuacStatus } from '@/lib/remoteAccess';

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

/** What the session tab bar can do to a running session. */
export interface ScreenApi {
  /** Press the keys in order, then release them in reverse (a key combination). */
  sendKeys: (keysyms: number[]) => void;
  /** One key going down or up (the on-screen keyboard). */
  sendKey: (pressed: boolean, keysym: number) => void;
  sendClipboard: (text: string) => void;
  submit: (values: Record<string, string>) => void;
  /** The remote screen as a PNG, at its full size. */
  screenshot: () => Promise<Blob | null>;
}

// The other side of each modifier (Shift, Ctrl, Meta, Alt, Super): a terminal keeps one state for
// both, so releasing the left one would also undo a right one held down.
const OTHER_SIDE: Record<number, number> = {
  0xffe1: 0xffe2, 0xffe2: 0xffe1, 0xffe3: 0xffe4, 0xffe4: 0xffe3, 0xffe7: 0xffe8, 0xffe8: 0xffe7,
  0xffe9: 0xffea, 0xffea: 0xffe9, 0xffeb: 0xffec, 0xffec: 0xffeb,
};

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

// The largest screen and scaling the server accepts (MAX_WIDTH / MAX_HEIGHT, and 480 DPI = 500%).
const MAX_W = 7680, MAX_H = 4320, MAX_DPR = 5;

/**
 * A box of CSS pixels as the remote screen to ask for: device pixels and the matching DPI, like the
 * official Guacamole client. The scaling is lowered when it would go past the server's limit.
 */
export function deviceSize(w: number, h: number, scaling = window.devicePixelRatio || 1) {
  const dpr = Math.min(scaling, MAX_DPR, MAX_W / w, MAX_H / h);
  return { width: Math.round(w * dpr), height: Math.round(h * dpr), dpi: Math.round(96 * dpr) };
}

// Keys go to the remote side unless one of our own fields or menus has the focus. The device
// keyboard's field (data-remote-keys) belongs to the remote side: what it types goes there.
const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el.closest('[data-remote-keys]')) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || !!el.closest('[role="menu"]');
};

// Reading the local clipboard without a prompt on every read works where the browser keeps a
// granted "clipboard-read" permission (Chromium). Elsewhere (Firefox asks on every read) the
// automatic sync stays off and the Clipboard panel is the way in.
let canAutoRead: Promise<boolean> | null = null;
function clipboardAutoRead(): Promise<boolean> {
  if (!canAutoRead) {
    canAutoRead = (async () => {
      if (!window.isSecureContext || !navigator.clipboard?.readText || !navigator.permissions?.query) return false;
      try {
        const st = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
        return st.state !== 'denied';
      } catch { return false; }
    })();
  }
  return canAutoRead;
}

/**
 * One remote session: the official Guacamole client over the app's tunnel
 * (/api/remote-access/tunnel?token=…), drawn into the parent's box. The keyboard and the clipboard
 * sync follow `active` - only the visible session gets keys and clipboard text.
 */
export function GuacScreen({ sessionId, token, active, clipboard, fontSize, onFontSize, onEvent, onRemoteClipboard, apiRef }: {
  sessionId: string;
  token: string;
  active: boolean;
  clipboard: boolean;
  /** SSH: the text size chosen in the session bar. Sent when it differs from the terminal's. */
  fontSize?: number;
  /** SSH: the terminal's text size, as guacd reports it. */
  onFontSize?: (size: number) => void;
  onEvent: (e: ViewerEvent) => void;
  /** Text copied on the remote side. */
  onRemoteClipboard: (text: string) => void;
  apiRef: { current: ScreenApi | null };
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const clipboardRef = useRef(clipboard);
  clipboardRef.current = clipboard;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onClipRef = useRef(onRemoteClipboard);
  onClipRef.current = onRemoteClipboard;
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;
  const onFontRef = useRef(onFontSize);
  onFontRef.current = onFontSize;
  // Set while the session runs; called when it becomes inactive or visible again.
  const hooks = useRef<{ release: () => void; resume: () => void; refit: () => void; syncLocal: () => void; applyFont: () => void } | null>(null);

  useEffect(() => {
    let disposed = false;
    let keyboard: Guac = null;
    let client: Guac = null;
    let lease: number | undefined;
    let resizeTimer: number | undefined;
    let paintTimer: number | undefined;
    let releaseKeys: () => void = () => { };
    // The keyboard listens only while keys belong to the remote side. Listening, it cancels every
    // keyup, so Space would do nothing on our own menus and fields.
    let syncListen: () => void = () => { };
    const onFocusIn = () => { if (isTyping()) releaseKeys(); syncListen(); };
    // Focus leaving for nothing (a menu that closed) lands on the page body a moment later.
    const onFocusOut = () => { window.setTimeout(() => { if (!disposed) syncListen(); }, 0); };
    const host = hostRef.current;
    const emit = (e: ViewerEvent) => { if (!disposed) onEventRef.current(e); };
    let cleanupListeners = () => { };

    loadGuacamole().then((G) => {
      if (disposed || !host) return;
      const tunnel = new G.WebSocketTunnel('/api/remote-access/tunnel');
      // The tunnel answers pings, so a long wait (typing a password) never looks like a timeout.
      tunnel.receiveTimeout = 30000;
      client = new G.Client(tunnel);
      const c = client;
      const display = c.getDisplay();
      const el: HTMLElement = display.getElement();
      el.style.cursor = 'none';
      host.appendChild(el);

      tunnel.onstatechange = (st: number) => { if (st === G.Tunnel.State.OPEN) emit({ type: 'channel-open' }); };
      c.onstatechange = (st: number) => {
        if (st === G.Client.State.CONNECTED) {
          connected = true;
          // The session can take client instructions now: offer the local clipboard, and send
          // the box size again (a change while connecting, such as pinning the bar, was dropped).
          syncLocal();
          refit();
          applyFont();
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
      c.onerror = (status: GuacStatus) => emit({ type: 'error', status: { code: status.code, message: status.message } });
      c.onrequired = (params: string[]) => emit({ type: 'required', params });

      // Clipboard, both ways, text only. Remote -> local goes straight to the system clipboard
      // while this session is in front; local -> remote is sent when the session comes into use
      // (focus, pointer over it), so Ctrl+V on the remote side pastes what was copied locally.
      // null until the first sync, so an empty local clipboard is offered on connect as well.
      let lastSynced: string | null = null;
      // Clipboard text sent before the session is connected would be dropped by the tunnel.
      let connected = false;
      const sendClip = (text: string) => {
        const w = new G.StringWriter(c.createClipboardStream('text/plain'));
        w.sendText(text);
        w.sendEnd();
        lastSynced = text;
      };
      c.onclipboard = (stream: Guac, mimetype: string) => {
        if (!/^text\//.test(mimetype)) return;
        const reader = new G.StringReader(stream);
        let text = '';
        reader.ontext = (t: string) => { text += t; };
        reader.onend = () => {
          lastSynced = text;
          onClipRef.current(text);
          if (activeRef.current && clipboardRef.current && document.hasFocus()) navigator.clipboard?.writeText(text).catch(() => { });
        };
      };
      const syncLocal = () => {
        if (!connected || !activeRef.current || !clipboardRef.current) return;
        clipboardAutoRead().then((ok) => {
          if (!ok || disposed || !activeRef.current) return;
          navigator.clipboard.readText().then((text) => {
            // An emptied local clipboard is sent too, so an old paste never lingers on the remote side.
            if (text !== lastSynced && !disposed && activeRef.current && clipboardRef.current) sendClip(text);
          }).catch(() => { /* not allowed right now */ });
        });
      };

      const sendArg = (name: string, value: string) => {
        const writer = new G.StringWriter(c.createArgumentValueStream('text/plain', name));
        writer.sendText(value);
        writer.sendEnd();
      };
      // SSH text size: guacd reports the terminal's ("font-size" argument) once it is open and
      // changes it in the running terminal when the browser sends another.
      let termFont: number | undefined;
      const applyFont = () => {
        const f = fontRef.current;
        if (!connected || !f || termFont === undefined || f === termFont) return;
        termFont = f;
        sendArg('font-size', String(f));
      };
      c.onargv = (stream: Guac, mimetype: string, name: string) => {
        if (name !== 'font-size' || mimetype !== 'text/plain') return;
        const reader = new G.StringReader(stream);
        let text = '';
        reader.ontext = (t: string) => { text += t; };
        reader.onend = () => {
          const n = Number.parseInt(text, 10);
          if (!Number.isFinite(n) || n <= 0) return;
          termFont = n;
          onFontRef.current?.(n);
          applyFont();
        };
      };
      // Keys the on-screen keyboard holds down (a latched Ctrl): a combination from the menu leaves
      // them down, and so a key held on the physical keyboard, so both agree with the remote side.
      const held = new Set<number>();
      const isDown = (k: number) => [k, OTHER_SIDE[k]].some((x) => x !== undefined && (held.has(x) || pressed.has(x)));

      apiRef.current = {
        sendKeys: (keysyms) => {
          const fresh = keysyms.filter((k) => !isDown(k));
          for (const k of fresh) c.sendKeyEvent(1, k);
          for (const k of [...fresh].reverse()) c.sendKeyEvent(0, k);
        },
        sendKey: (down, keysym) => {
          if (down) held.add(keysym); else held.delete(keysym);
          c.sendKeyEvent(down ? 1 : 0, keysym);
        },
        sendClipboard: (text) => sendClip(text),
        submit: (values) => { for (const [name, value] of Object.entries(values)) sendArg(name, value); },
        screenshot: () => new Promise((resolve) => {
          try { display.flatten().toBlob((b: Blob | null) => resolve(b), 'image/png'); } catch { resolve(null); }
        }),
      };

      // Mouse: the remote draws its own cursor.
      const mouse = new G.Mouse(el);
      mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guac) => c.sendMouseState(e.state, true));
      // Touch, like the official client's touchscreen mode: a tap clicks, a long press is a right
      // click, and a tap followed at once by a touch that moves drags. The browser's own panning and zooming
      // would take those gestures, so the screen turns them off.
      const touch = new G.Mouse.Touchscreen(el);
      touch.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guac) => c.sendMouseState(e.state, true));
      el.style.touchAction = 'none';
      display.oncursor = (canvas: HTMLCanvasElement, x: number, y: number) => { el.style.cursor = `url(${canvas.toDataURL()}) ${x} ${y}, auto`; };

      // Keyboard: keys go to the session in front, except while typing in our own fields. A key
      // the remote saw go down always gets its release, even if focus or the tab changed.
      // The keyboard listens to the whole page, so its handlers are set only while this session is
      // in front: with a handler set, Guacamole.Keyboard cancels every keyup, and Space on a
      // button or checkbox (which acts on keyup) would do nothing anywhere in the portal.
      keyboard = new G.Keyboard(document);
      const kb = keyboard;
      const pressed = new Set<number>();
      const keyDown = (keysym: number) => {
        if (!activeRef.current || isTyping()) return true;
        pressed.add(keysym);
        c.sendKeyEvent(1, keysym);
        return false;
      };
      // A key the on-screen keyboard still holds (either side) stays down on the remote side too.
      const keyUp = (keysym: number) => {
        if (pressed.delete(keysym) && ![keysym, OTHER_SIDE[keysym]].some((x) => x !== undefined && held.has(x))) c.sendKeyEvent(0, keysym);
      };
      const listen = (on: boolean) => { kb.onkeydown = on ? keyDown : null; kb.onkeyup = on ? keyUp : null; };
      syncListen = () => listen(activeRef.current && !isTyping());
      syncListen();
      // Lost focus (another window, a field of ours, another tab): release everything held, so
      // nothing stays pressed or auto-repeats on the remote side.
      releaseKeys = () => {
        kb.reset();
        for (const k of pressed) c.sendKeyEvent(0, k);
        pressed.clear();
      };
      window.addEventListener('blur', releaseKeys);
      window.addEventListener('focus', syncLocal);
      document.addEventListener('focusin', onFocusIn);
      document.addEventListener('focusout', onFocusOut);
      host.addEventListener('pointerenter', syncLocal);

      // Size: like the official Guacamole client, ask the remote for the box size in device pixels
      // (the session's DPI follows the screen's scaling) and scale the display down to the box, so
      // a scaled screen (125%, 150%) stays sharp. A remote that can't resize is scaled down to fit.
      // The session keeps the scaling it opened with: guacd can't change a session's DPI, so on a
      // screen with other scaling the same remote pixels are shown larger or smaller instead.
      const scaling = window.devicePixelRatio || 1;
      let sentSize = '';
      // Fill the box, but never past one remote pixel per device pixel (a remote that can't resize
      // stays sharp and centered).
      const fit = () => {
        const w = host.clientWidth, h = host.clientHeight;
        const dw = display.getWidth(), dh = display.getHeight();
        if (dw && dh && w && h) display.scale(Math.min(w / dw, h / dh, w / deviceSize(w, h, scaling).width));
      };
      display.onresize = fit;
      const refit = () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          // Only a real change, and only once connected (before that the tunnel drops it): an
          // unchanged size still makes the remote redraw the whole screen.
          if (connected && host.clientWidth && host.clientHeight) {
            const s = deviceSize(host.clientWidth, host.clientHeight, scaling);
            const key = `${s.width}x${s.height}`;
            if (key !== sentSize) { sentSize = key; c.sendSize(s.width, s.height); }
          }
          fit();
        }, 250);
      };
      // The box changes with the window, full screen, and the session bar being pinned.
      const boxWatch = new ResizeObserver(refit);
      boxWatch.observe(host);
      hooks.current = { release: () => { releaseKeys(); listen(false); }, resume: () => syncListen(), refit, syncLocal, applyFont };

      c.connect('token=' + encodeURIComponent(token));

      // Lease: an ordinary signed-in request every minute. When the sign-in ends it stops being
      // renewed and the server closes the session.
      lease = window.setInterval(() => {
        remoteApi.lease(sessionId).catch(() => { /* the server decides; it closes the tunnel */ });
      }, LEASE_MS);

      cleanupListeners = () => {
        boxWatch.disconnect();
        window.removeEventListener('focus', syncLocal);
        host.removeEventListener('pointerenter', syncLocal);
      };
    }).catch((err: Error) => emit({ type: 'error', status: { code: -1, message: err.message } }));

    const onUnload = () => { try { client?.disconnect(); } catch { /* closing */ } };
    window.addEventListener('beforeunload', onUnload);

    return () => {
      disposed = true;
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('blur', releaseKeys);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.clearInterval(lease);
      window.clearTimeout(resizeTimer);
      window.clearInterval(paintTimer);
      cleanupListeners();
      if (keyboard) { keyboard.onkeydown = null; keyboard.onkeyup = null; keyboard.reset(); }
      try { client?.disconnect(); } catch { /* already closed */ }
      apiRef.current = null;
      hooks.current = null;
      if (host) host.replaceChildren();
    };
  }, [sessionId, token, apiRef]);

  // Coming to the front: fit the screen and offer the local clipboard. Going to the back: let go
  // of every held key.
  useEffect(() => {
    activeRef.current = active;
    if (active) { hooks.current?.resume(); hooks.current?.refit(); hooks.current?.syncLocal(); }
    else hooks.current?.release();
  }, [active]);

  useEffect(() => { hooks.current?.applyFont(); }, [fontSize]);

  return <div ref={hostRef} className="absolute inset-0 overflow-hidden flex items-center justify-center" />;
}
