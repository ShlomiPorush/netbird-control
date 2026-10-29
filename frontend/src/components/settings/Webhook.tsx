import { useMemo, useState, type ReactNode } from 'react';
import { Eye, EyeOff, Copy, Check, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWebhookConfig, useNetbirdWebhookStatus, useTrafficPull, useAuditPull } from '@/lib/queries';
import { useSaveWebhook, useAutoConfigureNbNotifications, useAutoConfigureNbEvents, useSetTrafficPull, useSetAuditPull } from '@/lib/mutations';
import type { AutoConfigureNbResult, NetbirdFeatureStatus } from '@/lib/types';
import { useConfirm } from '@/contexts/ConfirmContext';
import { formatTimestamp } from '@/lib/logfmt';
import { Button, LoadingState, Input, Field } from '@/components/ui';

// One pill shape, four palettes - kept on ONE line (shrink-0 + whitespace-nowrap) so a narrow card
// never wraps it like the old badge did.
function Pill({ tone, dot, children, title }: {
  tone: 'green' | 'amber' | 'gray'; dot: 'pulse' | 'solid' | 'muted'; children: ReactNode; title?: string;
}) {
  const tones = {
    green: 'bg-green-500/10 text-green-600 dark:text-green-400',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    gray: 'bg-nb-gray-200/60 dark:bg-nb-gray-800/60 text-nb-gray-500',
  }[tone];
  const dotCls = { pulse: 'bg-green-500 animate-pulse', solid: 'bg-amber-500', muted: 'bg-nb-gray-400 dark:bg-nb-gray-600' }[dot];
  return (
    <span title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[0.72rem] font-medium ${tones}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotCls}`} /> {children}
    </span>
  );
}

// Header status pill for an ingestion card. The HONEST on/off signal is NetBird's own integration
// state (`status`), NOT whether rows arrived - traffic events can also come via the API pull, so data
// presence alone is no proof the streaming integration exists. `lastAt` is only a freshness note in
// the tooltip. States: loading → "Checking…"; null (couldn't read NetBird) → "Unknown"; configured &
// enabled → green "Active"; configured but disabled → amber "Disabled In NetBird"; else "Not Configured".
function IngestStatus({ status, loading, lastAt }: { status: NetbirdFeatureStatus | undefined; loading: boolean; lastAt: string | null }) {
  const lastNote = lastAt ? ` Last data received ${formatTimestamp(lastAt)}.` : '';
  if (loading || status === undefined) return <Pill tone="gray" dot="muted">Checking…</Pill>;
  if (status === null) return <Pill tone="gray" dot="muted" title="Could not read the integration status from NetBird.">Unknown</Pill>;
  if (status.configured && status.enabled) {
    return <Pill tone="green" dot="pulse" title={`Configured and enabled in NetBird.${lastNote}`}>Active</Pill>;
  }
  if (status.configured && !status.enabled) {
    return <Pill tone="amber" dot="solid" title={`The integration exists in NetBird but is disabled.${lastNote}`}>Disabled In NetBird</Pill>;
  }
  return <Pill tone="gray" dot="muted" title="No matching integration is set up in NetBird.">Not Configured</Pill>;
}

// One self-contained token editor (input + generate + save/disable + status dot).
// Used twice - the events token and the notifications token are deliberately
// independent secrets, so each section manages its own.
function TokenSection({ label, hint, locked, lockedHint, hasToken, authEnabled, onSave, onClear, saving }: {
  label: string;
  hint: string;
  locked?: boolean;
  lockedHint?: string;
  hasToken: boolean;
  authEnabled: boolean;
  onSave: (token: string) => Promise<void>;
  onClear: () => Promise<void>;
  saving: boolean;
}) {
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const copyToken = async () => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ }
  };
  const genToken = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    setToken(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
    setShow(true); // reveal so it can be copied - it's write-only once saved
  };
  const save = async () => {
    setError('');
    try {
      await onSave(token.trim());
      setToken(''); setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed to save'); }
  };
  const clear = async () => {
    setError('');
    try {
      await onClear();
      setToken(''); setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed'); }
  };

  return (
    <>
      <Field
        label={label}
        hint={locked
          ? (lockedHint || '')
          : hasToken
            ? 'A token is configured. Leave blank to keep it, enter a new one to replace it, or disable auth below.'
            : hint}
      >
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              type={show && !locked ? 'text' : 'password'}
              autoComplete="new-password"
              value={locked ? '' : token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={locked ? '•••• from environment' : hasToken ? '•••• configured' : 'set a token…'}
              disabled={locked}
              className={cn('font-mono text-[0.82rem]', token && !locked && 'pr-16', locked && 'opacity-60 cursor-not-allowed')}
            />
            {token && !locked && (
              <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-2 text-nb-gray-400">
                <button type="button" onClick={() => setShow((s) => !s)} title={show ? 'Hide' : 'Show'} className="hover:text-nb-gray-700 dark:hover:text-nb-gray-100">
                  {show ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button type="button" onClick={copyToken} title="Copy token" className="hover:text-netbird">
                  {copied ? <Check size={15} className="text-green-500" /> : <Copy size={15} />}
                </button>
              </div>
            )}
          </div>
          {!locked && <Button variant="secondary" onClick={genToken}>Generate</Button>}
        </div>
        {token && !locked && (
          <p className="mt-1.5 text-[0.78rem] text-amber-600 dark:text-amber-500">
            Copy this token now and paste it into NetBird - it won’t be shown again after you save.
          </p>
        )}
      </Field>

      <div className="flex items-center gap-3 flex-wrap">
        {!locked && (
          <Button variant="primary" onClick={save} disabled={saving || !token.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
        {!locked && hasToken && (
          <Button variant="secondary" onClick={clear} disabled={saving}>Disable auth</Button>
        )}
        {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
        {error && <span className="text-sm text-red-500">{error}</span>}
        <span className="inline-flex items-center gap-1.5 text-sm text-nb-gray-500">
          <span className={cn('h-2 w-2 rounded-full', authEnabled ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
          {authEnabled ? 'Authentication enabled' : 'Open - no authentication'}
        </span>
      </div>
    </>
  );
}

// One-click NetBird setup card, shared by the Activity Events (Event Streaming) and the Account
// Notifications sections: handles the ingest token and creates-or-updates the matching NetBird
// integration in the CURRENT account (works for admins in both main and tenant context). The manual
// URL + token below each card stay as a fallback. `blurb`/`confirmMessage`/`successNoun` are the only
// per-channel differences; `mutation` is the channel's own auto-configure hook.
function AutoConfigureCard({ mutation, confirmMessage, blurb, successNoun }: {
  mutation: { mutateAsync: () => Promise<AutoConfigureNbResult>; isPending: boolean };
  confirmMessage: string;
  blurb: string;
  successNoun: string;
}) {
  const confirm = useConfirm();
  const [result, setResult] = useState<{ created: boolean; url: string } | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    const ok = await confirm({
      title: 'Configure In NetBird?',
      message: confirmMessage,
      confirmText: 'Configure',
      danger: false,
    });
    if (!ok) return;
    setError(''); setResult(null);
    try {
      const out = await mutation.mutateAsync();
      setResult({ created: out.created, url: out.url });
    } catch (e) { setError((e as Error).message || 'Failed to configure NetBird'); }
  };

  return (
    <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800/70 bg-nb-gray-50 dark:bg-nb-gray-900/40 p-3.5 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0">
          <div className="text-[0.85rem] font-medium text-nb-gray-800 dark:text-nb-gray-100">Set It Up Automatically</div>
          <p className="text-[0.78rem] text-nb-gray-500 mt-0.5">{blurb}</p>
        </div>
        <Button variant="primary" onClick={run} disabled={mutation.isPending} className="shrink-0">
          <Zap size={15} /> {mutation.isPending ? 'Configuring…' : 'Configure In NetBird Automatically'}
        </Button>
      </div>
      {result && (
        <div className="flex items-start gap-2.5 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2.5">
          <Check size={17} className="text-green-500 shrink-0 mt-0.5" />
          <div className="min-w-0 text-[0.8rem] text-nb-gray-700 dark:text-nb-gray-200">
            <div className="font-medium text-nb-gray-800 dark:text-nb-gray-100">
              {successNoun} {result.created ? 'created' : 'updated'} in NetBird.
            </div>
            <div className="mt-0.5 text-nb-gray-500 break-all font-mono text-[0.76rem]">{result.url}</div>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}

// Third ingestion route: POLL NetBird's Traffic Events API instead of receiving a stream.
// Event streaming needs the Business plan; this endpoint is often readable below it, so an
// account without streaming can still build local history. Off by default - see the help text.
function TrafficPullCard({ className }: { className: string }) {
  const { data, isLoading } = useTrafficPull();
  const setPull = useSetTrafficPull();
  const confirm = useConfirm();

  const toggle = async (enabled: boolean) => {
    try { await setPull.mutateAsync(enabled); }
    catch (err) { await confirm({ title: 'Failed To Save', message: (err as Error).message, confirmText: 'OK' }); }
  };

  return (
    <div className={className}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Traffic Events API Pull</div>
          <p className="text-[0.82rem] text-nb-gray-500 mt-0.5">
            A fallback for accounts whose plan has no event streaming - the app reads the traffic events straight
            from the NetBird API on a schedule.
          </p>
        </div>
        {data && (data.enabled ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 px-2.5 py-1 text-[0.72rem] font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" /> On
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-nb-gray-200/60 dark:bg-nb-gray-800/60 text-nb-gray-500 px-2.5 py-1 text-[0.72rem] font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-nb-gray-400 dark:bg-nb-gray-600" /> Off
          </span>
        ))}
      </div>

      {isLoading || !data ? <LoadingState /> : (
        <>
          <label className="flex items-start gap-3 p-3.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/30 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 mt-0.5 accent-netbird"
              checked={!!data.enabled}
              disabled={setPull.isPending}
              onChange={(e) => toggle(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-nb-gray-800 dark:text-nb-gray-100">Pull Traffic Events From The API</span>
              <span className="block text-nb-gray-500 text-[0.8rem] mt-0.5">
                For accounts without event streaming - polls NetBird every 5 minutes and stores the events locally.
                NetBird keeps only the recent ~48 hours, so history accumulates from the moment this is enabled.
                Keep this OFF if the streaming webhook above is configured, to avoid duplicate ingestion paths.
              </span>
            </span>
          </label>

          {data.unsupported ? (
            <p className="text-[0.8rem] text-amber-600 dark:text-amber-500">
              NetBird reported that the traffic events API is not available on this account&apos;s plan. The app stops
              asking for an hour, then retries - no events are pulled meanwhile.
            </p>
          ) : (
            <p className="text-[0.8rem] text-nb-gray-500">
              {!data.enabled
                ? 'Disabled - no polling takes place.'
                : !data.lastRunAt
                  ? 'Enabled - waiting for the first pull.'
                  : `Last pull ${formatTimestamp(data.lastRunAt)} - ${data.lastCount.toLocaleString()} ${data.lastCount === 1 ? 'event' : 'events'} ingested.`}
              {data.lastError && <span className="text-red-500"> Last error: {data.lastError}</span>}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// Fourth ingestion route: POLL NetBird's Audit Events API instead of receiving a stream - the
// admin/audit sibling of TrafficPullCard. Event streaming needs the Business plan; this endpoint
// is often readable below it, so an account without streaming can still build local admin history.
// Off by default - see the help text.
function AuditPullCard({ className }: { className: string }) {
  const { data, isLoading } = useAuditPull();
  const setPull = useSetAuditPull();
  const confirm = useConfirm();

  const toggle = async (enabled: boolean) => {
    try { await setPull.mutateAsync(enabled); }
    catch (err) { await confirm({ title: 'Failed To Save', message: (err as Error).message, confirmText: 'OK' }); }
  };

  return (
    <div className={className}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Audit Events API Pull</div>
          <p className="text-[0.82rem] text-nb-gray-500 mt-0.5">
            A fallback for accounts whose plan has no event streaming - the app reads NetBird&apos;s audit/admin
            events straight from the API on a schedule.
          </p>
        </div>
        {data && (data.enabled ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 px-2.5 py-1 text-[0.72rem] font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" /> On
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-nb-gray-200/60 dark:bg-nb-gray-800/60 text-nb-gray-500 px-2.5 py-1 text-[0.72rem] font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-nb-gray-400 dark:bg-nb-gray-600" /> Off
          </span>
        ))}
      </div>

      {isLoading || !data ? <LoadingState /> : (
        <>
          <label className="flex items-start gap-3 p-3.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/30 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 mt-0.5 accent-netbird"
              checked={!!data.enabled}
              disabled={setPull.isPending}
              onChange={(e) => toggle(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-nb-gray-800 dark:text-nb-gray-100">Pull Audit Events From The API</span>
              <span className="block text-nb-gray-500 text-[0.8rem] mt-0.5">
                For accounts without event streaming - polls NetBird every 5 minutes and stores audit events locally.
                The first run backfills silently (no Telegram spam); new events after that notify normally. Keep this
                OFF if the Account Notifications / streaming webhook above already delivers these events, to avoid
                duplicate ingestion.
              </span>
            </span>
          </label>

          {data.unsupported ? (
            <p className="text-[0.8rem] text-amber-600 dark:text-amber-500">
              NetBird reported that the audit events API is not available on this account&apos;s plan. The app stops
              asking for an hour, then retries - no events are pulled meanwhile.
            </p>
          ) : (
            <p className="text-[0.8rem] text-nb-gray-500">
              {!data.enabled
                ? 'Disabled - no polling takes place.'
                : !data.lastRunAt
                  ? 'Enabled - waiting for the first pull.'
                  : `Last pull ${formatTimestamp(data.lastRunAt)} - ${data.lastCount.toLocaleString()} ${data.lastCount === 1 ? 'event' : 'events'} ingested.`}
              {data.lastError && <span className="text-red-500"> Last error: {data.lastError}</span>}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function Webhook() {
  const { data, isLoading } = useWebhookConfig();
  // Live NetBird integration state - the authoritative on/off signal for the header badges.
  const { data: nbStatus, isLoading: nbStatusLoading } = useNetbirdWebhookStatus();
  const save = useSaveWebhook();
  const autoEvents = useAutoConfigureNbEvents();
  const autoNotif = useAutoConfigureNbNotifications();

  // BASE_URL-derived endpoint; fall back to this origin when the server returns a relative path.
  const endpoint = useMemo(() => {
    const e = data?.endpoint || '/api/webhook';
    return e.startsWith('/') ? window.location.origin + e : e;
  }, [data?.endpoint]);
  // The account-notifications receiver lives on the same base URL but has its OWN token. Both
  // endpoints carry the same account id in the path (e.g. /t/<tenant> while managing a tenant),
  // so swap just the /api/webhook segment - the /t/<id> suffix (if any) is preserved.
  const notifEndpoint = useMemo(() => endpoint.replace('/api/webhook', '/api/integrations/netbird-notifications'), [endpoint]);

  // Tenant vs main context, read from the endpoint path (a tenant's URL carries /api/webhook/t/<id>).
  // The events ingest token always regenerates for a tenant; in main mode it regenerates UNLESS it is
  // env-managed - so the env caveat is mentioned only in main mode.
  const isTenant = /\/api\/webhook\/t\//.test(endpoint);
  const eventsConfirm = 'This creates or updates the Generic HTTP event-streaming integration in the current NetBird account, pointed at this app’s activity events endpoint. '
    + (isTenant
      ? 'The events ingest token is regenerated.'
      : 'The events ingest token is regenerated, unless it is managed by the WEBHOOK_AUTH_TOKEN environment variable (in which case the existing token is reused).');
  const notifConfirm = 'This (re)generates the notifications ingest token and creates or updates the Account Notifications webhook channel in the current NetBird account, subscribed to all event types and pointed at this app. An existing channel is updated in place.';

  const CARD = 'rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4 flex flex-col gap-4';

  return (
    <div className="max-w-2xl">
      <p className="text-nb-gray-500 text-sm mb-5">
        Two separate receivers, each with its own optional Bearer token - the channels are unrelated, so a token
        for one never grants access to the other. Tokens are stored on the server and never shown again. Each
        account has its own endpoint URLs and tokens: while managing a tenant, its links carry the tenant id in
        the path, so that tenant's NetBird posts straight into the tenant's own data. The third card is the
        opposite direction - the app polling NetBird - for accounts whose plan has no event streaming at all.
      </p>
      {isLoading || !data ? <LoadingState /> : (
        <div className="flex flex-col gap-4">
          <div className={CARD}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Activity Events</div>
                <p className="text-[0.82rem] text-nb-gray-500 mt-0.5">
                  Traffic + admin activity. Point NetBird → Settings → Event Streaming (Generic HTTP) here.
                </p>
              </div>
              <IngestStatus status={nbStatus?.eventStreaming} loading={nbStatusLoading} lastAt={data.eventsLastAt} />
            </div>
            <AutoConfigureCard
              mutation={autoEvents}
              confirmMessage={eventsConfirm}
              blurb="Let this app create or update the Generic HTTP event-streaming integration in NetBird for you - no manual copying."
              successNoun="Event streaming integration"
            />
            <p className="text-[0.78rem] text-nb-gray-500 -mb-1">
              Or configure NetBird manually with the endpoint and token below:
            </p>
            <Field label="Endpoint URL">
              <Input value={endpoint} readOnly onFocus={(e) => e.currentTarget.select()} className="font-mono text-[0.82rem]" />
            </Field>
            <TokenSection
              label="Bearer Token"
              hint="Optional. Set a token to require NetBird to authenticate; with no token, posts are accepted unauthenticated."
              locked={!!data.tokenFromEnv}
              lockedHint="Managed by the WEBHOOK_AUTH_TOKEN environment variable - edit it in your deployment config, not here."
              hasToken={data.hasToken}
              authEnabled={data.authEnabled}
              saving={save.isPending}
              onSave={async (t) => { await save.mutateAsync({ token: t }); }}
              onClear={async () => { await save.mutateAsync({ clear: true }); }}
            />
          </div>

          <div className={CARD}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Account Notifications</div>
                <p className="text-[0.82rem] text-nb-gray-500 mt-0.5">
                  Routing peer down/deleted, pending approvals, IdP/EDR sync problems - they reach the Telegram
                  alerts topic, the Troubleshoot page and the dashboard. Point NetBird → Settings → Notifications →
                  Webhook here, with this section’s own token.
                </p>
              </div>
              <IngestStatus status={nbStatus?.notifications} loading={nbStatusLoading} lastAt={data.notifLastAt} />
            </div>
            <AutoConfigureCard
              mutation={autoNotif}
              confirmMessage={notifConfirm}
              blurb="Let this app create the token and the NetBird webhook channel for you - no manual copying."
              successNoun="Webhook channel"
            />
            <p className="text-[0.78rem] text-nb-gray-500 -mb-1">
              Or configure NetBird manually with the endpoint and token below:
            </p>
            <Field label="Endpoint URL">
              <Input value={notifEndpoint} readOnly onFocus={(e) => e.currentTarget.select()} className="font-mono text-[0.82rem]" />
            </Field>
            <TokenSection
              label="Bearer Token"
              hint="Optional. Independent from the events token - set a token to require NetBird to authenticate; with no token, posts are accepted unauthenticated."
              hasToken={data.hasNotifToken}
              authEnabled={data.notifAuthEnabled}
              saving={save.isPending}
              onSave={async (t) => { await save.mutateAsync({ notifToken: t }); }}
              onClear={async () => { await save.mutateAsync({ clearNotif: true }); }}
            />
          </div>

          <TrafficPullCard className={CARD} />
          <AuditPullCard className={CARD} />
        </div>
      )}
    </div>
  );
}
