import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, ClipboardPaste, Keyboard, Maximize2, Minimize2, MonitorPlay, Pin, PinOff, Plus, Power, Terminal, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useScrollLock } from '@/lib/useScrollLock';
import { ApiError } from '@/lib/api';
import { remoteApi, GUAC, PORTAL_MESSAGE_CODES, type RemoteProtocol } from '@/lib/remoteAccess';
import { Button, Field, Input, PasswordInput, Textarea } from '@/components/ui';
import { GuacScreen, deviceSize, type ScreenApi, type ViewerEvent } from './GuacScreen';
import { ARG_LABELS, Card, FailureBox, StepList, StepSummary, explain, usePacedSteps, withStep, type Failure, type Step } from './steps';

// Open browser sessions live here, above the routes: moving to another page of the portal keeps
// them running, and they show as tabs in one full-screen session view. Closing the browser tab
// ends them (the page unloads and each session disconnects).

export interface SessionEntry {
  sessionId: string;
  token: string;
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
  open: boolean;
  add: (e: SessionEntry) => void;
  show: () => void;
}
const SessionsContext = createContext<Ctx>({ count: 0, open: false, add: () => { }, show: () => { } });
export const useRemoteSessions = () => useContext(SessionsContext);

const PIN_KEY = 'nbc.remote.barPinned';
// The bar's height (h-11). Pinned, the sessions start below it.
const BAR_PX = 44;
// How long the pointer must rest on the handle before the bar opens: passing over it does nothing.
const HANDLE_DWELL_MS = 500;

const readPinned = () => { try { return localStorage.getItem(PIN_KEY) === '1'; } catch { return false; } };

/** The size a new session asks for: the session box in device pixels, and the screen's DPI. */
export function sessionScreenSize() {
  return deviceSize(window.innerWidth, window.innerHeight - (readPinned() ? BAR_PX : 0));
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

  const value = useMemo(() => ({ count: sessions.length, open, add, show }), [sessions.length, open, add, show]);
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
  const active = sessions.find((s) => s.sessionId === activeId) || sessions[sessions.length - 1];

  // The bar hides itself (like the connection bar of a desktop RDP client): it shows for a moment
  // when a session comes to the front, then only from the small handle at the top - a click, or
  // the pointer resting on it. The rest of the top edge belongs to the remote screen. Pinned, it
  // stays, and the sessions move down below it so none of the remote screen is covered.
  const [pinned, setPinned] = useState(readPinned);
  const [barShown, setBarShown] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);
  const dwellTimer = useRef<number | undefined>(undefined);
  const hovering = useRef(false);
  const scheduleHide = useCallback((ms: number) => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { if (!hovering.current) setBarShown(false); }, ms);
  }, []);
  const reveal = () => { window.clearTimeout(dwellTimer.current); window.clearTimeout(hideTimer.current); setBarShown(true); };
  const handleEnter = () => { window.clearTimeout(dwellTimer.current); dwellTimer.current = window.setTimeout(reveal, HANDLE_DWELL_MS); };
  const handleLeave = () => window.clearTimeout(dwellTimer.current);
  useEffect(() => { if (open) { reveal(); scheduleHide(3000); } }, [open, activeId, scheduleHide]);
  useEffect(() => () => { window.clearTimeout(hideTimer.current); window.clearTimeout(dwellTimer.current); }, []);
  const keepBar = pinned || clipOpen;
  const barVisible = barShown || keepBar;
  const togglePin = () => setPinned((p) => { const n = !p; try { localStorage.setItem(PIN_KEY, n ? '1' : '0'); } catch { /* ignore */ } return n; });

  // Tabs are keyed by their first session; after a sign-in retry the tab runs a newer one.
  const current = useRef<Record<string, string>>({});
  const disconnect = (id: string) => {
    remoteApi.end(current.current[id] || id).catch(() => { });
    delete current.current[id];
    onRemove(id);
  };
  const leave = () => {
    setClipOpen(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { });
    onHide();
  };
  const newSession = () => { leave(); navigate('/remote-access'); };
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { });
    else rootRef.current?.requestFullscreen?.().catch(() => { });
  };

  const dot = (s: TabStatus | undefined) => cn('h-2 w-2 shrink-0 rounded-full',
    s === 'live' ? 'bg-green-500' : s === 'ended' ? 'bg-nb-gray-500' : 'bg-amber-400 animate-pulse');

  return createPortal(
    <div ref={rootRef}
      className={cn('dark fixed inset-0 z-1050 bg-nb-gray-950 text-nb-gray-100', !open && 'invisible pointer-events-none')}
      role="dialog" aria-modal={open} aria-label="Remote sessions" aria-hidden={!open}>
      {sessions.map((s) => (
        <div key={s.sessionId} style={{ top: pinned ? BAR_PX : 0 }}
          className={cn('absolute inset-x-0 bottom-0', s.sessionId !== active?.sessionId && 'invisible pointer-events-none')}>
          <SessionPane
            entry={s}
            active={open && s.sessionId === active?.sessionId}
            apiRef={apiFor(s.sessionId)}
            onStatus={(st) => setStatus((m) => (m[s.sessionId] === st ? m : { ...m, [s.sessionId]: st }))}
            onRemoteClipboard={(t) => setClips((m) => ({ ...m, [s.sessionId]: t }))}
            onClose={() => disconnect(s.sessionId)}
            onSession={(id) => { current.current[s.sessionId] = id; }}
            onLeave={leave}
          />
        </div>
      ))}

      {/* The handle brings the bar back: a click, or the pointer resting on it. */}
      {!barVisible && active && (
        <button onClick={reveal} onMouseEnter={handleEnter} onMouseLeave={handleLeave} aria-label="Show the session bar"
          className="absolute left-1/2 top-0 z-30 -translate-x-1/2 inline-flex max-w-[60vw] items-center gap-1.5 rounded-b-lg border border-t-0 border-nb-gray-800 bg-nb-gray-940/95 px-3 py-0.5 text-[0.72rem] text-nb-gray-300 shadow-lg">
          <span className={dot(status[active.sessionId])} />
          <span className="truncate">{active.title}</span>
          {sessions.length > 1 && <span className="text-nb-gray-500">+{sessions.length - 1}</span>}
          <ChevronDown size={13} />
        </button>
      )}

      <div
        onMouseEnter={() => { hovering.current = true; reveal(); }}
        onMouseLeave={() => { hovering.current = false; if (!keepBar) scheduleHide(1500); }}
        className={cn('absolute inset-x-0 top-0 z-30 flex items-center gap-2 h-11 px-2 border-b border-nb-gray-800 bg-nb-gray-940/95 shadow-xl transition-transform duration-200',
          barVisible ? 'translate-y-0' : '-translate-y-full')}>
        {/* Tabs: a list on wide screens, a menu on narrow ones. */}
        <div className="hidden sm:flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {sessions.map((s) => (
            <div key={s.sessionId}
              className={cn('group flex min-w-0 max-w-64 items-center gap-1.5 rounded-md border px-2 py-1 text-[0.8rem] cursor-pointer',
                s.sessionId === active?.sessionId ? 'border-nb-gray-700 bg-nb-gray-900 text-white' : 'border-transparent text-nb-gray-400 hover:bg-nb-gray-900/60')}
              onClick={() => onActivate(s.sessionId)} title={s.title}>
              <span className={dot(status[s.sessionId])} />
              {s.protocol === 'rdp' ? <MonitorPlay size={13} className="shrink-0" /> : <Terminal size={13} className="shrink-0" />}
              <span className="truncate">{s.title}</span>
              <button aria-label={`Disconnect ${s.title}`} title="Disconnect"
                onClick={(e) => { e.stopPropagation(); disconnect(s.sessionId); }}
                className="ml-0.5 rounded p-0.5 text-nb-gray-500 hover:text-red-400"><X size={13} /></button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={newSession} title="New Session"><Plus size={15} /></Button>
        </div>
        <div className="sm:hidden flex min-w-0 flex-1 items-center gap-1">
          <select value={active?.sessionId} onChange={(e) => onActivate(e.target.value)} aria-label="Session"
            className="min-w-16 flex-1 rounded-md border border-nb-gray-700 bg-nb-gray-900 px-2 py-1 text-sm text-white">
            {sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>{s.title}</option>)}
          </select>
          <Button size="sm" variant="ghost" onClick={newSession} title="New Session"><Plus size={15} /></Button>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {active?.protocol === 'rdp' && (
            <span className="hidden sm:inline-flex"><Button size="sm" variant="ghost" onClick={() => apis.current[active.sessionId]?.current?.ctrlAltDel()} title="Send Ctrl+Alt+Del"><Keyboard size={15} /><span className="hidden md:inline"> Ctrl+Alt+Del</span></Button></span>
          )}
          {active?.clipboard && (
            <Button size="sm" variant="ghost" onClick={() => setClipOpen((v) => !v)} title="Clipboard"><ClipboardPaste size={15} /></Button>
          )}
          {/* The narrowest phones have no room for it. */}
          <span className="hidden min-[360px]:inline-flex"><Button size="sm" variant="ghost" onClick={fullscreen} title="Full Screen"><Maximize2 size={15} /></Button></span>
          <Button size="sm" variant="ghost" onClick={togglePin} title={pinned ? 'Let The Bar Hide' : 'Keep The Bar Open'}>{pinned ? <PinOff size={15} /> : <Pin size={15} />}</Button>
          <Button size="sm" variant="ghost" onClick={leave} title="Back To The Portal (Sessions Keep Running)"><Minimize2 size={15} /></Button>
          {active && <Button size="sm" variant="danger" onClick={() => disconnect(active.sessionId)}><Power size={15} /><span className="hidden md:inline"> Disconnect</span></Button>}
        </div>
      </div>

      {clipOpen && active?.clipboard && (
        <ClipboardPanel
          key={active.sessionId}
          initial={clips[active.sessionId] || ''}
          onSend={(t) => apis.current[active.sessionId]?.current?.sendClipboard(t)}
          onClose={() => { setClipOpen(false); if (!pinned) scheduleHide(1500); }}
        />
      )}
    </div>,
    document.body,
  );
}

function ClipboardPanel({ initial, onSend, onClose }: { initial: string; onSend: (t: string) => void; onClose: () => void }) {
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  return (
    <div className="absolute right-3 top-14 z-40 w-80 rounded-lg border border-nb-gray-800 bg-nb-gray-950 p-3 shadow-2xl">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold">Clipboard</span>
        <button onClick={onClose} aria-label="Close clipboard" className="text-nb-gray-400 hover:text-red-500 p-1"><X size={16} /></button>
      </div>
      <p className="text-[0.75rem] text-nb-gray-400 mb-2">
        Copy and paste usually just work. If your browser doesn't allow it, text copied on the remote side shows up here,
        and text you paste here can be sent to the remote side.
      </p>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} />
      <div className="flex gap-2 mt-2">
        <Button size="sm" variant="primary" onClick={() => onSend(text)}>Send To Remote</Button>
        <Button size="sm" onClick={() => { navigator.clipboard?.writeText(text).catch(() => { }); }}>Copy Here</Button>
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
function SessionPane({ entry, active, apiRef, onStatus, onRemoteClipboard, onClose, onSession, onLeave }: {
  entry: SessionEntry; active: boolean; apiRef: { current: ScreenApi | null };
  onStatus: (s: TabStatus) => void; onRemoteClipboard: (t: string) => void;
  onClose: () => void;
  /** The session this tab runs now (a new one after a sign-in retry). */
  onSession: (sessionId: string) => void;
  onLeave: () => void;
}) {
  const ssh = entry.protocol === 'ssh';
  const [conn, setConn] = useState({ sessionId: entry.sessionId, token: entry.token });
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
        break;
      case 'paint-timeout':
        pending.current = null;
        setPhase((p) => (p === 'connecting' ? 'live' : p));
        break;
      case 'error': {
        pending.current = null;
        // Wrong credentials: SSH refuses them only at sign-in (also a password typed in the
        // terminal); RDP after the user sent them. Locked or expired accounts are a different code.
        if (ev.status.code === GUAC.CLIENT_UNAUTHORIZED && (ssh || sentCreds.current)) {
          showRetry(ssh ? SSH_FIELDS : askedFor.current.length ? askedFor.current : ['username', 'password']);
          break;
        }
        const x = explain(ev.status, stageRef.current);
        setRequired(null);
        if (phaseRef.current === 'live') {
          setEnded(PORTAL_MESSAGE_CODES.has(ev.status.code) && ev.status.message ? ev.status.message : x.message);
        } else {
          setStep(x.step, 'fail', x.message);
          setFailure({ message: x.message, troubleshoot: x.step === 'server' });
        }
        setPhase('ended');
        break;
      }
      case 'closed':
        pending.current = null;
        setEnded((m) => m || 'The session ended.');
        setPhase('ended');
        break;
    }
  }, [setStep, ssh, apiRef]);

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
        ...sessionScreenSize(),
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
      setRetryError(err instanceof ApiError ? err.message : 'The session could not be opened. Try again.');
      setArgValues((v) => ({ ...v, password: '' }));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const fieldsFor = (params: string[]) => params.map((p) => (
    <Field key={p} label={ARG_LABELS[p] || p}>
      {p === 'password' ? (
        <PasswordInput autoComplete="current-password" autoFocus={active && (p === params[0] || !!argValues.username)}
          value={argValues[p] || ''} onChange={(e) => setArgValues((v) => ({ ...v, [p]: e.target.value }))} />
      ) : (
        <Input autoComplete={p === 'username' ? 'username' : 'off'} autoFocus={active && p === params[0] && !argValues[p]}
          value={argValues[p] || ''} onChange={(e) => setArgValues((v) => ({ ...v, [p]: e.target.value }))} />
      )}
    </Field>
  ));

  const overlay =
    retry ? (
      <Card>
        <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-1.5">{entry.title}</div>
        <StepSummary steps={shown} />
        <form key={conn.sessionId} onSubmit={submitRetry} className="mt-4 flex flex-col gap-3">
          <p className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200">
            {retryError || <>{SIGNIN_FAILED}{ssh && <> {SSH_KEY_NOTE}</>}</>}
          </p>
          {fieldsFor(retry)}
          {ssh && <p className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">Leave the password empty to type it in the terminal.</p>}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Signing In…' : 'Sign In'}</Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </Card>
    )
      : required && caughtUp ? (
        <Card>
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-1.5">{entry.title}</div>
          <StepSummary steps={shown} />
          <form key={conn.sessionId} onSubmit={submitRequired} className="mt-4 flex flex-col gap-3">
            <p className="text-[0.82rem] text-nb-gray-500 dark:text-nb-gray-400">The server asks you to sign in. Your password goes to the server only and is never stored.</p>
            {fieldsFor(required)}
            <div className="flex gap-2">
              <Button type="submit" variant="primary">Sign In</Button>
              <Button onClick={onClose}>Cancel</Button>
            </div>
          </form>
        </Card>
      )
        : phase === 'ended' && failure ? (
          <Card>
            <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-1">{entry.title}</div>
            <StepList steps={shown} />
            {caughtUp && <FailureBox failure={failure} onRetry={onClose} retryLabel="Close" onLeave={onLeave} />}
          </Card>
        )
          : phase === 'ended' ? (
            <Card>
              <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Session Ended</div>
              <p className="mt-1.5 text-sm text-nb-gray-600 dark:text-nb-gray-300">{ended}</p>
              <div className="flex gap-2 mt-4"><Button size="sm" variant="primary" onClick={onClose}>Close</Button></div>
            </Card>
          )
            // Until the paced list has caught up, the step card stays on top (also over a screen that already drew).
            : phase === 'connecting' || required || !caughtUp ? (
              <Card>
                <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-1">{entry.title}</div>
                <StepList steps={shown} />
              </Card>
            ) : null;

  // While a sign-in form is up, keys go to the form (and its buttons), not to the remote.
  const formUp = !!retry || (!!required && caughtUp);
  return (
    <>
      <GuacScreen sessionId={conn.sessionId} token={conn.token} active={active && !formUp} clipboard={entry.clipboard}
        onEvent={onEvent} onRemoteClipboard={onRemoteClipboard} apiRef={apiRef} />
      {overlay && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-nb-gray-950/80 backdrop-blur-xs p-4">
          {overlay}
        </div>
      )}
    </>
  );
}
