import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Loader2, Lock, MonitorPlay, Terminal, X as XIcon, XCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { requestAccessLink } from '@/lib/requestAccess';
import { remoteApi, cleanAddressInput, type RemoteInfo, type RemoteProtocol, type RemoteSession } from '@/lib/remoteAccess';
import { cn } from '@/lib/cn';
import { Button, Field, Input, LoadingState, PasswordInput, Textarea } from '@/components/ui';
import { sessionScreenSize, useRemoteSessions } from '@/components/remote/RemoteSessions';
import { FLOW_BUTTON, FLOW_INPUT, FLOW_QUIET, FlowCard, FlowHeader, FlowTile } from '@/components/remote/flow';
import {
  FailureBox, PACE_KEY, StepList, StepSummary, freshSteps, handoffSteps, pickDwell, usePacedSteps, withStep,
  type Failure, type Step, type StepKey, type StepState,
} from '@/components/remote/steps';

const DEFAULT_PORT: Record<RemoteProtocol, number> = { rdp: 3389, ssh: 22 };
// While remote access is getting ready, ask again this often, for at most this long.
const READY_RETRY_MS = 5000;
const READY_WAIT_MS = 150_000;
const NOT_READY = 'Remote access is still not ready. Try again in a few minutes, or tell an administrator.';
const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;
// A request still unanswered this long after the deadline ends the wait (its answer is ignored).
const REQUEST_GRACE_MS = 10_000;
const TIMED_OUT = Symbol('timed out');
function bounded<T>(p: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> {
  const left = Math.max(0, deadline - Date.now()) + REQUEST_GRACE_MS;
  let timer: number | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((done) => { timer = window.setTimeout(() => done(TIMED_OUT), left); });
  return Promise.race([p, timeout]).finally(() => window.clearTimeout(timer));
}

// "Resource (name -> ip:port)" from what the server actually opened.
function sessionTitle(s: RemoteSession, port: number): string {
  if (!s.address) return '';
  const where = s.name && s.gateway === 'ip' && s.address !== s.name ? `${s.name} → ${s.address}` : (s.name || s.address);
  return s.resource?.name ? `${s.resource.name} (${where}:${port})` : `${where}:${port}`;
}

// The page runs the checks (access, path, SSH credentials) and asks the server for a session.
// The session itself opens as a tab in the session view (components/remote/RemoteSessions.tsx),
// which keeps it running while the user moves around the portal.
type Phase = 'form' | 'checking' | 'ssh-creds' | 'opening';

export default function RemoteAccess() {
  const info = useQuery({ queryKey: ['remote-access-info'], queryFn: ({ signal }) => remoteApi.info(signal) });
  const sessions = useRemoteSessions();
  const [protocol, setProtocol] = useState<RemoteProtocol>('rdp');
  const [address, setAddress] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PORT.rdp));
  const [portTouched, setPortTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [steps, setSteps] = useState<Step[]>(freshSteps);
  const [dwell, setDwell] = useState(pickDwell);
  const { shown, caughtUp } = usePacedSteps(steps, dwell);
  const [failure, setFailure] = useState<Failure | null>(null);
  // What the checks found, for the session tab (state set in this handler lands only later).
  const checked = useRef<{ label: string; access?: string; path?: string }>({ label: '' });

  // SSH credentials (asked after the checks pass, sent with the session request).
  const [sshUser, setSshUser] = useState('');
  const [sshPass, setSshPass] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');

  useEffect(() => { if (!portTouched) setPort(String(DEFAULT_PORT[protocol])); }, [protocol, portTouched]);

  // A launch link from another system (/remote-access?launch=<ticket>): opened once, with the
  // credentials the server already holds. The server uses a link up on its first try, so the page
  // first waits for remote access to be ready - a fresh /info answer (never the cache) without
  // settling - and only then sends it. One run handles one stay on the link: Cancel, the link
  // leaving the address or leaving the page ends it, and coming back to a link that was not sent
  // yet starts a new run. The link leaves the address only once it was sent (or on Cancel), so a
  // reload or a sign-in in between comes back to it.
  const [params, setParams] = useSearchParams();
  const launchTicket = params.get('launch') || '';
  // A banner belongs to its link. keep: the result of a link that was sent, shown after the link
  // left the address on purpose.
  const [launch, setLaunch] = useState<{ state: 'opening' | 'waiting'; ticket: string } | { state: 'failed'; message: string; ticket: string; keep?: boolean } | null>(null);
  const qc = useQueryClient();
  const addSession = sessions.add;
  const run = useRef<{ ticket: string; stopped: boolean; timer?: number; ctrl: AbortController } | null>(null);
  // Links already sent to the server in this page (used up there).
  const sent = useRef(new Set<string>());
  const onLink = (ticket: string) => new URLSearchParams(window.location.search).get('launch') === ticket;
  const dropLink = (ticket: string) => {
    if (onLink(ticket)) setParams(() => { const n = new URLSearchParams(window.location.search); n.delete('launch'); return n; }, { replace: true });
  };
  const stopRun = () => {
    if (run.current) { run.current.stopped = true; window.clearTimeout(run.current.timer); run.current.ctrl.abort(); }
    run.current = null;
  };
  useEffect(() => () => stopRun(), []);
  const cancelLaunch = () => { stopRun(); dropLink(launchTicket); setLaunch(null); };
  useEffect(() => {
    // Another link or none (New Session from the session view, history): the run and the banner of
    // the link that left go, before anything else.
    if (run.current && run.current.ticket !== launchTicket) stopRun();
    setLaunch((l) => (l && l.ticket !== launchTicket && !(l.state === 'failed' && l.keep) ? null : l));
    if (!launchTicket) return;
    if (run.current?.ticket === launchTicket || sent.current.has(launchTicket)) return;
    const me: { ticket: string; stopped: boolean; timer?: number; ctrl: AbortController } = { ticket: launchTicket, stopped: false, ctrl: new AbortController() };
    run.current = me;
    const live = () => !me.stopped && onLink(me.ticket);
    const reload = (why: string) => setLaunch({ state: 'failed', ticket: me.ticket, message: `${why} Reload the page to try again.` });
    void (async () => {
      setLaunch({ state: 'opening', ticket: me.ticket });
      const deadline = Date.now() + READY_WAIT_MS;
      let announced = false;
      let ready: RemoteInfo | null = null;
      for (;;) {
        const r = await bounded(remoteApi.info(me.ctrl.signal).then((i) => ({ i }), (e: unknown) => ({ e })), deadline);
        if (!live()) return;
        if (r === TIMED_OUT) { me.ctrl.abort(); reload("Remote access couldn't be reached."); return; }
        if ('e' in r) {
          // 401: the sign-in ended; the browser signs in again and comes back to this address.
          if (r.e instanceof ApiError && r.e.status === 401) return;
        } else {
          // The page shows this answer too (it may have failed to load before).
          await qc.cancelQueries({ queryKey: ['remote-access-info'] });
          if (!live()) return;
          qc.setQueryData(['remote-access-info'], r.i);
          if (!r.i.available || !r.i.allowed) { setLaunch(null); return; }
          if (!r.i.settling) { ready = r.i; break; }
        }
        if (Date.now() + READY_RETRY_MS >= deadline) {
          reload('e' in r ? "Remote access couldn't be reached." : 'Remote access is still not ready.');
          return;
        }
        if (!announced) { announced = true; setLaunch({ state: 'waiting', ticket: me.ticket }); }
        await new Promise((go) => { me.timer = window.setTimeout(go, READY_RETRY_MS); });
        if (!live()) return;
      }
      setLaunch({ state: 'opening', ticket: me.ticket });
      sent.current.add(me.ticket);
      try {
        const s = await remoteApi.redeemLaunch({
          ticket: me.ticket, ...sessionScreenSize(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        // Nobody waits for it any more (Cancel, another link, another page): end it.
        if (!live()) { remoteApi.end(s.sessionId).catch(() => { }); return; }
        dropLink(me.ticket);
        setLaunch(null);
        addSession({
          sessionId: s.sessionId, token: s.token, protocol: s.protocol,
          title: sessionTitle(s, s.port) || `${s.address}:${s.port}`,
          clipboard: ready.clipboard,
          steps: handoffSteps(),
          dwell: pickDwell(), target: { address: s.address || '', port: s.port }, serverCredentials: true,
        });
      } catch (err) {
        // 401: refused before the link was looked at; after the sign-in the page loads it again.
        if (err instanceof ApiError && err.status === 401) { sent.current.delete(me.ticket); return; }
        if (!live()) return;
        dropLink(me.ticket);
        // Settling that started just as the link was sent: the link is used up by now.
        const settling = err instanceof ApiError && err.code === 'TARGETS_SETTLING';
        setLaunch({
          state: 'failed', ticket: me.ticket, keep: true,
          message: settling ? 'Remote access started a change as it opened. Open the link again in a minute.'
            : err instanceof ApiError ? err.message : "The connection couldn't be opened. Open the link again.",
        });
      }
    })();
    // Runs on the link only: the rest of what it reads is stable (refs, setters, the query client).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchTicket]);

  const setStep = useCallback((key: StepKey, state: StepState, detail?: string) => setSteps((p) => withStep(p, key, state, detail)), []);

  // Each connection attempt has a number: a newer attempt, Cancel or leaving the page ends the
  // waiting of an older one.
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; }, []);
  const [waiting, setWaiting] = useState(false);

  const reset = () => {
    attempt.current += 1;
    setWaiting(false);
    setPhase('form'); setSteps(freshSteps()); setFailure(null);
    setSshPass(''); setSshKey(''); setSshPassphrase('');
  };

  const fail = (key: StepKey, f: Failure) => {
    setStep(key, 'fail', f.message);
    setFailure(f);
  };

  const portNum = parseInt(port, 10);
  // The target form is locked while a check is under way; after a failure it is free again. It
  // also stays locked while the paced list is still catching up with a result.
  const locked = (phase === 'checking' && (!failure || !caughtUp)) || phase === 'ssh-creds' || phase === 'opening';

  // Paste, blur and submit clean the address; typing ":" moves on to the port field.
  const portRef = useRef<HTMLInputElement>(null);
  // Try Again runs the same connection again: the form as it is now (the target the user typed,
  // or changed after the failure).
  const formRef = useRef<HTMLFormElement>(null);
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
    // The same rule as the Connect button, also for Try Again (which submits the form as it is).
    if (!target || !validPort(targetPort)) { portRef.current?.focus(); return; }
    // SSH secrets are typed again for every attempt: even the same name may lead to another server
    // now (DNS), and they must never go to a server they were not typed for. The user name stays.
    setSshPass(''); setSshKey(''); setSshPassphrase('');
    targetRef.current = { address: target, port: targetPort };
    setFailure(null);
    setSteps(freshSteps());
    setDwell(pickDwell());
    try { sessionStorage.setItem(PACE_KEY, '1'); } catch { /* private mode: every connection is paced as the first */ }
    setPhase('checking');
    setStep('ready', 'running');
    const mine = ++attempt.current;
    const deadline = Date.now() + READY_WAIT_MS;
    try {
      // Remote access itself first: while it is getting ready (a recent change, a restart), the
      // check is asked again every few seconds instead of failing.
      const first = await bounded(remoteApi.check({ protocol, address: target, port: targetPort }), Date.now() + 20_000);
      if (attempt.current !== mine) return;
      if (first === TIMED_OUT) { fail('ready', { message: "Remote access didn't answer. Try again in a moment." }); return; }
      let r = first;
      let announced = false;
      for (;;) {
        if (attempt.current !== mine) return;
        const env = r.steps.find((s) => s.key === 'ready');
        if (!env) break;
        // The next check only if it still starts before the deadline.
        if (!env.retry || Date.now() + READY_RETRY_MS >= deadline) {
          setWaiting(false);
          fail('ready', { message: env.retry ? NOT_READY : env.message || 'Remote access is not ready. Try again in a moment.' });
          return;
        }
        if (!announced) {
          announced = true;
          setWaiting(true);
          setStep('ready', 'running', 'Getting ready. This usually takes about a minute.');
        }
        await new Promise((done) => window.setTimeout(done, READY_RETRY_MS));
        if (attempt.current !== mine) return;
        if (Date.now() >= deadline) { setWaiting(false); fail('ready', { message: NOT_READY }); return; }
        const next = await bounded(remoteApi.check({ protocol, address: target, port: targetPort }), deadline);
        if (attempt.current !== mine) return;
        if (next === TIMED_OUT) { setWaiting(false); fail('ready', { message: NOT_READY }); return; }
        r = next;
      }
      setWaiting(false);
      setStep('ready', 'pass');
      const access = r.steps.find((s) => s.key === 'access');
      const path = r.steps.find((s) => s.key === 'path');
      // A name the portal looked up shows where it leads: "name -> ip".
      const t = r.target;
      const where = t?.name && t.gateway === 'ip' && t.address && t.address !== t.name ? `${t.name} → ${t.address}` : (t?.name || target);
      checked.current = { label: t?.resource ? `${t.resource.name} (${where}:${targetPort})` : `${where}:${targetPort}` };
      if (!access || access.status === 'fail') {
        // The denied resource goes along, so the request page opens with it chosen.
        const requestLink = access?.requestable
          ? requestAccessLink(t?.resource ? {
            type: 'resource', id: t.resource.id, name: t.resource.name,
            networkId: t.network?.id, resourceType: t.resource.type || undefined,
          } : null)
          : undefined;
        fail('access', { message: access?.message || 'Access was denied.', requestLink });
        return;
      }
      setStep('access', 'pass', access.detail);
      checked.current.access = access.detail;
      if (!path || path.status === 'fail') { fail('path', { message: path?.message || 'The path could not be checked.', troubleshoot: path?.troubleshoot }); return; }
      setStep('path', 'pass', path.detail);
      checked.current.path = path.detail;
      if (protocol === 'ssh') { setPhase('ssh-creds'); return; }
      await openSession();
    } catch (err) {
      if (attempt.current !== mine) return;
      setWaiting(false);
      fail('ready', { message: err instanceof ApiError ? err.message : 'Your access could not be checked. Try again.' });
    }
  };

  // The session request opens the route too: the server joins its gateway's targets if it isn't
  // there yet, and the server waits until the route has reached the gateway (about 2 seconds).
  const openSession = async (creds?: Record<string, string>) => {
    setPhase('opening');
    setStep('route', 'running');
    const c = checked.current;
    const handoff = handoffSteps({ access: c.access, path: c.path });
    try {
      const s = await remoteApi.createSession({
        protocol, address: targetRef.current.address, port: targetRef.current.port,
        // The session view uses the whole window (the bar floats over it).
        ...sessionScreenSize(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(creds || {}),
      });
      sessions.add({
        sessionId: s.sessionId, token: s.token, protocol, title: sessionTitle(s, targetRef.current.port) || c.label || `${targetRef.current.address}:${targetRef.current.port}`,
        clipboard: !!info.data?.clipboard, steps: handoff, dwell,
        target: { ...targetRef.current }, user: creds?.username,
      });
      reset();
    } catch (err) {
      // Settling (or NetBird gone) after the checks passed is the environment, not the route: Try
      // Again checks everything again and waits for it.
      if (err instanceof ApiError && (err.code === 'TARGETS_SETTLING' || err.code === 'SNAPSHOT_FAILED')) {
        setStep('route', 'pending');
        fail('ready', { message: err.code === 'TARGETS_SETTLING' ? 'Remote access started applying a change. Try again: it waits until it is ready.' : err.message });
      } else {
        fail('route', { message: err instanceof ApiError ? err.message : 'The session could not be opened. Try again.' });
      }
      setPhase('checking');
    }
  };

  // The launch link's state, as an alert: a short title and one line under it.
  const launchAlert = launch && (launch.state === 'failed'
    ? { tone: 'error' as const, title: 'Connection Failed', text: launch.message, action: <Button size="sm" className="shrink-0" onClick={() => setLaunch(null)}>Dismiss</Button> }
    : launch.state === 'waiting'
      ? { tone: 'busy' as const, title: 'Getting Ready', text: 'Your connection will open in about a minute.', action: <Button size="sm" className="shrink-0" onClick={cancelLaunch}>Cancel</Button> }
      : { tone: 'busy' as const, title: 'Connecting', text: 'This takes a few seconds.', action: null });
  const launchBanner = launchAlert && (
    <div role={launchAlert.tone === 'error' ? 'alert' : 'status'} className={cn('mb-4 flex items-center gap-3 rounded-xl border px-4 py-3',
      launchAlert.tone === 'error' ? 'border-red-500/40 bg-red-500/5' : 'border-netbird/40 bg-netbird/5')}>
      {launchAlert.tone === 'error'
        ? <XCircle size={20} className="shrink-0 text-red-500" />
        : <Loader2 size={20} className="shrink-0 animate-spin text-netbird" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50">{launchAlert.title}</p>
        <p className="mt-0.5 text-[0.8rem] leading-snug text-nb-gray-600 dark:text-nb-gray-400">{launchAlert.text}</p>
      </div>
      {launchAlert.action}
    </div>
  );

  if (info.isLoading) return <div className="flex w-full max-w-[460px] flex-col">{launchBanner}<LoadingState /></div>;
  const ra = info.data;
  if (!ra || !ra.available || !ra.allowed) {
    const why = !ra ? 'Remote access information could not be loaded.'
      : ra.ssoRequired ? 'Browser remote access needs SSO sign-in, which is not configured.'
        : !ra.available ? 'Browser remote access is turned off.'
          : "You don't have permission to use browser remote access. Ask an administrator.";
    return (
      <div className="flex w-full max-w-[460px] flex-col">
        {launchBanner}
        <FlowCard>
          <Hero protocol="rdp" description={why} />
        </FlowCard>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-[460px] flex-col">
      {launchBanner}

      {sessions.count > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-netbird/40 bg-netbird/5 px-4 py-3">
          <MonitorPlay size={18} className="text-netbird shrink-0" />
          <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
            {sessions.count} session{sessions.count === 1 ? ' is' : 's are'} open. A new connection opens next to {sessions.count === 1 ? 'it' : 'them'}.
          </span>
          <Button size="sm" className="ml-auto" onClick={sessions.show}>Return To Sessions</Button>
        </div>
      )}

      <FlowCard>
        {/* The big heading steps aside while a connection is checked, so the steps fit on screen. */}
        {phase === 'form' && (!launch || launch.state === 'failed')
          ? <Hero protocol={protocol} description="Open an RDP or SSH session to any server your NetBird access allows." />
          : <h1 className="sr-only">Remote Access</h1>}

        <form ref={formRef} onSubmit={start} className="flex flex-col">
          {/* Two choices: visible radio buttons, styled as one switch. The radios stay real inputs
              (visually hidden, still in the accessibility tree) so the arrow keys move between them. */}
          <fieldset disabled={locked} className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-nb-gray-100 p-1 dark:bg-nb-gray-920">
            <legend className="sr-only">Protocol</legend>
            {(['rdp', 'ssh'] as const).map((p) => {
              const Icon = p === 'rdp' ? MonitorPlay : Terminal;
              const on = protocol === p;
              return (
                <label key={p} className={cn(
                  'flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors',
                  // The chosen one is styled from state: the dark-mode gray text remap (index.css,
                  // !important) would otherwise beat its colors, the forced ones included.
                  // The chosen one also gets an edge with at least 3:1 contrast, not only a lighter fill.
                  on
                    ? 'bg-white text-nb-gray-900 shadow-sm ring-1 ring-nb-gray-400 dark:bg-nb-gray-800 dark:text-white dark:ring-nb-gray-500'
                    : 'text-nb-gray-600 hover:text-nb-gray-800 dark:text-nb-gray-400',
                  // Forced colors (Windows High Contrast) drop the backgrounds: mark the choice with system colors.
                  on && 'forced-colors:forced-color-adjust-none forced-colors:bg-[Highlight]! forced-colors:text-[HighlightText]!',
                  // An outline (not a shadow ring) so focus stays visible in forced colors too.
                  'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-netbird-700 dark:has-focus-visible:outline-netbird-400 forced-colors:has-focus-visible:outline-[CanvasText]!',
                  'has-disabled:cursor-not-allowed has-disabled:opacity-60',
                )}>
                  <input type="radio" name="protocol" value={p} className="sr-only"
                    checked={on} onChange={() => setProtocol(p)} />
                  <Icon size={16} className={on ? 'text-netbird-600 dark:text-netbird forced-colors:text-current!' : undefined} />
                  {p.toUpperCase()}
                </label>
              );
            })}
          </fieldset>

          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
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
                className={FLOW_INPUT}
                required disabled={locked}
              />
            </Field>
            <Field label="Port">
              <Input ref={portRef} value={port} onChange={(e) => { setPort(e.target.value.replace(/[^0-9]/g, '')); setPortTouched(true); }}
                inputMode="numeric" className={cn(FLOW_INPUT, 'aria-invalid:border-red-500! aria-invalid:ring-red-500/30')} required disabled={locked}
                aria-invalid={(port !== '' && !validPort(portNum)) || undefined} title="A port from 1 to 65535" />
            </Field>
          </div>

          {/* While a connection is checked, the next step has its own buttons below. */}
          {phase === 'form' && <>
            <Button type="submit" variant="primary" className="mt-5 h-12! w-full rounded-lg! text-base font-semibold"
              disabled={locked || !address.trim() || !validPort(portNum)}>
              {protocol === 'rdp' ? <MonitorPlay size={18} /> : <Terminal size={18} />} Connect
            </Button>
            <p className="mt-3 text-center text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">
              Sessions close after {ra.idleTimeoutMin} idle minutes and after {ra.maxDurationHours} hours.
            </p>
          </>}
        </form>

        {phase !== 'form' && (
          <div className="mt-5 border-t border-nb-gray-100 dark:border-nb-gray-900 pt-5">
            {phase === 'ssh-creds' && caughtUp ? <StepSummary steps={shown} /> : <>
              {/* The big heading is away while the steps run: say what is happening. */}
              {failure && caughtUp
                ? <FlowHeader icon={<XIcon size={20} />} tone="danger" title="Couldn't Connect" subtitle={`${targetRef.current.address}:${targetRef.current.port}`} />
                : <FlowHeader icon={protocol === 'rdp' ? <MonitorPlay size={19} /> : <Terminal size={19} />} title="Connecting" subtitle={`${targetRef.current.address}:${targetRef.current.port}`} />}
              <StepList steps={shown} />
            </>}
            {failure && caughtUp && <FailureBox failure={failure} onRetry={() => formRef.current?.requestSubmit()} />}
            {waiting && !failure && <Button variant="ghost" className={cn(FLOW_QUIET, 'mt-4')} onClick={reset}>Cancel</Button>}
          </div>
        )}

        {phase === 'ssh-creds' && caughtUp && (
          <form
            className="mt-5 flex flex-col gap-3 border-t border-nb-gray-100 dark:border-nb-gray-900 pt-5"
            onSubmit={(e) => { e.preventDefault(); void openSession({ username: sshUser.trim(), password: sshPass, privateKey: sshKey, passphrase: sshPassphrase }); }}
          >
            <div>
              <FlowHeader icon={<Lock size={19} />} title="Sign In To The Server" />
              <p className="-mt-1 text-[0.82rem] text-nb-gray-500 dark:text-nb-gray-400">Your password or key goes to the server only and is never stored.</p>
            </div>
            <Field label="User Name"><Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} autoComplete="username" className={FLOW_INPUT} autoFocus required /></Field>
            <Field label="Password" hint="Leave empty to use a private key, or to type the password in the terminal.">
              <PasswordInput value={sshPass} onChange={(e) => setSshPass(e.target.value)} autoComplete="current-password" className={FLOW_INPUT} />
            </Field>
            <Field label="Private Key (Optional)"><Textarea value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={3} className="rounded-lg!" /></Field>
            {sshKey.trim() && <Field label="Key Passphrase (Optional)"><PasswordInput value={sshPassphrase} onChange={(e) => setSshPassphrase(e.target.value)} className={FLOW_INPUT} /></Field>}
            <div className="mt-1 flex flex-col gap-1">
              <Button type="submit" variant="primary" className={FLOW_BUTTON}><Terminal size={17} /> Connect</Button>
              <Button variant="ghost" className={FLOW_QUIET} onClick={reset}>Cancel</Button>
            </div>
          </form>
        )}
      </FlowCard>
    </div>
  );
}

function Hero({ protocol, description }: { protocol: RemoteProtocol; description: ReactNode }) {
  const Icon = protocol === 'rdp' ? MonitorPlay : Terminal;
  return (
    <div className="mb-6 flex flex-col items-center text-center last:mb-0">
      <FlowTile icon={<Icon size={28} />} large />
      <h1 className="mt-4 text-[1.75rem] font-bold tracking-tight text-nb-gray-900 dark:text-nb-gray-50">Remote Access</h1>
      <p className="mt-2 max-w-sm text-[0.92rem] leading-relaxed text-nb-gray-500 dark:text-nb-gray-400">{description}</p>
    </div>
  );
}
