import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { GUAC, PORTAL_MESSAGE_CODES, type GuacStatus } from '@/lib/remoteAccess';
import { Button } from '@/components/ui';
import { FLOW_BUTTON } from './flow';

// The connection steps a user sees, shared by the Remote Access page (the checks before a session,
// and opening the route: the server joins its gateway's targets and the route reaches the gateway)
// and the session tabs (opening the channel, reaching the server, signing in). RDP and SSH show the
// same steps.

export type StepKey = 'ready' | 'access' | 'path' | 'route' | 'channel' | 'server' | 'signin';
export type StepState = 'pending' | 'running' | 'pass' | 'fail';
export interface Step { key: StepKey; label: string; state: StepState; detail?: string }
/** requestLink: where "Request Access" leads (with the denied resource chosen); no button without it. */
export interface Failure { message: string; requestLink?: string; troubleshoot?: boolean }

export const STEP_LABELS: Record<StepKey, string> = {
  ready: 'Checking Environment',
  access: 'Checking Permissions',
  path: 'Checking The Path',
  route: 'Opening The Route To The Server',
  channel: 'Opening A Secure Channel',
  server: 'Connecting To The Server',
  signin: 'Signing In',
};
export const ARG_LABELS: Record<string, string> = { username: 'User Name', password: 'Password', domain: 'Domain' };

// Short names for the one-line summary shown once the checks are behind the user.
const STEP_SHORT: Record<StepKey, string> = {
  ready: 'Environment',
  access: 'Permissions',
  path: 'Path',
  route: 'Route',
  channel: 'Secure Channel',
  server: 'Server',
  signin: 'Sign In',
};

export const freshSteps = (): Step[] => (['ready', 'access', 'path', 'route', 'channel', 'server'] as StepKey[]).map((key) => ({ key, label: STEP_LABELS[key], state: 'pending' }));

/** The steps a new session tab starts with: the checks and the route are behind it. */
export const handoffSteps = (c: { access?: string; path?: string } = {}): Step[] =>
  withStep(withStep(withStep(withStep(withStep(freshSteps(), 'ready', 'pass'), 'access', 'pass', c.access), 'path', 'pass', c.path), 'route', 'pass'), 'channel', 'running');

// Each running step stays on screen for at least this long, so the user can follow the checks.
// The first connection in a browser tab moves slower; later ones move quicker.
const PACE_FIRST_MS = 850;
const PACE_MS = 450;
export const PACE_KEY = 'nbc.remoteAccess.pacedOnce';

export function pickDwell(): number {
  if (typeof window === 'undefined') return 0;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
  try { return sessionStorage.getItem(PACE_KEY) ? PACE_MS : PACE_FIRST_MS; } catch { return PACE_MS; }
}

const sameStep = (a: Step, b: Step) => a.key === b.key && a.state === b.state && a.detail === b.detail;
const RANK: Record<StepState, number> = { pending: 0, running: 1, pass: 2, fail: 2 };

// Display-only pacing: the real checks run at full speed, and the list on screen follows them one
// change at a time, holding each running step for `dwellMs`. `caughtUp` tells the caller that the
// screen shows the real state, so a result (a failure, a sign-in form) never appears before its step.
export function usePacedSteps(target: Step[], dwellMs: number): { shown: Step[]; caughtUp: boolean } {
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

// Set one step's state, adding the step if the list does not have it yet.
export function withStep(prev: Step[], key: StepKey, state: StepState, detail?: string): Step[] {
  const has = prev.some((s) => s.key === key);
  const list = has ? prev : [...prev, { key, label: STEP_LABELS[key], state: 'pending' as StepState }];
  return list.map((s) => (s.key === key ? { ...s, state, detail } : s));
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'running') return <Loader2 size={17} className="shrink-0 text-netbird animate-spin" />;
  if (state === 'pass') return <CheckCircle2 size={17} className="shrink-0 text-green-500" />;
  if (state === 'fail') return <XCircle size={17} className="shrink-0 text-red-500" />;
  return <Circle size={17} className="shrink-0 text-nb-gray-300 dark:text-nb-gray-700" />;
}

export function StepList({ steps }: { steps: Step[] }) {
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
export function StepSummary({ steps }: { steps: Step[] }) {
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

// The reason is already on the failed step; this holds what the user can do next, one full-width
// button each. The first one is the main action.
export function FailureBox({ failure, onRetry, retryLabel = 'Try Again', onLeave }: {
  failure: Failure; onRetry: () => void; retryLabel?: string;
  /** Called before following a link out of the session view. */
  onLeave?: () => void;
}) {
  const main = failure.requestLink ? 'request' : failure.troubleshoot ? 'troubleshoot' : 'retry';
  const variant = (k: typeof main) => (k === main ? 'primary' : 'secondary');
  return (
    <div className="mt-5 flex flex-col gap-2">
      {failure.requestLink && <Link to={failure.requestLink} onClick={onLeave} className="block"><Button variant={variant('request')} className={FLOW_BUTTON}>Request Access</Button></Link>}
      {failure.troubleshoot && <Link to="/troubleshoot" onClick={onLeave} className="block"><Button variant={variant('troubleshoot')} className={FLOW_BUTTON}>Open Troubleshoot</Button></Link>}
      <Button variant={variant('retry')} className={FLOW_BUTTON} onClick={onRetry}>{retryLabel}</Button>
    </div>
  );
}

// Translate a Guacamole status into the step it belongs to and a human sentence.
export function explain(status: GuacStatus, stage: 'server' | 'signin'): { step: StepKey; message: string } {
  if (PORTAL_MESSAGE_CODES.has(status.code) && status.message) return { step: stage, message: status.message };
  switch (status.code) {
    case GUAC.CLIENT_UNAUTHORIZED:
    case GUAC.CLIENT_FORBIDDEN:
      return { step: 'signin', message: 'Sign-in failed. Check the user name and password, then connect again.' };
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
