import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Loader2, MonitorPlay, Terminal, XCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { requestAccessLink } from '@/lib/requestAccess';
import { remoteApi, cleanAddressInput, type RemoteProtocol, type RemoteSession } from '@/lib/remoteAccess';
import { Button, Field, Input, LoadingState, PageHeader, PasswordInput, Select, Textarea } from '@/components/ui';
import { sessionScreenSize, useRemoteSessions } from '@/components/remote/RemoteSessions';
import {
  FailureBox, PACE_KEY, StepList, StepSummary, freshSteps, pickDwell, usePacedSteps, withStep,
  type Failure, type Step, type StepKey, type StepState,
} from '@/components/remote/steps';

const DEFAULT_PORT: Record<RemoteProtocol, number> = { rdp: 3389, ssh: 22 };

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
  const info = useQuery({ queryKey: ['remote-access-info'], queryFn: remoteApi.info });
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
  // credentials the server already holds. The ticket stays in the address until the server has
  // answered, so a sign-in that expired in between returns here and the link still opens.
  const [params, setParams] = useSearchParams();
  const launchTicket = params.get('launch') || '';
  const launched = useRef('');
  const [launch, setLaunch] = useState<{ state: 'opening' } | { state: 'failed'; message: string } | null>(null);
  const ready = !!info.data?.available && !!info.data?.allowed;
  useEffect(() => {
    if (!launchTicket || !ready || launched.current === launchTicket) return;
    launched.current = launchTicket;
    setLaunch({ state: 'opening' });
    const done = () => setParams((p) => { const n = new URLSearchParams(p); n.delete('launch'); return n; }, { replace: true });
    remoteApi.redeemLaunch({
      ticket: launchTicket, ...sessionScreenSize(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).then((s) => {
      done();
      setLaunch(null);
      sessions.add({
        sessionId: s.sessionId, token: s.token, protocol: s.protocol,
        title: sessionTitle(s, s.port) || `${s.address}:${s.port}`,
        clipboard: !!info.data?.clipboard,
        steps: withStep(withStep(withStep(freshSteps(), 'access', 'pass'), 'path', 'pass'), 'channel', 'running'),
        dwell: pickDwell(), target: { address: s.address || '', port: s.port }, serverCredentials: true,
      });
    }).catch((err) => {
      // 401: the sign-in ended and the browser is on its way to sign in again (and back here).
      if (err instanceof ApiError && err.status === 401) return;
      done();
      setLaunch({ state: 'failed', message: err instanceof ApiError ? err.message : "The connection couldn't be opened. Open it again from the system that sent you here." });
    });
  }, [launchTicket, ready, info.data?.clipboard, sessions, setParams]);

  const setStep = useCallback((key: StepKey, state: StepState, detail?: string) => setSteps((p) => withStep(p, key, state, detail)), []);

  const reset = () => {
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
      fail('access', { message: err instanceof ApiError ? err.message : 'Your access could not be checked. Try again.' });
    }
  };

  const openSession = async (creds?: Record<string, string>) => {
    setPhase('opening');
    setStep('channel', 'running');
    const c = checked.current;
    const handoff = withStep(withStep(withStep(freshSteps(), 'access', 'pass', c.access), 'path', 'pass', c.path), 'channel', 'running');
    try {
      const s = await remoteApi.createSession({
        protocol, address: targetRef.current.address, port: targetRef.current.port,
        // The session view uses the whole window, below the bar when it is pinned.
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
      fail('channel', { message: err instanceof ApiError ? err.message : 'The session could not be opened. Try again.' });
      setPhase('checking');
    }
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

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Remote Access"
        description={<>Connect to a server from the browser with RDP or SSH. You can reach the same servers your NetBird access already allows - nothing more.</>}
      />

      {launch && (
        <div role="status" className={launch.state === 'failed'
          ? 'mb-4 flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3'
          : 'mb-4 flex items-center gap-3 rounded-xl border border-netbird/40 bg-netbird/5 px-4 py-3'}>
          {launch.state === 'opening'
            ? <><Loader2 size={18} className="text-netbird shrink-0 animate-spin" /><span className="text-sm text-nb-gray-700 dark:text-nb-gray-200">Opening the connection you were sent here for…</span></>
            : <>
              <XCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
              <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200">{launch.message}</span>
              <Button size="sm" className="ml-auto shrink-0" onClick={() => setLaunch(null)}>Dismiss</Button>
            </>}
        </div>
      )}

      {sessions.count > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-netbird/40 bg-netbird/5 px-4 py-3">
          <MonitorPlay size={18} className="text-netbird shrink-0" />
          <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
            {sessions.count} session{sessions.count === 1 ? ' is' : 's are'} open. A new connection opens next to {sessions.count === 1 ? 'it' : 'them'}.
          </span>
          <Button size="sm" className="ml-auto" onClick={sessions.show}>Return To Sessions</Button>
        </div>
      )}

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
            {phase === 'ssh-creds' && caughtUp ? <StepSummary steps={shown} /> : <StepList steps={shown} />}
            {failure && caughtUp && <FailureBox failure={failure} onRetry={reset} />}
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
              <PasswordInput value={sshPass} onChange={(e) => setSshPass(e.target.value)} autoComplete="current-password" />
            </Field>
            <Field label="Private Key (Optional)"><Textarea value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={3} /></Field>
            {sshKey.trim() && <Field label="Key Passphrase (Optional)"><PasswordInput value={sshPassphrase} onChange={(e) => setSshPassphrase(e.target.value)} /></Field>}
            <div className="flex gap-2">
              <Button type="submit" variant="primary">Connect</Button>
              <Button onClick={reset}>Cancel</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
