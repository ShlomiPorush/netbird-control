import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { GUAC, PORTAL_MESSAGE_CODES, type GuacStatus } from '@/lib/remoteAccess';
import { Button } from '@/components/ui';

// The connection steps a user sees, shared by the Remote Access page (the checks before a session)
// and the session tabs (opening the channel, reaching the server, signing in).

export type StepKey = 'access' | 'path' | 'channel' | 'server' | 'signin';
export type StepState = 'pending' | 'running' | 'pass' | 'fail';
export interface Step { key: StepKey; label: string; state: StepState; detail?: string }
export interface Failure { message: string; requestable?: boolean; troubleshoot?: boolean }

export const STEP_LABELS: Record<StepKey, string> = {
  access: 'Checking Permissions',
  path: 'Checking The Path',
  channel: 'Opening A Secure Channel',
  server: 'Connecting To The Server',
  signin: 'Signing In',
};
export const ARG_LABELS: Record<string, string> = { username: 'User Name', password: 'Password', domain: 'Domain' };

// Short names for the one-line summary shown once the checks are behind the user.
const STEP_SHORT: Record<StepKey, string> = {
  access: 'Permissions',
  path: 'Path',
  channel: 'Secure Channel',
  server: 'Server',
  signin: 'Sign In',
};

export const freshSteps = (): Step[] => (['access', 'path', 'channel', 'server'] as StepKey[]).map((key) => ({ key, label: STEP_LABELS[key], state: 'pending' }));

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

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-full max-w-md rounded-xl border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-5 shadow-xl', className)}>{children}</div>;
}

// The reason is already on the failed step; this box holds what the user can do next.
export function FailureBox({ failure, onRetry, retryLabel = 'Try Again', onLeave }: {
  failure: Failure; onRetry: () => void; retryLabel?: string;
  /** Called before following a link out of the session view. */
  onLeave?: () => void;
}) {
  return (
    <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
      <div className="flex flex-wrap gap-2">
        {failure.requestable && <Link to="/request-access" onClick={onLeave}><Button size="sm" variant="primary">Request Access</Button></Link>}
        {failure.troubleshoot && <Link to="/troubleshoot" onClick={onLeave}><Button size="sm">Open Troubleshoot</Button></Link>}
        <Button size="sm" onClick={onRetry}>{retryLabel}</Button>
      </div>
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
