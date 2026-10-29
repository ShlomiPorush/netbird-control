import { useEffect, useState } from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useEdrAutoBypass, useSecurityConfig } from '@/lib/queries';
import { useSaveEdrAutoBypass, useSaveSecurity, useSendReviewDigest } from '@/lib/mutations';
import type { EdrAutoBypassConfig, EdrBypassOs, SecurityConfig } from '@/lib/types';
import { Button, Checkbox, LoadingState, Input, SelectMenu, Field } from '@/components/ui';

// ─── Security & alerts: session limits, request escalation, review digest, anomaly alerts ───
const DAY_OPTIONS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  .map((label, i) => ({ value: String(i), label }));
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

function NumField({ label, hint, value, onChange, suffix }: {
  label: string; hint?: string; value: number; onChange: (n: number) => void; suffix?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Input type="number" min={0} value={String(value)} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} className="w-28" />
        {suffix && <span className="text-sm text-nb-gray-500">{suffix}</span>}
      </div>
    </Field>
  );
}

// ─── Automatic EDR Bypass by OS ───
// Devices that can never run the EDR agent (phones, Linux servers) otherwise need a manual
// bypass each. A rule bypasses them automatically, per operating system.
const EDR_OS_OPTIONS: { value: EdrBypassOs; label: string }[] = [
  { value: 'ios', label: 'iOS / iPadOS' },
  { value: 'android', label: 'Android' },
  { value: 'linux', label: 'Linux' },
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
];

function AutoEdrBypass() {
  const { data, isLoading } = useEdrAutoBypass();
  const save = useSaveEdrAutoBypass();
  const [cfg, setCfg] = useState<EdrAutoBypassConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (data) setCfg({ enabled: data.enabled, rules: (data.rules || []).map((r) => ({ ...r })) }); }, [data]);

  if (isLoading || !cfg) return null;

  const used = new Set(cfg.rules.map((r) => r.os));
  const free = EDR_OS_OPTIONS.filter((o) => !used.has(o.value));
  const patchRule = (i: number, p: Partial<EdrAutoBypassConfig['rules'][number]>) =>
    setCfg((c) => (c ? { ...c, rules: c.rules.map((r, x) => (x === i ? { ...r, ...p } : r)) } : c));
  const removeRule = (i: number) => setCfg((c) => (c ? { ...c, rules: c.rules.filter((_, x) => x !== i) } : c));
  const addRule = () => {
    if (!free.length) return;
    setCfg((c) => (c ? { ...c, rules: [...c.rules, { os: free[0].value, durationDays: null }] } : c));
  };

  const onSave = async () => {
    setError('');
    try {
      await save.mutateAsync(cfg);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed to save'); }
  };

  return (
    <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Automatic EDR Bypass</div>
        <label className="inline-flex items-center gap-2 cursor-pointer select-none text-sm text-nb-gray-600 dark:text-nb-gray-300">
          <Checkbox checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /> Enabled
        </label>
      </div>
      <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3">
        Devices that can never run the EDR agent (phones, Linux servers) are compliance-blocked and need a manual
        bypass each. A rule bypasses every blocked device of that platform automatically, on each device sync -
        exactly like an admin clicking Bypass. Each application is audited and sent to the Security Alerts topic.
        <br />
        <b>The operating system is self-reported by the client and can be spoofed - use only for platforms your EDR cannot support.</b>
      </p>
      <div className={cn('flex flex-col gap-2', !cfg.enabled && 'opacity-50')}>
        {cfg.rules.length === 0 && (
          <p className="text-nb-gray-500 text-[0.82rem]">No rules - nothing is bypassed automatically.</p>
        )}
        {cfg.rules.map((r, i) => (
          <div key={r.os} className="flex flex-wrap items-end gap-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-3">
            <div className="w-48">
              <Field label="Operating System">
                <SelectMenu
                  value={r.os}
                  onChange={(v) => patchRule(i, { os: v as EdrBypassOs })}
                  searchable={false}
                  options={EDR_OS_OPTIONS.filter((o) => o.value === r.os || !used.has(o.value))}
                />
              </Field>
            </div>
            <div className="w-44">
              <Field label="Duration">
                <SelectMenu
                  value={r.durationDays === null ? 'unlimited' : 'days'}
                  onChange={(v) => patchRule(i, { durationDays: v === 'unlimited' ? null : (r.durationDays || 30) })}
                  searchable={false}
                  options={[{ value: 'unlimited', label: 'Unlimited' }, { value: 'days', label: 'For N Days' }]}
                />
              </Field>
            </div>
            {r.durationDays !== null && (
              <div className="w-32">
                <Field label="Days (1-365)">
                  <Input type="number" min={1} max={365} value={String(r.durationDays)}
                    onChange={(e) => patchRule(i, { durationDays: Math.min(365, Math.max(1, Number(e.target.value) || 1)) })} />
                </Field>
              </div>
            )}
            <Button variant="secondary" onClick={() => removeRule(i)} title="Remove this rule">
              <Trash2 size={14} /> Remove
            </Button>
          </div>
        ))}
        <div>
          <Button variant="secondary" onClick={addRule} disabled={!free.length}
            title={free.length ? 'Add a rule for another platform' : 'Every platform already has a rule'}>
            <Plus size={14} /> Add Rule
          </Button>
        </div>
      </div>
      <p className="text-nb-gray-500 text-[0.82rem] mt-3">
        <b>Unlimited</b> bypasses enter every access recertification round, so they are re-attested periodically.
        A <b>timed</b> bypass expires on schedule and is re-applied on the next sync while its rule stays on.
        Revoking a device's automatic bypass by hand (Peers page or Access Review) excludes that device permanently -
        it is never bypassed automatically again. Per account: rules act only on the account you are managing.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save Rules'}</Button>
        {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>
    </div>
  );
}

export function Security() {
  const { data, isLoading } = useSecurityConfig();
  const save = useSaveSecurity();
  const [cfg, setCfg] = useState<SecurityConfig | null>(null);
  const [emails, setEmails] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const sendDigest = useSendReviewDigest();
  const [sendMsg, setSendMsg] = useState('');
  const onSendNow = async () => {
    setSendMsg('');
    try {
      const r = await sendDigest.mutateAsync();
      setSendMsg(`Sent - Telegram: ${r.telegram ? 'yes' : 'no'} · ${r.emails} email${r.emails === 1 ? '' : 's'}`);
    } catch (e) { setSendMsg((e as Error).message || 'Failed to send'); }
  };

  useEffect(() => {
    if (data) { setCfg(data); setEmails((data.reviewEmails || []).join(', ')); }
  }, [data]);

  const patch = (p: Partial<SecurityConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));

  const onSave = async () => {
    if (!cfg) return;
    setError('');
    try {
      await save.mutateAsync({ ...cfg, reviewEmails: emails.split(',').map((s) => s.trim()).filter(Boolean) });
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed to save'); }
  };

  if (isLoading || !cfg) return <LoadingState />;
  return (
    <div className="max-w-2xl">
      <p className="text-nb-gray-500 text-sm mb-5">
        Session limits, access-request escalation, the weekly access review and anomaly alerts.
        Set any numeric limit to 0 to disable it.
      </p>

      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Session Limits</div>
          <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3">
            Shorter sessions reduce exposure. The absolute caps count from the actual sign-in - activity doesn't extend them.
          </p>
          <div className="grid sm:grid-cols-3 gap-4">
            <NumField label="Idle Timeout" suffix="hours" hint="Signed out after this much inactivity." value={cfg.sessionIdleHours} onChange={(n) => patch({ sessionIdleHours: n })} />
            <NumField label="User Session Cap" suffix="hours" hint="Absolute cap for regular users." value={cfg.sessionMaxHours} onChange={(n) => patch({ sessionMaxHours: n })} />
            <NumField label="Admin Session Cap" suffix="hours" hint="Stricter absolute cap for admins." value={cfg.adminSessionMaxHours} onChange={(n) => patch({ adminSessionMaxHours: n })} />
          </div>
        </div>

        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Access-Request Escalation</div>
          <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3">
            Keep requests from sitting forever: one Telegram reminder, then automatic expiry (the requester is emailed).
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            <NumField label="Reminder After" suffix="minutes" hint="One reminder per pending request." value={cfg.requestReminderMinutes} onChange={(n) => patch({ requestReminderMinutes: n })} />
            <NumField label="Expire After" suffix="hours" hint="Undecided requests expire." value={cfg.requestExpireHours} onChange={(n) => patch({ requestExpireHours: n })} />
          </div>
        </div>

        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Weekly Access Review</div>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none text-sm text-nb-gray-600 dark:text-nb-gray-300">
              <Checkbox checked={cfg.reviewEnabled} onChange={(e) => patch({ reviewEnabled: e.target.checked })} /> Enabled
            </label>
          </div>
          <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3">
            A digest of everything currently open - active grants, bypasses, auto-approval rules, permissions and pending
            requests - to the approvals Telegram chat and the emails below.
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Day"><SelectMenu value={String(cfg.reviewDay)} onChange={(v) => patch({ reviewDay: Number(v) })} searchable={false} options={DAY_OPTIONS} /></Field>
            <Field label="Hour" hint="App time zone."><SelectMenu value={String(cfg.reviewHour)} onChange={(v) => patch({ reviewHour: Number(v) })} options={HOUR_OPTIONS} /></Field>
          </div>
          <div className="mt-3">
            <Field label="Email Recipients (Optional)" hint="Comma-separated; requires SMTP to be configured.">
              <Input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="security@example.com, ops@example.com" />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={onSendNow} disabled={sendDigest.isPending}
              title="Sends the digest immediately with the SAVED settings (save first if you changed recipients). Suppresses today's scheduled send.">
              <Send size={14} /> {sendDigest.isPending ? 'Sending…' : 'Send Now'}
            </Button>
            {sendMsg && <span className="text-sm text-nb-gray-500">{sendMsg}</span>}
          </div>
        </div>

        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Anomaly Alerts</div>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none text-sm text-nb-gray-600 dark:text-nb-gray-300">
              <Checkbox checked={cfg.anomalyEnabled} onChange={(e) => patch({ anomalyEnabled: e.target.checked })} /> Enabled
            </label>
          </div>
          <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3">
            Telegram 🚨 on: a device switching country, a new device from a country the user was never seen in,
            admin actions outside working days/hours, and per-device traffic spikes. Route these to their own
            topic via Settings → Telegram → Security Alerts.
          </p>
          <div className="mb-4">
            <Field label="Work Days" hint="Admin actions on other days alert regardless of the hour.">
              <div className="flex flex-wrap gap-1.5">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, d) => {
                  const on = (cfg.workDays || []).includes(d);
                  return (
                    <button key={d} type="button"
                      onClick={() => patch({ workDays: on ? (cfg.workDays || []).filter((x) => x !== d) : [...(cfg.workDays || []), d] })}
                      className={cn('h-9 px-3 rounded-md border text-sm transition-colors',
                        on ? 'border-netbird/50 bg-netbird/10 text-netbird font-medium'
                           : 'border-nb-gray-200 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:bg-nb-gray-100 dark:hover:bg-nb-gray-800')}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Work Hours Start" hint="App time zone."><SelectMenu value={String(cfg.workStart)} onChange={(v) => patch({ workStart: Number(v) })} options={HOUR_OPTIONS} /></Field>
            <Field label="Work Hours End"><SelectMenu value={String(cfg.workEnd === 24 ? 0 : cfg.workEnd)} onChange={(v) => patch({ workEnd: Number(v) === 0 ? 24 : Number(v) })} options={HOUR_OPTIONS} /></Field>
            <NumField label="Traffic Spike Multiplier" suffix="× hourly average" hint="Alert when a device exceeds this times its own 7-day hourly average." value={cfg.trafficMult} onChange={(n) => patch({ trafficMult: n })} />
            <NumField label="Traffic Spike Floor" suffix="MB/hour" hint="…and moved at least this much in the hour." value={cfg.trafficFloorMb} onChange={(n) => patch({ trafficFloorMb: n })} />
          </div>
        </div>

        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Background Job Alerts</div>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none text-sm text-nb-gray-600 dark:text-nb-gray-300">
              <Checkbox checked={cfg.schedAlertsEnabled !== false} onChange={(e) => patch({ schedAlertsEnabled: e.target.checked })} /> Enabled
            </label>
          </div>
          <p className="text-nb-gray-500 text-[0.82rem] mt-0.5">
            Telegram 🚨 when a scheduled background job fails 3 times in a row (sync, expiry, notifications…),
            and ✅ once it recovers - one alert per breakage, not per failing run. Uses the same Security
            Alerts topic; job details live in Operations → System Health.
          </p>
        </div>

        {/* ── Automatic EDR bypass by OS (its own endpoint + Save) ── */}
        <AutoEdrBypass />

        {/* ── Access recertification ── */}
        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4 flex flex-col gap-4">
          <div>
            <div className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50">Access Recertification</div>
            <p className="text-[0.82rem] text-nb-gray-500 mt-0.5">
              Periodically open a review round on the <b>Access Review</b> page: every standing item
              (unlimited bypasses, feature permissions, auto-approval rules, recurring access) must be
              explicitly kept or revoked. Rounds are due 14 days after opening, with a Telegram nudge when overdue.
            </p>
          </div>
          <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
            <Checkbox checked={cfg.recertEnabled !== false} onChange={(e) => patch({ recertEnabled: e.target.checked })} />
            <span className="text-sm text-nb-gray-700 dark:text-nb-gray-200">Open Rounds Automatically</span>
          </label>
          {cfg.recertEnabled !== false && (
            <div className="grid sm:grid-cols-2 gap-4">
              <NumField label="Review Interval" suffix="days (30-365)" hint="A new round opens this long after the previous one started. 90 = quarterly."
                value={cfg.recertIntervalDays} onChange={(n) => patch({ recertIntervalDays: n })} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
          {error && <span className="text-sm text-red-500">{error}</span>}
        </div>
      </div>
    </div>
  );
}
