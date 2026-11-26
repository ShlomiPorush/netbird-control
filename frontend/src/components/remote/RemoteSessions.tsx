import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { AlertCircle, Camera, ChevronDown, ClipboardPaste, Command, Expand, Globe, Hand, Keyboard, Loader2, Lock, Maximize2, Minus, MonitorPlay, MoreHorizontal, MousePointer2, Pin, PinOff, Plus, Power, Smartphone, Terminal, Unplug, X, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useScrollLock } from '@/lib/useScrollLock';
import { apiText, remoteApi, GUAC, PORTAL_MESSAGE_CODES, type GuacStatus, type RemoteProtocol, type WebSessionInfo } from '@/lib/remoteAccess';
import { Button, Field, Input, PasswordInput, Textarea } from '@/components/ui';
import { GuacScreen, coarsePointer, deviceSize, isPhone, phoneDesktop, remoteScreen, type PointerMode, type ScreenApi, type ViewerEvent } from './GuacScreen';
import { ARG_LABELS, FailureBox, StepList, StepSummary, explain, handoffSteps, usePacedSteps, withStep, type Failure, type Step } from './steps';
import { FLOW_BUTTON, FLOW_INPUT, FLOW_QUIET, FlowCard, FlowHeader, FlowTile } from './flow';
import { BarMenu, DeviceKeyboard, type DeviceKeyboardControl, FONT_MAX, FONT_MIN, KEY_ROW_HEIGHT, KeyRow, MenuRow, SPECIAL_KEYS, ScreenKeyboard, hasTouch, saveScreenshot } from './SessionTools';

// Open browser sessions live here, above the routes: moving to another page of the portal keeps
// them running, and they show as tabs in one full-screen session view. Closing the browser tab
// ends them (the page unloads and each session disconnects).

export interface SessionEntry {
  sessionId: string;
  token: string;
  attachment?: string;
  protocol: RemoteProtocol;
  title: string;
  clipboard: boolean;
  /** The steps so far (the checks passed on the Remote Access page). */
  steps: Step[];
  dwell: number;
  /** Where the session goes: a failed sign-in is tried again there, in the same tab. */
  target: { address: string; port: number };
  /** SSH: the user name typed on the Remote Access page. */
  user?: string;
  /** Opened from a launch link: the first attempt signs in with credentials the server sent. */
  serverCredentials?: boolean;
}

type TabStatus = 'connecting' | 'live' | 'ended';

interface Ctx {
  count: number;
  ids: string[];
  open: boolean;
  add: (e: SessionEntry) => void;
  show: () => void;
}
const SessionsContext = createContext<Ctx>({ count: 0, ids: [], open: false, add: () => { }, show: () => { } });
export const useRemoteSessions = () => useContext(SessionsContext);

export const PROTOCOL_ICON: Record<RemoteProtocol, LucideIcon> = { rdp: MonitorPlay, ssh: Terminal, web: Globe };
export const WEB_SESSIONS_KEY = ['remote-web-sessions'];
export const WEB_TITLE = 'Browser';
const WEB_GONE = 'The browser was closed.';
const WEB_LOST = 'The connection to your browser was lost.';
const WEB_REASON_CODES = new Set<number>([...PORTAL_MESSAGE_CODES, GUAC.SESSION_CLOSED]);
export const WEB_ENDED_TEXT = 'This browser was already closed.';
export const isWebEnded = (err: unknown) => err instanceof ApiError && (err.code === 'BROWSER_ENDED' || err.status === 404 || err.status === 410);
const webReason = (status: GuacStatus) => (WEB_REASON_CODES.has(status.code) && status.message && status.message !== 'Aborted. See logs.' ? status.message : '');

export function minutesLeft(expiresAt: string | null, now = Date.now()) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 60_000)) : null;
}

const CLOSING_POLL_MS = 3000;
const OPEN_POLL_MS = 15_000;

export const closesIn = (min: number) => (min <= 1 ? 'Closes in less than a minute' : `Closes in ${min} minutes`);

const PIN_KEY = 'nbc.remote.barPinned';
// How long the pointer must rest on the handle before the bar opens: passing over it does nothing.
const HANDLE_DWELL_MS = 500;

const readPinned = () => { try { return localStorage.getItem(PIN_KEY) === '1'; } catch { return false; } };

const POINTER_KEY = 'nbc.remote.pointer';
const defaultPointer = (): PointerMode => (isPhone() ? 'touchpad' : 'touchscreen');
const readPointer = (): PointerMode => {
  try {
    const saved = localStorage.getItem(POINTER_KEY);
    return saved === 'touchpad' || saved === 'touchscreen' ? saved : defaultPointer();
  } catch { return defaultPointer(); }
};

const KEYBOARD_MIN_HEIGHT = 150;

/** The size a new session asks for: the session box in device pixels, and the screen's DPI. The
 * session always has the whole window: the bar floats over it, also when pinned. */
export function sessionScreenSize(protocol: RemoteProtocol) {
  return remoteScreen(protocol, { width: window.innerWidth, height: window.innerHeight });
}

export function launchScreenSize() {
  const general = deviceSize(window.innerWidth, window.innerHeight);
  return isPhone() ? { ...general, rdp: phoneDesktop(window.innerWidth, window.innerHeight) } : general;
}

function useVisibleArea(enabled: boolean) {
  const [area, setArea] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return;
    const update = () => setArea({ top: vv.offsetTop, height: vv.height });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      setArea(null);
    };
  }, [enabled]);
  return area;
}

export function RemoteSessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [activeId, setActiveId] = useState('');
  const [open, setOpen] = useState(false);
  // The Remote Access page has its own "Return To Sessions" banner.
  const onRemotePage = useLocation().pathname.startsWith('/remote-access');

  const add = useCallback((e: SessionEntry) => {
    setSessions((s) => [...s.filter((x) => x.sessionId !== e.sessionId), e]);
    setActiveId(e.sessionId);
    setOpen(true);
  }, []);
  const remove = useCallback((id: string) => setSessions((s) => s.filter((x) => x.sessionId !== id)), []);
  // A closed tab hands the front to the last remaining one; with none left the view closes.
  useEffect(() => {
    if (!sessions.length) { setOpen(false); return; }
    if (!sessions.some((x) => x.sessionId === activeId)) setActiveId(sessions[sessions.length - 1].sessionId);
  }, [sessions, activeId]);
  const show = useCallback(() => { if (sessions.length) setOpen(true); }, [sessions.length]);

  const hasWebTab = sessions.some((s) => s.protocol === 'web');
  useQuery({
    queryKey: WEB_SESSIONS_KEY, queryFn: () => remoteApi.webSessions(), retry: false,
    enabled: (q) => hasWebTab || !!q.state.data?.sessions.length,
    refetchInterval: (q) => {
      const listed = q.state.data?.sessions || [];
      return listed.some((s) => s.state === 'ending') ? CLOSING_POLL_MS : listed.length || hasWebTab ? OPEN_POLL_MS : false;
    },
  });

  const idList = sessions.map((s) => s.sessionId).join(' ');
  const ids = useMemo(() => (idList ? idList.split(' ') : []), [idList]);
  const value = useMemo(() => ({ count: sessions.length, ids, open, add, show }), [sessions.length, ids, open, add, show]);
  return (
    <SessionsContext.Provider value={value}>
      {children}
      {sessions.length > 0 && (
        <Workspace sessions={sessions} activeId={activeId} open={open}
          onActivate={setActiveId} onRemove={remove} onHide={() => setOpen(false)} />
      )}
      {sessions.length > 0 && !open && !onRemotePage && (
        <button onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-1040 inline-flex items-center gap-2 rounded-full bg-netbird px-4 py-2.5 text-sm font-medium text-white shadow-xl hover:brightness-110">
          <MonitorPlay size={16} /> {sessions.length} Open Session{sessions.length === 1 ? '' : 's'} - Return
        </button>
      )}
    </SessionsContext.Provider>
  );
}

function Workspace({ sessions, activeId, open, onActivate, onRemove, onHide }: {
  sessions: SessionEntry[]; activeId: string; open: boolean;
  onActivate: (id: string) => void; onRemove: (id: string) => void; onHide: () => void;
}) {
  useScrollLock(open);
  // No visible page scrollbar beside the session (index.css). Before paint, so it never flashes.
  useLayoutEffect(() => {
    if (!open) return;
    document.documentElement.classList.add('nb-session-open');
    return () => document.documentElement.classList.remove('nb-session-open');
  }, [open]);
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const apis = useRef<Record<string, { current: ScreenApi | null }>>({});
  const apiFor = (id: string) => (apis.current[id] ||= { current: null });
  const [status, setStatus] = useState<Record<string, TabStatus>>({});
  const [clips, setClips] = useState<Record<string, string>>({});
  const [clipOpen, setClipOpen] = useState(false);
  const clipButton = useRef<HTMLButtonElement>(null);
  const active = sessions.find((s) => s.sessionId === activeId) || sessions[sessions.length - 1];
  const activeApi = () => (active ? apis.current[active.sessionId]?.current ?? null : null);
  // The bar's tools: an open menu keeps the bar in sight; the on-screen keyboard and the device
  // keyboard serve the session in front.
  const [menuOpen, setMenuOpen] = useState(false);
  const [oskOpen, setOskOpen] = useState(false);
  const [deviceKbd, setDeviceKbd] = useState(false);
  const deviceKeys = useRef<DeviceKeyboardControl | null>(null);
  // The session gives the bottom of the window to the on-screen keyboard.
  const [oskHeight, setOskHeight] = useState(0);
  const [shotFailed, setShotFailed] = useState(false);
  const touch = useMemo(hasTouch, []);
  const coarse = useMemo(coarsePointer, []);
  const phone = useMemo(isPhone, []);
  const [pointer, setPointer] = useState<PointerMode>(readPointer);
  const choosePointer = (mode: PointerMode) => {
    setPointer(mode);
    try { localStorage.setItem(POINTER_KEY, mode); } catch { }
  };
  const area = useVisibleArea(touch && open);
  const keyboardShown = !!area && window.innerHeight - area.height > KEYBOARD_MIN_HEIGHT;
  const keyRow = deviceKbd && keyboardShown;
  const [latched, setLatched] = useState<number[]>([]);
  useEffect(() => { if (!keyRow) activeApi()?.latchForNextKey([]); }, [keyRow]);
  useEffect(() => setLatched([]), [activeId]);
  const openDeviceKeys = () => { setOskOpen(false); deviceKeys.current?.open(); };
  const toggleDeviceKeys = () => { if (keyRow) deviceKeys.current?.close(); else openDeviceKeys(); };
  const toggleOsk = () => { if (!oskOpen) deviceKeys.current?.close(); setOskOpen(!oskOpen); };
  // SSH text size per tab: the one chosen in the bar, else the terminal's as guacd reports it.
  const [fonts, setFonts] = useState<Record<string, number>>({});
  const [termFonts, setTermFonts] = useState<Record<string, number>>({});
  // A screenshot needs a picture: the remote side drew, or the wait for it ended.
  const [painted, setPainted] = useState<Record<string, boolean>>({});
  const fontOf = (s: SessionEntry): number | undefined => fonts[s.sessionId] ?? termFonts[s.sessionId];
  const setFont = (s: SessionEntry, n: number) => setFonts((m) => ({ ...m, [s.sessionId]: Math.max(FONT_MIN, Math.min(FONT_MAX, n)) }));
  // Another tab to the front: the device keyboard closes first and the tab changes a moment
  // later, so a word it was still composing goes to the session it was typed for.
  const activate = (id: string) => {
    if (!touch) { onActivate(id); return; }
    deviceKeys.current?.close();
    window.setTimeout(() => onActivate(id), 0);
  };

  // The bar hides itself (like the connection bar of a desktop RDP client): it shows for a moment
  // when a session comes to the front, then only from the small handle at the top - a click, or
  // the pointer resting on it. The rest of the top edge belongs to the remote screen. Pinned, it
  // stays on top of the session, as when the pointer is on it; the session keeps the whole window.
  const [pinned, setPinned] = useState(readPinned);
  const [barShown, setBarShown] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);
  const dwellTimer = useRef<number | undefined>(undefined);
  const hovering = useRef(false);
  const scheduleHide = useCallback((ms: number) => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { if (!hovering.current) setBarShown(false); }, ms);
  }, []);
  // Shown from the handle without the pointer on the bar, it still hides again later (the hide
  // timer checks the pointer when it fires).
  const reveal = () => { window.clearTimeout(dwellTimer.current); setBarShown(true); scheduleHide(3000); };
  const handleEnter = () => { window.clearTimeout(dwellTimer.current); dwellTimer.current = window.setTimeout(reveal, HANDLE_DWELL_MS); };
  const handleLeave = () => window.clearTimeout(dwellTimer.current);
  useEffect(() => { if (open) reveal(); }, [open, activeId, scheduleHide]);
  useEffect(() => () => { window.clearTimeout(hideTimer.current); window.clearTimeout(dwellTimer.current); }, []);
  const keepBar = pinned || clipOpen || menuOpen;
  const barVisible = barShown || keepBar;
  // The tab of the session in front stays in sight when the tab list scrolls: when it comes to the
  // front, and when the list gets narrower (a smaller window).
  const tabsRef = useRef<HTMLDivElement>(null);
  const activeTabId = active?.sessionId;
  useEffect(() => {
    const list = tabsRef.current;
    if (!list || !activeTabId) return;
    const show = () => list.querySelector<HTMLElement>(`[data-tab="${CSS.escape(activeTabId)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    show();
    const watch = new ResizeObserver(show);
    watch.observe(list);
    return () => watch.disconnect();
  }, [activeTabId, sessions.length]);
  const togglePin = () => setPinned((p) => { const n = !p; try { localStorage.setItem(PIN_KEY, n ? '1' : '0'); } catch { /* ignore */ } return n; });

  // Tabs are keyed by their first session; after a sign-in retry the tab runs a newer one.
  const current = useRef<Record<string, string>>({});
  const qc = useQueryClient();
  const refreshWebSessions = () => { void qc.invalidateQueries({ queryKey: WEB_SESSIONS_KEY }); };
  const endSession = (id: string) => {
    remoteApi.end(current.current[id] || id).catch(() => { }).finally(refreshWebSessions);
    delete current.current[id];
    onRemove(id);
  };
  const [closing, setClosing] = useState<Record<string, ClosingBrowser>>({});
  const [closeProblems, setCloseProblems] = useState<Record<string, CloseProblem>>({});
  const webList = useQuery({ queryKey: WEB_SESSIONS_KEY, queryFn: () => remoteApi.webSessions(), enabled: false });
  const forgetClosing = (id: string) => setClosing((m) => { const n = { ...m }; delete n[id]; return n; });
  const forgetProblem = (id: string) => setCloseProblems((m) => { const n = { ...m }; delete n[id]; return n; });
  const finishClose = (id: string) => {
    forgetClosing(id);
    delete current.current[id];
    onRemove(id);
    refreshWebSessions();
  };
  const settleClose = (id: string) => {
    setClosing((m) => (m[id] ? { ...m, [id]: { ...m[id], settled: true, since: Date.now() } } : m));
    refreshWebSessions();
  };
  const closeBrowser = (id: string) => {
    if (closing[id]) return;
    const sessionId = current.current[id] || id;
    forgetProblem(id);
    setClosing((m) => ({ ...m, [id]: { sessionId, settled: false, since: Date.now() } }));
    remoteApi.end(sessionId).then(
      (r) => (r?.state === 'ending' ? settleClose(id) : finishClose(id)),
      (err) => (isWebEnded(err) ? finishClose(id) : settleClose(id)),
    );
  };
  const checkAgain = (id: string) => {
    const sessionId = current.current[id] || id;
    forgetProblem(id);
    setClosing((m) => ({ ...m, [id]: { sessionId, settled: true, since: Date.now() } }));
    refreshWebSessions();
  };
  useEffect(() => {
    const listed = webList.data?.sessions;
    for (const [id, c] of Object.entries(closing)) {
      if (!c.settled) continue;
      if (listed && webList.dataUpdatedAt > c.since) {
        const row = listed.find((s) => s.sessionId === c.sessionId);
        if (!row) finishClose(id);
        else if (row.state !== 'ending') {
          forgetClosing(id);
          setCloseProblems((m) => ({ ...m, [id]: { message: "Your browser couldn't be closed. Try again.", unknown: false } }));
        }
      } else if (webList.errorUpdatedAt > c.since) {
        forgetClosing(id);
        setCloseProblems((m) => ({ ...m, [id]: { message: "Your browser couldn't be closed, and its state couldn't be checked.", unknown: true } }));
      }
    }
  }, [webList.data, webList.dataUpdatedAt, webList.errorUpdatedAt, closing]);
  const detach = (id: string) => {
    delete current.current[id];
    onRemove(id);
    window.setTimeout(refreshWebSessions, 1500);
  };
  const disconnect = (id: string) => {
    if (sessions.find((s) => s.sessionId === id)?.protocol === 'web') detach(id); else endSession(id);
  };
  const webActive = active?.protocol === 'web';
  const leave = () => {
    setClipOpen(false);
    setOskOpen(false);
    deviceKeys.current?.close();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { });
    onHide();
  };
  const newSession = () => { leave(); navigate('/remote-access'); };
  // Opened from the Remote Access page, hiding the view would show that page again: go to the portal.
  const backToPortal = () => { leave(); if (window.location.pathname.toLowerCase().startsWith('/remote-access')) navigate('/'); };
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { });
    else rootRef.current?.requestFullscreen?.().catch(() => { });
  };
  const menuChanged = (o: boolean) => { setMenuOpen(o); setShotFailed(false); if (!o && !pinned) scheduleHide(1500); };
  const openDeviceKeyboard = (close: () => void) => {
    close();
    if (deviceKbd) deviceKeys.current?.close(); else openDeviceKeys();
  };

  const dot = (s: TabStatus | undefined) => cn('h-2 w-2 shrink-0 rounded-full',
    s === 'live' ? 'bg-green-500' : s === 'ended' ? 'bg-nb-gray-500' : 'bg-amber-400 animate-pulse');

  return createPortal(
    <div ref={rootRef}
      className={cn('dark fixed inset-0 z-1050 bg-nb-gray-950 text-nb-gray-100', !open && 'invisible pointer-events-none')}
      role="dialog" aria-modal={open} aria-label="Remote sessions" aria-hidden={!open}
      // No browser menu on a right click anywhere in the session view (the remote screen already
      // takes its right clicks); text fields keep theirs, for paste.
      onContextMenu={(e) => { if (!(e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) e.preventDefault(); }}>
      <div className="absolute inset-x-0" style={area ? { top: area.top, height: area.height } : { top: 0, bottom: 0 }}>
      {sessions.map((s) => (
        <div key={`${s.sessionId}:${s.token}`}
          className={cn('absolute inset-x-0 top-0', s.sessionId !== active?.sessionId && 'invisible pointer-events-none')}
          style={s.sessionId !== active?.sessionId
            ? (area ? { height: window.innerHeight } : { bottom: 0 })
            : { bottom: oskOpen ? oskHeight : keyRow ? KEY_ROW_HEIGHT : 0 }}>
          <SessionPane
            entry={s}
            active={open && s.sessionId === active?.sessionId}
            pointer={pointer}
            onLatchChange={(m) => { if (s.sessionId === active?.sessionId) setLatched(m); }}
            onTouchTap={s.protocol === 'ssh' && s.sessionId === active?.sessionId ? openDeviceKeys : undefined}
            apiRef={apiFor(s.sessionId)}
            onStatus={(st) => setStatus((m) => (m[s.sessionId] === st ? m : { ...m, [s.sessionId]: st }))}
            onRemoteClipboard={(t) => setClips((m) => ({ ...m, [s.sessionId]: t }))}
            onClose={() => disconnect(s.sessionId)}
            onCloseBrowser={() => closeBrowser(s.sessionId)}
            closing={!!closing[s.sessionId]}
            closeProblem={closeProblems[s.sessionId] || null}
            onDismissCloseProblem={() => forgetProblem(s.sessionId)}
            onCheckAgain={() => checkAgain(s.sessionId)}
            onCloseTab={() => finishClose(s.sessionId)}
            onSession={(id) => {
              current.current[s.sessionId] = id;
              // A new session (a sign-in retry) reports its own text size and draws its own picture.
              setTermFonts((m) => { if (!(s.sessionId in m)) return m; const n = { ...m }; delete n[s.sessionId]; return n; });
              setPainted((m) => (m[s.sessionId] ? { ...m, [s.sessionId]: false } : m));
            }}
            onLeave={leave}
            fontSize={s.protocol === 'ssh' ? fonts[s.sessionId] : undefined}
            onPainted={() => setPainted((m) => (m[s.sessionId] ? m : { ...m, [s.sessionId]: true }))}
            onFontSize={(n) => setTermFonts((m) => (m[s.sessionId] === n ? m : { ...m, [s.sessionId]: n }))}
          />
        </div>
      ))}

      {/* The handle brings the bar back: a click, or the pointer resting on it. */}
      {!barVisible && active && (
        <button onClick={reveal} onPointerDown={(e) => e.preventDefault()} onMouseEnter={handleEnter} onMouseLeave={handleLeave} aria-label="Show the session bar"
          className="absolute left-1/2 top-0 z-30 -translate-x-1/2 inline-flex h-7 max-w-[70vw] items-center gap-2 rounded-b-xl border border-t-0 border-nb-gray-800 bg-nb-gray-940/95 px-3 text-[0.75rem] font-medium text-nb-gray-200 shadow-lg backdrop-blur-md">
          <span className={dot(status[active.sessionId])} />
          <ProtocolIcon protocol={active.protocol} size={13} />
          <span className="truncate">{active.title}</span>
          {sessions.length > 1 && <span className="text-nb-gray-400">+{sessions.length - 1}</span>}
          <ChevronDown size={13} className="shrink-0" />
        </button>
      )}

      {/* The bar floats above the session, like a dock. */}
      <div
        onPointerEnter={(e) => { if (e.pointerType !== 'mouse') return; hovering.current = true; reveal(); }}
        onPointerLeave={(e) => { if (e.pointerType !== 'mouse') return; hovering.current = false; if (!keepBar) scheduleHide(1500); }}
        className={cn('absolute left-1/2 top-2 z-30 flex h-[46px] w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-nb-gray-800 bg-nb-gray-940/92 px-1.5 shadow-[0_16px_40px_-14px_rgba(0,0,0,0.7)] backdrop-blur-md transition-transform duration-200 sm:w-max sm:max-w-[calc(100%-1rem)]',
          barVisible ? 'translate-y-0' : '-translate-y-[calc(100%+1rem)]')}>
        {/* The NetBird mark is the way back to the portal. */}
        <button type="button" onClick={backToPortal} title="Back To The Portal (Sessions Keep Running)" aria-label="Back To The Portal (Sessions Keep Running)"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-netbird/12 transition-colors hover:bg-netbird/25 focus-visible:outline-2 focus-visible:outline-netbird-400">
          <img src="/favicon.svg" alt="" className="h-[18px] w-[18px]" />
        </button>
        {/* Tabs: a list on wide screens, a menu on narrow ones. */}
        <div ref={tabsRef} className="hidden sm:flex min-w-0 shrink items-center gap-1 overflow-x-auto">
          {sessions.map((s) => (
            <div key={s.sessionId} data-tab={s.sessionId}
              className={cn('group flex h-8 min-w-0 max-w-64 shrink-0 items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-[0.8rem] cursor-pointer transition-colors',
                s.sessionId === active?.sessionId ? 'bg-nb-gray-900 text-white ring-1 ring-inset ring-nb-gray-700' : 'text-nb-gray-400 hover:bg-nb-gray-900/60 hover:text-nb-gray-100')}
              onClick={() => activate(s.sessionId)} title={s.title}>
              <span className={dot(status[s.sessionId])} />
              <ProtocolIcon protocol={s.protocol} size={13} />
              <span className="truncate">{s.title}</span>
              <button aria-label={`Disconnect ${s.title}`} title={s.protocol === 'web' ? 'Disconnect (The Browser Keeps Running)' : 'Disconnect'}
                onClick={(e) => { e.stopPropagation(); disconnect(s.sessionId); }}
                className="rounded-md p-1 text-nb-gray-500 hover:bg-nb-gray-800 hover:text-red-400"><X size={13} /></button>
            </div>
          ))}
        </div>
        <div className="sm:hidden flex min-w-0 flex-1 items-center">
          <select value={active?.sessionId} onChange={(e) => activate(e.target.value)} aria-label="Session"
            className="h-8 min-w-16 flex-1 rounded-lg border border-nb-gray-700 bg-nb-gray-900 px-2 text-sm text-white">
            {sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>{s.title}</option>)}
          </select>
        </div>
        <BarButton onClick={newSession} title="New Session" className="hidden sm:flex border border-dashed border-nb-gray-700"><Plus size={15} /></BarButton>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-nb-gray-800" />
        {active && (
          <div className="flex shrink-0 items-center gap-0.5">
            <BarMenu key={active.protocol} title="Special Keys" icon={<Command size={16} />} container={rootRef} onOpenChange={menuChanged}>
              {(close) => SPECIAL_KEYS[active.protocol].map((k) => (
                <MenuRow key={k.combo} label={k.label} hint={k.combo}
                  onClick={() => { activeApi()?.sendKeys(k.keys); close(); }} />
              ))}
            </BarMenu>
            {phone ? (
              <BarButton onClick={toggleDeviceKeys} keepFocus title="Keyboard" pressed={keyRow}><Keyboard size={16} /></BarButton>
            ) : touch ? (
              <BarMenu title="Keyboard" icon={<Keyboard size={16} />} pressed={oskOpen || deviceKbd} container={rootRef} onOpenChange={menuChanged} width={232}>
                {(close) => (
                  <>
                    <MenuRow icon={<Keyboard size={15} />} label="On-Screen Keyboard" checked={oskOpen}
                      onClick={() => { toggleOsk(); close(); }} />
                    <MenuRow icon={<Smartphone size={15} />} label="Device Keyboard" checked={deviceKbd}
                      onClick={() => openDeviceKeyboard(close)} />
                  </>
                )}
              </BarMenu>
            ) : (
              <BarButton onClick={() => setOskOpen((v) => !v)} title='On-Screen Keyboard' pressed={oskOpen}><Keyboard size={16} /></BarButton>
            )}
            {active.protocol !== 'ssh' && coarse && pointer === 'touchpad' && (
              <BarMenu title="Zoom" icon={<ZoomIn size={16} />} container={rootRef} onOpenChange={menuChanged} width={200}>
                {(close) => (
                  <>
                    <MenuRow icon={<ZoomIn size={15} />} label="Zoom In" onClick={() => { activeApi()?.zoom('in'); close(); }} />
                    <MenuRow icon={<ZoomOut size={15} />} label="Zoom Out" onClick={() => { activeApi()?.zoom('out'); close(); }} />
                    <MenuRow icon={<Expand size={15} />} label="Fit To Screen" onClick={() => { activeApi()?.zoom('fit'); close(); }} />
                  </>
                )}
              </BarMenu>
            )}
            {active.clipboard && (
              <BarButton buttonRef={clipButton} onClick={() => setClipOpen((v) => !v)} title="Clipboard" pressed={clipOpen}><ClipboardPaste size={16} /></BarButton>
            )}
            <BarButton className={coarse ? 'hidden min-[400px]:flex' : 'hidden sm:flex'} onClick={fullscreen} title="Full Screen"><Maximize2 size={16} /></BarButton>
            <BarButton className="hidden sm:flex" onClick={togglePin} title={pinned ? 'Let The Bar Hide' : 'Keep The Bar Open'} pressed={pinned}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</BarButton>
            <BarMenu title="More" icon={<MoreHorizontal size={16} />} container={rootRef} onOpenChange={menuChanged} width={236}>
              {(close) => (
                <>
                  {/* Only once the remote side has drawn something. */}
                  <MenuRow icon={<Camera size={15} />} label="Save A Screenshot" disabled={!painted[active.sessionId]}
                    onClick={() => {
                      void saveScreenshot(activeApi(), active.title).then((ok) => { if (ok) close(); else setShotFailed(true); });
                    }} />
                  {shotFailed && <p role="alert" className="px-2.5 pb-1.5 text-xs text-red-300">The screenshot could not be saved. Try again in a moment.</p>}
                  {active.protocol === 'ssh' && (
                    <div className="flex items-center gap-2 px-2.5 py-1.5 text-sm text-nb-gray-200">
                      <span className="flex-1">Text Size</span>
                      <button type="button" role="menuitem" aria-label="Smaller Text" title="Smaller Text" disabled={termFonts[active.sessionId] === undefined || fontOf(active)! <= FONT_MIN}
                        onClick={() => setFont(active, fontOf(active)! - 1)}
                        className="flex h-7 w-7 items-center justify-center rounded-md ring-1 ring-inset ring-nb-gray-800 hover:bg-nb-gray-900 focus-visible:bg-nb-gray-900 focus-visible:outline-hidden disabled:opacity-40"><Minus size={14} /></button>
                      <span className="w-6 text-center tabular-nums" aria-live="polite">{termFonts[active.sessionId] === undefined ? '-' : fontOf(active)}</span>
                      <button type="button" role="menuitem" aria-label="Larger Text" title="Larger Text" disabled={termFonts[active.sessionId] === undefined || fontOf(active)! >= FONT_MAX}
                        onClick={() => setFont(active, fontOf(active)! + 1)}
                        className="flex h-7 w-7 items-center justify-center rounded-md ring-1 ring-inset ring-nb-gray-800 hover:bg-nb-gray-900 focus-visible:bg-nb-gray-900 focus-visible:outline-hidden disabled:opacity-40"><Plus size={14} /></button>
                    </div>
                  )}
                  {active.protocol !== 'ssh' && coarse && (
                    <>
                      <div className="my-1 h-px bg-nb-gray-800" />
                      <MenuRow icon={<MousePointer2 size={15} />} label="Touchpad Mode" checked={pointer === 'touchpad'}
                        onClick={() => { choosePointer('touchpad'); close(); }} />
                      <MenuRow icon={<Hand size={15} />} label="Direct Touch Mode" checked={pointer === 'touchscreen'}
                        onClick={() => { choosePointer('touchscreen'); close(); }} />
                    </>
                  )}
                  {phone && (
                    <MenuRow icon={<Keyboard size={15} />} label="On-Screen Keyboard" checked={oskOpen}
                      onClick={() => { toggleOsk(); close(); }} />
                  )}
                  {/* What the bar has no room for on a narrow screen. */}
                  <div className="sm:hidden">
                    <div className="my-1 h-px bg-nb-gray-800" />
                    <MenuRow className={coarse ? 'min-[400px]:hidden' : undefined} icon={<Maximize2 size={15} />} label="Full Screen" onClick={() => { close(); fullscreen(); }} />
                    <MenuRow icon={<Pin size={15} />} label="Keep The Bar Open" checked={pinned}
                      onClick={() => { togglePin(); close(); }} />
                    <MenuRow icon={<Plus size={15} />} label="New Session" onClick={() => { close(); newSession(); }} />
                    {webActive && <MenuRow icon={<Power size={15} />} label="Close Browser" onClick={() => { close(); closeBrowser(active.sessionId); }} />}
                  </div>
                </>
              )}
            </BarMenu>
          </div>
        )}
        <span className="mx-0.5 h-5 w-px shrink-0 bg-nb-gray-800" />
        {webActive && (
          <button type="button" onClick={() => detach(active.sessionId)} title="Disconnect (The Browser Keeps Running)" aria-label="Disconnect (The Browser Keeps Running)"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[0.8rem] font-semibold text-nb-gray-200 ring-1 ring-inset ring-nb-gray-700 transition-colors hover:bg-nb-gray-800 hover:text-white md:px-3">
            <Unplug size={15} /><span className="hidden md:inline">Disconnect</span>
          </button>
        )}
        {active && (
          <button type="button" onClick={() => (webActive ? closeBrowser(active.sessionId) : disconnect(active.sessionId))}
            title={webActive ? 'Close Browser' : 'Disconnect'} aria-label={webActive ? 'Close Browser' : 'Disconnect'}
            className={cn('h-8 shrink-0 items-center gap-1.5 rounded-lg bg-red-500/15 px-2 text-[0.8rem] font-semibold text-red-300 ring-1 ring-inset ring-red-500/35 transition-colors hover:bg-red-600 hover:text-white md:px-3',
              webActive ? 'hidden sm:inline-flex' : 'inline-flex')}>
            <Power size={15} /><span className="hidden md:inline">{webActive ? 'Close Browser' : 'Disconnect'}</span>
          </button>
        )}
      </div>

      {oskOpen && active && (
        <ScreenKeyboard key={active.sessionId} target={apiFor(active.sessionId)} onClose={() => setOskOpen(false)} onHeight={setOskHeight} />
      )}
      {keyRow && active && (
        <KeyRow protocol={active.protocol} latched={latched}
          onKey={(k) => activeApi()?.sendKeys([k])} onLatch={(m) => activeApi()?.latchForNextKey(m)} />
      )}
      {touch && <DeviceKeyboard control={deviceKeys} onOpenChange={setDeviceKbd} />}

      {clipOpen && active?.clipboard && (
        <ClipboardPanel
          key={active.sessionId}
          anchor={clipButton}
          initial={clips[active.sessionId] || ''}
          note={webActive ? "Pasting Hebrew text into the browser doesn't work yet. Typing Hebrew works." : undefined}
          onSend={(t) => apis.current[active.sessionId]?.current?.sendClipboard(t)}
          onClose={() => { setClipOpen(false); if (!pinned) scheduleHide(1500); }}
        />
      )}
      </div>
    </div>,
    document.body,
  );
}

function BarButton({ title, onClick, pressed, className, children, buttonRef, keepFocus }: {
  title: string; onClick: () => void; pressed?: boolean; className?: string; children: ReactNode;
  buttonRef?: RefObject<HTMLButtonElement | null>; keepFocus?: boolean;
}) {
  return (
    <button ref={buttonRef} type="button" onClick={onClick} title={title} aria-label={title} aria-pressed={pressed}
      onPointerDown={keepFocus ? (e) => e.preventDefault() : undefined}
      className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-nb-gray-300 transition-colors hover:bg-nb-gray-800 hover:text-white focus-visible:outline-2 focus-visible:outline-netbird-400',
        pressed && 'bg-nb-gray-800 text-white', className)}>
      {children}
    </button>
  );
}

const CLIP_WIDTH = 448;

function ProtocolIcon({ protocol, size }: { protocol: RemoteProtocol; size: number }) {
  const Icon = PROTOCOL_ICON[protocol];
  return <Icon size={size} className="shrink-0" />;
}

function ClipboardPanel({ initial, anchor, note, onSend, onClose }: {
  initial: string; anchor: RefObject<HTMLButtonElement | null>; note?: string; onSend: (t: string) => void; onClose: () => void;
}) {
  // Right under its button, like the bar's menus, and inside the window.
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(CLIP_WIDTH, window.innerWidth - 16);
      setPos({ left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), top: r.bottom + 10, width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  return (
    // Never taller than the window below the bar: the text box gives up height first, so the
    // buttons stay in reach on a low screen.
    <div style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: `calc(100dvh - ${pos.top + 8}px)` } : { visibility: 'hidden' }}
      className="fixed z-40 flex overflow-y-auto flex-col rounded-2xl border border-nb-gray-800 bg-nb-gray-940 p-4 shadow-2xl">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold">Clipboard</span>
        <button onClick={onClose} aria-label="Close The Clipboard" className="rounded-md p-1 text-nb-gray-400 hover:bg-nb-gray-800 hover:text-white"><X size={16} /></button>
      </div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Clipboard text" rows={12}
        className="h-64 min-h-16! w-full shrink resize-none! rounded-lg! font-mono text-[0.8rem]" />
      {note && <p className="mt-2 flex items-start gap-1.5 text-[0.78rem] text-nb-gray-400"><AlertCircle size={14} className="mt-px shrink-0" />{note}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="primary" className="rounded-lg!" onClick={() => onSend(text)}>Send To Remote</Button>
        <Button className="rounded-lg!" onClick={() => { navigator.clipboard?.writeText(text).catch(() => { }); }}>Copy Here</Button>
      </div>
    </div>
  );
}

type PanePhase = 'connecting' | 'live' | 'ended';

// The sign-in form: what the server asked for (RDP) or the SSH user name and password.
const SSH_FIELDS = ['username', 'password'];
const SIGNIN_FAILED = 'Sign-in failed. Check the user name and password and try again.';
const SSH_KEY_NOTE = 'To sign in with a private key instead, close this tab and connect again.';

// One session: its screen, and on top of it the remaining steps, the sign-in form the server
// asks for, or how it ended. A failed sign-in asks again in the same tab: a new session to the
// same server, which the portal checks again like any other.
type WebEnd = { reason: string; live: boolean; found?: WebSessionInfo | null | 'unknown' };

interface ClosingBrowser { sessionId: string; settled: boolean; since: number }
interface CloseProblem { message: string; unknown: boolean }

function SessionPane({ entry, active, pointer, onLatchChange, onTouchTap, apiRef, onStatus, onRemoteClipboard, onClose, onCloseBrowser, closing, closeProblem, onDismissCloseProblem, onCheckAgain, onCloseTab, onSession, onLeave, fontSize, onFontSize, onPainted }: {
  entry: SessionEntry; active: boolean; apiRef: { current: ScreenApi | null };
  pointer: PointerMode; onLatchChange: (modifiers: number[]) => void; onTouchTap?: () => void;
  /** SSH: the text size chosen in the session bar, and the terminal's as guacd reports it. */
  fontSize?: number;
  onFontSize?: (size: number) => void;
  /** The screen has a picture to save (the remote side drew, or the wait for it ended). */
  onPainted: () => void;
  onStatus: (s: TabStatus) => void; onRemoteClipboard: (t: string) => void;
  onClose: () => void;
  onCloseBrowser: () => void;
  closing: boolean;
  closeProblem: CloseProblem | null;
  onDismissCloseProblem: () => void;
  onCheckAgain: () => void;
  onCloseTab: () => void;
  /** The session this tab runs now (a new one after a sign-in retry). */
  onSession: (sessionId: string) => void;
  onLeave: () => void;
}) {
  const ssh = entry.protocol === 'ssh';
  const web = entry.protocol === 'web';
  const [conn, setConn] = useState<{ sessionId: string; token: string; attachment?: string }>({ sessionId: entry.sessionId, token: entry.token, attachment: entry.attachment });
  const connRef = useRef(conn);
  connRef.current = conn;
  const [webEnd, setWebEnd] = useState<WebEnd | null>(null);
  const [resumeError, setResumeError] = useState('');
  const [steps, setSteps] = useState<Step[]>(entry.steps);
  const { shown, caughtUp } = usePacedSteps(steps, entry.dwell);
  const [phase, setPhase] = useState<PanePhase>('connecting');
  const phaseRef = useRef<PanePhase>('connecting');
  phaseRef.current = phase;
  const stageRef = useRef<'server' | 'signin'>('server');
  const [required, setRequired] = useState<string[] | null>(null);
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [ended, setEnded] = useState('');
  // Sign-in retry: the form again after wrong credentials.
  const [retry, setRetry] = useState<string[] | null>(null);
  // Why the last retry could not open a session (the form stays for another try).
  const [retryError, setRetryError] = useState('');
  const retryRef = useRef(false);
  const [busy, setBusy] = useState(false);
  // RDP: credentials were sent in this attempt (only then is a refusal a failed sign-in). A session
  // from a launch link starts with credentials the server sent; a retry starts without.
  const sentCreds = useRef(!!entry.serverCredentials);
  // RDP: what guacd asked for, and the user name and domain to keep for a retry.
  const askedFor = useRef<string[]>([]);
  const kept = useRef<Record<string, string>>({ username: entry.user || '' });
  // RDP: what was typed in the retry form, sent when the new session asks for it. Cleared on
  // every way the attempt ends.
  const pending = useRef<Record<string, string> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  const setStep = useCallback((key: Step['key'], state: Step['state'], detail?: string) => setSteps((p) => withStep(p, key, state, detail)), []);

  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  useEffect(() => { onStatusRef.current(phase); }, [phase]);

  const showRetry = (fields: string[]) => {
    pending.current = null;
    retryRef.current = true;
    setRequired(null);
    setRetryError('');
    setRetry(fields);
    setArgValues(Object.fromEntries(fields.map((f) => [f, f === 'password' ? '' : kept.current[f] || ''])));
    setPhase('connecting');
  };

  const webEnded = useCallback((reason: string, gone = false) => {
    const live = phaseRef.current === 'live';
    setRequired(null);
    setPhase('ended');
    setWebEnd((w) => {
      const next: WebEnd = w ? { ...w, reason: w.reason || reason } : { reason, live };
      return gone ? { ...next, found: null } : next;
    });
  }, []);

  const checkingWeb = web && phase === 'ended' && !!webEnd && webEnd.found === undefined;
  useEffect(() => {
    if (!checkingWeb) return;
    let stopped = false;
    const timer = window.setTimeout(() => {
      remoteApi.webSessions().then(
        (r) => (r.sessions || []).find((x) => x.sessionId === connRef.current.sessionId && (x.state === 'active' || x.state === 'detached')) || null,
        () => 'unknown' as const,
      ).then((found) => { if (!stopped) setWebEnd((w) => (w ? { ...w, found } : w)); });
    }, 1000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [checkingWeb]);

  const paintedRef = useRef(onPainted);
  paintedRef.current = onPainted;
  const onEvent = useCallback((ev: ViewerEvent) => {
    // The failed attempt's tunnel still reports its end; the retry form stays.
    if (retryRef.current) return;
    switch (ev.type) {
      case 'channel-open':
        setStep('channel', 'pass');
        setStep('server', 'running');
        break;
      case 'required': {
        // Only an NLA server asks for credentials at this point - proof it was reached.
        setStep('server', 'pass');
        setStep('signin', 'running');
        stageRef.current = 'signin';
        askedFor.current = ev.params;
        const typed = pending.current;
        pending.current = null;
        if (typed && ev.params.every((p) => p in typed)) {
          // The retry form already has them.
          apiRef.current?.submit(Object.fromEntries(ev.params.map((p) => [p, typed[p]])));
          sentCreds.current = true;
          setPhase('live');
          break;
        }
        setRequired(ev.params);
        setArgValues(Object.fromEntries(ev.params.map((p) => [p, p === 'password' ? '' : kept.current[p] || ''])));
        break;
      }
      case 'connected':
        // The first sync arrives before the remote side has drawn anything - not proof yet.
        break;
      case 'painted':
        // Real remote content (a desktop, a logon screen, a terminal prompt) is on the screen.
        // A server that drew without asking (no NLA) never needs the retry's values.
        pending.current = null;
        if (phaseRef.current === 'connecting') setStep('server', 'pass');
        setPhase((p) => (p === 'connecting' ? 'live' : p));
        paintedRef.current();
        break;
      case 'paint-timeout':
        pending.current = null;
        setPhase((p) => (p === 'connecting' ? 'live' : p));
        paintedRef.current();
        break;
      case 'error': {
        pending.current = null;
        if (web) {
          webEnded(webReason(ev.status) || (phaseRef.current === 'live' ? '' : explain(ev.status, 'server', 'web').message), ev.status.code === GUAC.SESSION_CLOSED);
          break;
        }
        // Wrong credentials: SSH refuses them only at sign-in (also a password typed in the
        // terminal); RDP after the user sent them. Locked or expired accounts are a different code.
        if (ev.status.code === GUAC.CLIENT_UNAUTHORIZED && (ssh || sentCreds.current)) {
          showRetry(ssh ? SSH_FIELDS : askedFor.current.length ? askedFor.current : ['username', 'password']);
          break;
        }
        const x = explain(ev.status, stageRef.current);
        setRequired(null);
        if (phaseRef.current === 'live') {
          setEnded(x.message);
        } else {
          setStep(x.step, 'fail', x.message);
          setFailure({ message: x.message, troubleshoot: x.step === 'server' });
        }
        setPhase('ended');
        break;
      }
      case 'closed':
        pending.current = null;
        if (web) { webEnded(''); break; }
        setEnded((m) => m || 'The session ended.');
        setPhase('ended');
        break;
    }
  }, [setStep, ssh, web, webEnded, apiRef]);

  const resumeWeb = async () => {
    if (busy) return;
    setBusy(true);
    setResumeError('');
    try {
      const s = await remoteApi.resumeWeb(conn.sessionId, { ...sessionScreenSize('web'), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (!mounted.current) return;
      onSession(s.sessionId);
      stageRef.current = 'server';
      setWebEnd(null);
      setEnded('');
      setFailure(null);
      setSteps(handoffSteps({}, 'web'));
      setPhase('connecting');
      setConn({ sessionId: s.sessionId, token: s.token, attachment: s.attachment });
    } catch (err) {
      if (!mounted.current) return;
      if (isWebEnded(err)) setWebEnd((w) => (w ? { ...w, found: null } : w));
      else setResumeError(apiText(err, "Your browser couldn't be resumed. Try again."));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const keep = (values: Record<string, string>) => {
    kept.current = { ...kept.current, ...(values.username !== undefined ? { username: values.username } : {}), ...(values.domain !== undefined ? { domain: values.domain } : {}) };
  };

  const submitRequired = (e: FormEvent) => {
    e.preventDefault();
    keep(argValues);
    apiRef.current?.submit(argValues);
    sentCreds.current = true;
    setRequired(null);
    setArgValues({});
    setPhase('live');
  };

  // A new session to the same server; the typed values go with it (SSH) or when it asks (RDP).
  const submitRetry = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const values = argValues;
    keep(values);
    setBusy(true);
    try {
      const s = await remoteApi.createSession({
        protocol: entry.protocol, address: entry.target.address, port: entry.target.port,
        ...sessionScreenSize(entry.protocol),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(ssh ? { username: (values.username || '').trim(), password: values.password || '' } : {}),
      });
      // Closed while the request ran: end the session nobody will use.
      if (!mounted.current) { remoteApi.end(s.sessionId).catch(() => { }); return; }
      onSession(s.sessionId);
      pending.current = ssh ? null : values;
      sentCreds.current = false;
      stageRef.current = 'server';
      retryRef.current = false;
      setRetry(null);
      setArgValues({});
      setSteps(entry.steps);
      setFailure(null);
      setEnded('');
      setPhase('connecting');
      setConn({ sessionId: s.sessionId, token: s.token });
    } catch (err) {
      // No session was opened (network, limit, access): the form stays, with the reason, so the
      // user can try again or cancel. The password is typed again.
      if (!mounted.current) return;
      setRetryError(apiText(err, "The session couldn't be opened. Try again."));
      setArgValues((v) => ({ ...v, password: '' }));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const fieldsFor = (params: string[]) => params.map((p) => (
    <Field key={p} label={ARG_LABELS[p] || p}>
      {p === 'password' ? (
        <PasswordInput autoComplete="current-password" autoFocus={active && (p === params[0] || !!argValues.username)} className={FLOW_INPUT}
          value={argValues[p] || ''} onChange={(e) => setArgValues((v) => ({ ...v, [p]: e.target.value }))} />
      ) : (
        <Input autoComplete={p === 'username' ? 'username' : 'off'} autoFocus={active && p === params[0] && !argValues[p]} className={FLOW_INPUT}
          value={argValues[p] || ''} onChange={(e) => setArgValues((v) => ({ ...v, [p]: e.target.value }))} />
      )}
    </Field>
  ));

  // Each state of the tab is one card: a header (icon, what is happening, the server), then the
  // steps, the sign-in form or how it ended.
  const ProtoIcon = PROTOCOL_ICON[entry.protocol];
  const proto = <ProtoIcon size={19} />;
  const webFound = webEnd?.found;
  const webMinutes = webFound && webFound !== 'unknown' && webFound.state === 'detached' ? minutesLeft(webFound.expiresAt) : null;
  const webCard = !webEnd ? null
    : webFound === undefined ? (
      <FlowCard>
        <FlowHeader icon={<Unplug size={19} />} tone="neutral" title={webEnd.live ? 'Disconnected' : "Couldn't Connect"} subtitle={entry.title} />
        <p className="flex items-center gap-2 text-sm text-nb-gray-600 dark:text-nb-gray-300"><Loader2 size={15} className="animate-spin" /> Checking your browser…</p>
      </FlowCard>
    ) : webFound === null ? (
      <FlowCard className="flex flex-col items-center text-center">
        <FlowTile icon={<Power size={26} />} tone="neutral" large />
        <h2 className="mt-4 text-xl font-bold tracking-tight text-nb-gray-900 dark:text-white">Browser Closed</h2>
        <p className="mt-1.5 text-sm text-nb-gray-600 dark:text-nb-gray-300">{webEnd.reason || WEB_GONE}</p>
        <Button variant="primary" className={cn(FLOW_BUTTON, 'mt-6')} onClick={onClose}>Close</Button>
      </FlowCard>
    ) : (
      <FlowCard className="flex flex-col items-center text-center">
        <FlowTile icon={<Unplug size={26} />} tone="neutral" large />
        <h2 className="mt-4 text-xl font-bold tracking-tight text-nb-gray-900 dark:text-white">{webEnd.live ? 'Disconnected' : "Couldn't Connect"}</h2>
        <p className="mt-1.5 text-sm text-nb-gray-600 dark:text-nb-gray-300">{webEnd.reason || WEB_LOST}</p>
        {webMinutes !== null && <p className="mt-1 text-[0.82rem] text-nb-gray-500 dark:text-nb-gray-400">Your browser keeps running. {closesIn(webMinutes)}.</p>}
        {resumeError && (
          <p role="alert" className="mt-4 flex w-full items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2.5 text-left text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200">
            <AlertCircle size={16} className="mt-px shrink-0 text-red-500" /><span>{resumeError}</span>
          </p>
        )}
        <div className="mt-6 flex w-full flex-col gap-2">
          <Button variant="primary" className={FLOW_BUTTON} onClick={() => { void resumeWeb(); }} disabled={busy}>{busy ? 'Resuming…' : 'Resume'}</Button>
          <Button className={FLOW_BUTTON} onClick={onCloseBrowser} disabled={busy}>Close Browser</Button>
        </div>
      </FlowCard>
    );
  const signInButtons = (label: string) => (
    <div className="mt-1 flex flex-col gap-1">
      <Button type="submit" variant="primary" className={FLOW_BUTTON} disabled={busy}>{label}</Button>
      <Button variant="ghost" className={FLOW_QUIET} onClick={onClose}>Cancel</Button>
    </div>
  );
  const overlay =
    retry ? (
      <FlowCard>
        <FlowHeader icon={<Lock size={19} />} title="Sign In" subtitle={entry.title} />
        <StepSummary steps={shown} />
        <form key={conn.sessionId} onSubmit={submitRetry} className="mt-4 flex flex-col gap-3">
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2.5 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200">
            <AlertCircle size={16} className="mt-px shrink-0 text-red-500" />
            <span>{retryError || <>{SIGNIN_FAILED}{ssh && <> {SSH_KEY_NOTE}</>}</>}</span>
          </p>
          {fieldsFor(retry)}
          {ssh && <p className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">Leave the password empty to type it in the terminal.</p>}
          {signInButtons(busy ? 'Signing In…' : 'Sign In')}
        </form>
      </FlowCard>
    )
      : required && caughtUp ? (
        <FlowCard>
          <FlowHeader icon={<Lock size={19} />} title="Sign In" subtitle={entry.title} />
          <StepSummary steps={shown} />
          <form key={conn.sessionId} onSubmit={submitRequired} className="mt-4 flex flex-col gap-3">
            <p className="text-[0.82rem] text-nb-gray-500 dark:text-nb-gray-400">The server asks you to sign in. Your password goes to the server only and is never stored.</p>
            {fieldsFor(required)}
            {signInButtons('Sign In')}
          </form>
        </FlowCard>
      )
        : web && closeProblem ? (
          <FlowCard className="flex flex-col items-center text-center">
            <FlowTile icon={<AlertCircle size={26} />} tone="neutral" large />
            <h2 className="mt-4 text-xl font-bold tracking-tight text-nb-gray-900 dark:text-white">Couldn't Close The Browser</h2>
            <p className="mt-1.5 text-sm text-nb-gray-600 dark:text-nb-gray-300">{closeProblem.message}</p>
            <div className="mt-6 flex w-full flex-col gap-2">
              {closeProblem.unknown ? <>
                <Button variant="primary" className={FLOW_BUTTON} onClick={onCheckAgain}>Check Again</Button>
                <Button variant="ghost" className={FLOW_QUIET} onClick={onCloseTab}>Close Tab</Button>
              </> : <>
                <Button variant="primary" className={FLOW_BUTTON} onClick={onCloseBrowser}>Try Again</Button>
                <Button variant="ghost" className={FLOW_QUIET} onClick={onDismissCloseProblem}>Keep It Open</Button>
              </>}
            </div>
          </FlowCard>
        )
        : web && closing ? (
          <FlowCard className="flex flex-col items-center text-center">
            <FlowTile icon={<Loader2 size={26} className="animate-spin" />} tone="neutral" large />
            <h2 className="mt-4 text-xl font-bold tracking-tight text-nb-gray-900 dark:text-white">Closing…</h2>
            <p className="mt-1.5 text-sm text-nb-gray-600 dark:text-nb-gray-300">Your browser is being closed. This tab closes when it has stopped.</p>
          </FlowCard>
        )
        : web && phase === 'ended' && webCard ? webCard
        : phase === 'ended' && failure ? (
          <FlowCard>
            <FlowHeader icon={<X size={20} />} tone="danger" title="Couldn't Connect" subtitle={entry.title} />
            <StepList steps={shown} />
            {caughtUp && <FailureBox failure={failure} onRetry={onClose} retryLabel="Close" onLeave={onLeave} />}
          </FlowCard>
        )
          : phase === 'ended' ? (
            <FlowCard className="flex flex-col items-center text-center">
              <FlowTile icon={<Power size={26} />} tone="neutral" large />
              <h2 className="mt-4 text-xl font-bold tracking-tight text-nb-gray-900 dark:text-white">Session Ended</h2>
              <p className="mt-1.5 text-sm text-nb-gray-600 dark:text-nb-gray-300">{ended}</p>
              <Button variant="primary" className={cn(FLOW_BUTTON, 'mt-6')} onClick={onClose}>Close</Button>
            </FlowCard>
          )
            // Until the paced list has caught up, the step card stays on top (also over a screen that already drew).
            : phase === 'connecting' || required || !caughtUp ? (
              <FlowCard>
                <FlowHeader icon={proto} title="Connecting" subtitle={entry.title} />
                <StepList steps={shown} />
              </FlowCard>
            ) : null;

  return (
    <>
      <GuacScreen sessionId={conn.sessionId} token={conn.token} attachment={conn.attachment} protocol={entry.protocol} pointer={pointer} active={active && !overlay} clipboard={entry.clipboard}
        onLatchChange={onLatchChange} onTouchTap={onTouchTap}
        fontSize={fontSize} onFontSize={ssh ? onFontSize : undefined}
        onEvent={onEvent} onRemoteClipboard={onRemoteClipboard} apiRef={apiRef} />
      {overlay && (
        <div className="nb-follow-theme absolute inset-0 z-20 overflow-y-auto bg-nb-gray-100/85 text-nb-gray-900 backdrop-blur-xs dark:bg-nb-gray-950/80 dark:text-nb-gray-100">
          <div className="flex min-h-full items-center justify-center p-4">{overlay}</div>
        </div>
      )}
    </>
  );
}
