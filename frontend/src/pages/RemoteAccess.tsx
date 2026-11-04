import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Loader2, MonitorPlay, Terminal, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ApiError } from '@/lib/api';
import { remoteApi, cleanAddressInput, GUAC, PORTAL_MESSAGE_CODES, type GuacStatus, type RemoteProtocol, type RemoteSession } from '@/lib/remoteAccess';
import { Button, Field, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { RemoteViewer, type ViewerEvent } from '@/components/remote/RemoteViewer';

type StepKey = 'access' | 'path' | 'channel' | 'server' | 'signin';
type StepState = 'pending' | 'running' | 'pass' | 'fail';
interface Step { key: StepKey; label: string; state: StepState; detail?: string }

const STEP_LABELS: Record<StepKey, string> = {
  access: 'Checking Permissions',
  path: 'Checking The Path',
  channel: 'Opening A Secure Channel',
  server: 'Connecting To The Server',
  signin: 'Signing In',
};
const DEFAULT_PORT: Record<RemoteProtocol, number> = { rdp: 3389, ssh: 22 };
const ARG_LABELS: Record<string, string> = { username: 'User Name', password: 'Password', domain: 'Domain' };

// Short names for the one-line summary shown once the checks are behind the user.
const STEP_SHORT: Record<StepKey, string> = {
  access: 'Permissions',
  path: 'Path',
  channel: 'Secure Channel',
  server: 'Server',
  signin: 'Sign In',
};

// Each running step stays on screen for at least this long, so the user can follow the checks.
// The first connection in a browser tab moves slower; later ones move quicker.
const PACE_FIRST_MS = 850;
const PACE_MS = 450;
const PACE_KEY = 'nbc.remoteAccess.pacedOnce';

function pickDwell(): number {
  if (typeof window === 'undefined') return 0;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
  try { return sessionStorage.getItem(PACE_KEY) ? PACE_MS : PACE_FIRST_MS; } catch { return PACE_MS; }
}

const sameStep = (a: Step, b: Step) => a.key === b.key && a.state === b.state && a.detail === b.detail;
const RANK: Record<StepState, number> = { pending: 0, running: 1, pass: 2, fail: 2 };

// Display-only pacing: the real checks run at full speed, and the list on screen follows them one
// change at a time, holding each running step for `dwellMs`. `caughtUp` tells the caller that the
// screen shows the real state, so a result (a failure, a sign-in form) never appears before its step.
function usePacedSteps(target: Step[], dwellMs: number): { shown: Step[]; caughtUp: boolean } {
  const [shown, setShown] = useState<Step[]>(target);
  const since = useRef<Partial<Record<StepKey, number>>>({});
  useEffect(() => {
    const byKey = new Map(target.map((t) => [t.key, t]));
    // A reset (or anything the screen is ahead of) snaps to the real state.
    const reset = shown.some((s) => { const t = byKey.get(s.key); return !t || RANK[s.state] > RANK[t.state]; });
    if (reset) {
      const now = Date.now();
      for (const t of target) if (t.state === 'running') since.current[t.key] = now;
      setShown(target);
      return;
    }
    const missing = target.filter((t) => !shown.some((s) => s.key === t.key));
    if (missing.length) { setShown([...shown, ...missing.map((t) => ({ ...t, state: 'pending' as StepState, detail: undefined }))]); return; }
    const i = shown.findIndex((s) => !sameStep(s, byKey.get(s.key)!));
    if (i < 0) return;
    const cur = shown[i];
    const want = byKey.get(cur.key)!;
    let next: Step;
    let delay = 0;
    if (cur.state === 'pending' && want.state !== 'pending') {
      next = { ...cur, state: 'running', detail: want.state === 'running' ? want.detail : undefined };
    } else if (cur.state === 'running' && want.state !== 'running') {
      next = want;
      delay = Math.max(0, dwellMs - (Date.now() - (since.current[cur.key] ?? 0)));
    } else {
      next = want;
    }
    const t = setTimeout(() => {
      if (next.state === 'running' && cur.state !== 'running') since.current[cur.key] = Date.now();
      setShown((prev) => prev.map((s) => (s.key === next.key ? next : s)));
    }, delay);
    return () => clearTimeout(t);
  }, [target, shown, dwellMs]);
  const caughtUp = shown.length === target.length && shown.every((s, i) => sameStep(s, target[i]));
  return { shown, caughtUp };
}

const freshSteps = (): Step[] => (['access', 'path', 'channel', 'server'] as StepKey[]).map((key) => ({ key, label: STEP_LABELS[key], state: 'pending' }));

type Phase = 'form' | 'checking' | 'ssh-creds' | 'connecting' | 'live' | 'ended';
interface Failure { message: string; requestable?: boolean; troubleshoot?: boolean }

function StepIcon({ state }: { state: StepState }) {
  if (state === 'running') return <Loader2 size={17} className="shrink-0 text-netbird animate-spin" />;
  if (state === 'pass') return <CheckCircle2 size={17} className="shrink-0 text-green-500" />;
  if (state === 'fail') return <XCircle size={17} className="shrink-0 text-red-500" />;
  return <Circle size={17} className="shrink-0 text-nb-gray-300 dark:text-nb-gray-700" />;
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((s) => (
        <li key={s.key} className="flex items-start gap-3 py-2">
          <StepIcon state={s.state} />
          <div className="min-w-0">
            <div className={cn('text-[0.9rem] font-medium',
              s.state === 'pending' ? 'text-nb-gray-400 dark:text-nb-gray-500' : 'text-nb-gray-800 dark:text-nb-gray-100')}>{s.label}</div>
            {s.detail && <div className="text-[0.8rem] text-nb-gray-500 dark:text-nb-gray-400 mt-0.5">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// The checks that already passed, on one line - used once the user has something to fill in.
function StepSummary({ steps }: { steps: Step[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">
      {steps.filter((s) => s.state === 'pass').map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1">
          <CheckCircle2 size={13} className="shrink-0 text-green-500" />{STEP_SHORT[s.key]}
        </span>
      ))}
    </div>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-full max-w-md rounded-xl border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-5 shadow-xl', className)}>{children}</div>;
}

// The reason is already on the failed step; this box holds what the user can do next.
function FailureBox({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  return (
    <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
      <div className="flex flex-wrap gap-2">
        {failure.requestable && <Link to="/request-access"><Button size="sm" variant="primary">Request Access</Button></Link>}
        {failure.troubleshoot && <Link to="/troubleshoot"><Button size="sm">Open Troubleshoot</Button></Link>}
        <Button size="sm" onClick={onRetry}>Try Again</Button>
      </div>
    </div>
  );
}

// Translate a Guacamole status into the step it belongs to and a human sentence.
function explain(status: GuacStatus, stage: 'server' | 'signin'): { step: StepKey; message: string } {
  if (PORTAL_MESSAGE_CODES.has(status.code) && status.message) return { step: stage, message: status.message };
  switch (status.code) {
    case GUAC.CLIENT_UNAUTHORIZED:
    case GUAC.CLIENT_FORBIDDEN:
      return { step: 'signin', message: "Sign-in failed. Check the user name and password, then connect again." };
    case GUAC.UPSTREAM_NOT_FOUND:
    case GUAC.UPSTREAM_TIMEOUT:
      return { step: 'server', message: "The server didn't answer. Check that it is running and accepts remote connections on this port." };
    case GUAC.UPSTREAM_ERROR:
      return { step: stage, message: 'The server ended the connection. It may not accept this kind of connection, or it refused the sign-in.' };
    case -1:
      return { step: 'channel', message: status.message || 'The session could not start.' };
    default:
      return { step: stage, message: status.message ? `The session ended: ${status.message}` : 'The session ended unexpectedly.' };
  }
}

export default function RemoteAccess() {
  const info = useQuery({ queryKey: ['remote-access-info'], queryFn: remoteApi.info });
  const [protocol, setProtocol] = useState<RemoteProtocol>('rdp');
  const [address, setAddress] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PORT.rdp));
  const [portTouched, setPortTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [steps, setSteps] = useState<Step[]>(freshSteps);
  const [dwell, setDwell] = useState(pickDwell);
  const { shown, caughtUp } = usePacedSteps(steps, dwell);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [targetLabel, setTargetLabel] = useState('');
  const [session, setSession] = useState<RemoteSession | null>(null);
  const [required, setRequired] = useState<string[] | null>(null);
  const [endNote, setEndNote] = useState('');
  // An error after the session was live: shown as 'Session Ended', not as a failed step.
  const [endError, setEndError] = useState('');
  const phaseRef = useRef<Phase>('form');
  phaseRef.current = phase;
  const submitRef = useRef<((values: Record<string, string>) => void) | null>(null);
  const stageRef = useRef<'server' | 'signin'>('server');

  // SSH credentials (asked after the checks pass, sent with the session request).
  const [sshUser, setSshUser] = useState('');
  const [sshPass, setSshPass] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [argValues, setArgValues] = useState<Record<string, string>>({});

  useEffect(() => { if (!portTouched) setPort(String(DEFAULT_PORT[protocol])); }, [protocol, portTouched]);

  const setStep = useCallback((key: StepKey, state: StepState, detail?: string) => {
    setSteps((prev) => {
      const has = prev.some((s) => s.key === key);
      const list = has ? prev : [...prev, { key, label: STEP_LABELS[key], state: 'pending' as StepState }];
      return list.map((s) => (s.key === key ? { ...s, state, detail } : s));
    });
  }, []);

  const reset = () => {
    setPhase('form'); setSteps(freshSteps()); setFailure(null); setSession(null); setRequired(null);
    setSshPass(''); setSshKey(''); setSshPassphrase(''); setArgValues({}); setEndNote(''); setEndError(''); stageRef.current = 'server';
  };

  const fail = (key: StepKey, f: Failure) => {
    setStep(key, 'fail', f.message);
    setFailure(f);
  };

  const portNum = parseInt(port, 10);
  // The target form is locked while a check or session is under way; after a failure it is free again.
  // It also stays locked while the paced list is still catching up with a result.
  const locked = (phase === 'checking' && !failure) || phase === 'ssh-creds' || phase === 'connecting' || (phase === 'checking' && !caughtUp);

  // Paste, blur and submit clean the address; typing ":" moves on to the port field.
  const portRef = useRef<HTMLInputElement>(null);
  // The cleaned target of the current attempt (state updates land only after this handler).
  const targetRef = useRef<{ address: string; port: number }>({ address: '', port: 0 });
  const applyAddress = (raw: string) => {
    const c = cleanAddressInput(raw);
    setAddress(c.address);
    if (c.port) { setPort(c.port); setPortTouched(true); }
    return c;
  };

  const start = async (e: FormEvent) => {
    e.preventDefault();
    const typed = applyAddress(address);
    const target = typed.address;
    const targetPort = typed.port ? Number(typed.port) : portNum;
    targetRef.current = { address: target, port: targetPort };
    setFailure(null);
    setSteps(freshSteps());
    setDwell(pickDwell());
    try { sessionStorage.setItem(PACE_KEY, '1'); } catch { /* private mode: every connection is paced as the first */ }
    setPhase('checking');
    setStep('access', 'running');
    try {
      const r = await remoteApi.check({ protocol, address: target, port: targetPort });
      const access = r.steps.find((s) => s.key === 'access');
      const path = r.steps.find((s) => s.key === 'path');
      // A name the portal looked up shows where it leads: "name -> ip".
      const t = r.target;
      const where = t?.name && t.gateway === 'ip' && t.address && t.address !== t.name ? `${t.name} → ${t.address}` : (t?.name || target);
      setTargetLabel(t?.resource ? `${t.resource.name} (${where}:${targetPort})` : `${where}:${targetPort}`);
      if (!access || access.status === 'fail') { fail('access', { message: access?.message || 'Access was denied.', requestable: access?.requestable }); return; }
      setStep('access', 'pass', access.detail);
      if (!path || path.status === 'fail') { fail('path', { message: path?.message || 'The path could not be checked.', troubleshoot: path?.troubleshoot }); return; }
      setStep('path', 'pass', path.detail);
      if (protocol === 'ssh') { setPhase('ssh-creds'); return; }
      await openSession();
    } catch (err) {
      fail('access', { message: err instanceof ApiError ? err.message : 'Your access could not be checked. Try again.' });
    }
  };

  const openSession = async (creds?: Record<string, string>) => {
    setPhase('connecting');
    setStep('channel', 'running');
    try {
      const s = await remoteApi.createSession({
        protocol, address: targetRef.current.address, port: targetRef.current.port,
        width: window.innerWidth, height: Math.max(240, window.innerHeight - 44), dpi: Math.round(96 * (window.devicePixelRatio || 1)),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(creds || {}),
      });
      setSession(s);
    } catch (err) {
      fail('channel', { message: err instanceof ApiError ? err.message : 'The session could not be opened. Try again.' });
      setPhase('checking');
    }
  };

  const onViewerEvent = useCallback((ev: ViewerEvent) => {
    switch (ev.type) {
      case 'channel-open':
        setStep('channel', 'pass');
        setStep('server', 'running');
        break;
      case 'required':
        // Only an NLA server asks for credentials at this point - proof it was reached.
        setStep('server', 'pass');
        setStep('signin', 'running');
        stageRef.current = 'signin';
        setRequired(ev.params);
        setArgValues(Object.fromEntries(ev.params.map((p) => [p, ''])));
        break;
      case 'connected':
        // The first sync arrives before the remote side has drawn anything - not proof yet.
        break;
      case 'painted':
        // Real remote content (a desktop, a logon screen, a terminal prompt) is on the screen.
        if (phaseRef.current === 'connecting') setStep('server', 'pass');
        setPhase((p) => (p === 'connecting' ? 'live' : p));
        break;
      case 'paint-timeout':
        // Nothing drawn yet: show the screen as it is, without claiming the server answered.
        setPhase((p) => (p === 'connecting' ? 'live' : p));
        break;
      case 'error': {
        const x = explain(ev.status, stageRef.current);
        setRequired(null);
        if (phaseRef.current === 'live') {
          const msg = PORTAL_MESSAGE_CODES.has(ev.status.code) && ev.status.message ? ev.status.message : x.message;
          setEndError(msg);
          setEndNote(msg);
          setPhase('ended');
          break;
        }
        fail(x.step, { message: x.message, troubleshoot: x.step === 'server' });
        setPhase('ended');
        break;
      }
      case 'closed':
        setPhase((p) => (p === 'ended' ? p : 'ended'));
        setEndNote((n) => n || 'The session ended.');
        break;
    }
  }, [setStep]);

  const submitRequired = (e: FormEvent) => {
    e.preventDefault();
    submitRef.current?.(argValues);
    setRequired(null);
    setArgValues({});
    setPhase('live');
  };

  const disconnect = () => {
    if (session) remoteApi.end(session.sessionId).catch(() => { });
    setSession(null);
    setEndNote('You disconnected the session.');
    setPhase('ended');
  };

  if (info.isLoading) return <LoadingState />;
  const ra = info.data;
  if (!ra || !ra.available || !ra.allowed) {
    const why = !ra ? 'Remote access information could not be loaded.'
      : ra.ssoRequired ? 'Browser remote access needs SSO sign-in, which is not configured.'
        : !ra.available ? 'Browser remote access is turned off.'
          : "You don't have permission to use browser remote access. Ask an administrator.";
    return (
      <div className="max-w-2xl">
        <PageHeader title="Remote Access" description="Open RDP and SSH sessions from the browser." />
        <p className="text-sm text-nb-gray-600 dark:text-nb-gray-300">{why}</p>
      </div>
    );
  }

  const showViewer = !!session && (phase === 'connecting' || phase === 'live' || (phase === 'ended' && (!!failure || !!endError)));
  const stepCard = (
    <Card>
      <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-1">{targetLabel || 'Connecting'}</div>
      <StepList steps={shown} />
      {failure && caughtUp && <FailureBox failure={failure} onRetry={reset} />}
    </Card>
  );

  const requiredForm = required && (
    <Card>
      <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-1.5">{targetLabel || 'Sign In'}</div>
      <StepSummary steps={shown} />
      <form onSubmit={submitRequired} className="mt-4 flex flex-col gap-3">
        <p className="text-[0.82rem] text-nb-gray-500 dark:text-nb-gray-400">The server asks you to sign in. Your password goes to the server only and is never stored.</p>
        {required.map((p) => (
          <Field key={p} label={ARG_LABELS[p] || p}>
            <Input
              type={p === 'password' ? 'password' : 'text'}
              autoComplete={p === 'password' ? 'current-password' : p === 'username' ? 'username' : 'off'}
              autoFocus={p === required[0]}
              value={argValues[p] || ''}
              onChange={(e) => setArgValues((v) => ({ ...v, [p]: e.target.value }))}
            />
          </Field>
        ))}
        <div className="flex gap-2">
          <Button type="submit" variant="primary">Sign In</Button>
          <Button onClick={disconnect}>Cancel</Button>
        </div>
      </form>
    </Card>
  );

  const endedCard = (
    <Card>
      <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Session Ended</div>
      <p className="mt-1.5 text-sm text-nb-gray-600 dark:text-nb-gray-300">{endError}</p>
      <div className="flex gap-2 mt-4">
        <Button size="sm" variant="primary" onClick={() => setSession(null)}>Close</Button>
      </div>
    </Card>
  );

  // Until the paced list has caught up, the step card stays on top (also over a screen that already drew).
  const viewerOverlay = required && caughtUp ? requiredForm
    : phase === 'ended' && endError ? endedCard
    : phase === 'connecting' || required || (phase === 'live' && !caughtUp) ? stepCard
      : phase === 'ended' && failure ? stepCard
        : undefined;

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Remote Access"
        description={<>Connect to a server from the browser with RDP or SSH. You can reach the same servers your NetBird access already allows - nothing more.</>}
      />

      {(phase === 'form' || phase === 'checking' || phase === 'ssh-creds' || (phase === 'ended' && !showViewer)) && (
        <div className="rounded-xl border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-5">
          <form onSubmit={start} className="grid grid-cols-1 sm:grid-cols-[8rem_1fr_7rem] gap-3 items-end">
            <Field label="Protocol">
              <Select value={protocol} onChange={(e) => { setProtocol(e.target.value as RemoteProtocol); }} disabled={locked}>
                <option value="rdp">RDP</option>
                <option value="ssh">SSH</option>
              </Select>
            </Field>
            <Field label="Server Address">
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text');
                  if (!text) return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  const merged = el.value.slice(0, el.selectionStart ?? el.value.length) + text + el.value.slice(el.selectionEnd ?? el.value.length);
                  applyAddress(merged);
                }}
                onKeyDown={(e) => {
                  if (e.key === ':' && !address.startsWith('[')) { e.preventDefault(); setPortTouched(true); portRef.current?.focus(); portRef.current?.select(); }
                }}
                onBlur={() => applyAddress(address)}
                placeholder="10.0.0.5 or server.example.com"
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
                required disabled={locked}
              />
            </Field>
            <Field label="Port">
              <Input ref={portRef} value={port} onChange={(e) => { setPort(e.target.value.replace(/[^0-9]/g, '')); setPortTouched(true); }} inputMode="numeric" required disabled={locked} />
            </Field>
            <div className="sm:col-span-3 flex items-center gap-3">
              <Button type="submit" variant="primary" disabled={locked || !address.trim() || !(portNum > 0)}>
                {protocol === 'rdp' ? <MonitorPlay size={16} /> : <Terminal size={16} />} Connect
              </Button>
              <span className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">
                Sessions close after {ra.idleTimeoutMin} idle minutes and after {ra.maxDurationHours} hours.
              </span>
            </div>
          </form>

          {phase !== 'form' && (
            <div className="mt-5 border-t border-nb-gray-100 dark:border-nb-gray-900 pt-4">
              {/* After a session that ran, the steps are history - only the outcome matters. */}
              {phase === 'ssh-creds' && caughtUp ? <StepSummary steps={shown} />
                : !(phase === 'ended' && !failure) && <StepList steps={shown} />}
              {failure && caughtUp && <FailureBox failure={failure} onRetry={reset} />}
              {phase === 'ended' && !failure && endNote && (
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-sm text-nb-gray-600 dark:text-nb-gray-300">{endNote}</span>
                  <Button size="sm" onClick={reset}>Connect Again</Button>
                </div>
              )}
            </div>
          )}

          {phase === 'ssh-creds' && caughtUp && (
            <form
              className="mt-4 flex flex-col gap-3 border-t border-nb-gray-100 dark:border-nb-gray-900 pt-4"
              onSubmit={(e) => { e.preventDefault(); void openSession({ username: sshUser.trim(), password: sshPass, privateKey: sshKey, passphrase: sshPassphrase }); }}
            >
              <p className="text-[0.82rem] text-nb-gray-500 dark:text-nb-gray-400">Sign in to the SSH server. Your password or key goes to the server only and is never stored.</p>
              <Field label="User Name"><Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} autoComplete="username" autoFocus required /></Field>
              <Field label="Password" hint="Leave empty to use a private key, or to type the password in the terminal.">
                <Input type="password" value={sshPass} onChange={(e) => setSshPass(e.target.value)} autoComplete="current-password" />
              </Field>
              <Field label="Private Key (Optional)"><Textarea value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={3} /></Field>
              {sshKey.trim() && <Field label="Key Passphrase (Optional)"><Input type="password" value={sshPassphrase} onChange={(e) => setSshPassphrase(e.target.value)} /></Field>}
              <div className="flex gap-2">
                <Button type="submit" variant="primary">Connect</Button>
                <Button onClick={reset}>Cancel</Button>
              </div>
            </form>
          )}
        </div>
      )}

      {showViewer && session && (
        <RemoteViewer
          sessionId={session.sessionId}
          token={session.token}
          protocol={protocol}
          title={targetLabel}
          clipboard={ra.clipboard}
          overlay={viewerOverlay}
          onEvent={onViewerEvent}
          onClose={phase === 'ended' ? () => { setSession(null); } : disconnect}
          submitRef={submitRef}
        />
      )}
    </div>
  );
}
