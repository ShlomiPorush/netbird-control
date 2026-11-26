import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FolderDown, Globe, KeyRound, ShieldCheck, XCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useGroups } from '@/lib/queries';
import { apiText, remoteApi, type BrowserConfig, type BrowserStatus, type RemoteAccessConfig } from '@/lib/remoteAccess';
import { Badge, Button, Card, CopyButton, Field, Input, Modal, SelectMenu, type SelectOption } from '@/components/ui';
import { StepRow } from './LaunchNetworkPanel';
import { SettingRow, Toggle } from './NetbirdFields';

const BROWSER_DEFAULTS: BrowserConfig = { enabled: false, routerGroupId: '', maxSessions: 5, maxPerUser: 1, keepAliveMin: 15, startPage: '', files: false, transfer: false, filesLimitGb: 2, language: 'en-US' };
const LANGUAGE_OPTIONS: SelectOption[] = [
  { value: 'en-US', label: 'English' },
  { value: 'he', label: 'עברית' },
];
const languageName = (language: string) => LANGUAGE_OPTIONS.find((o) => o.value === language)?.label ?? LANGUAGE_OPTIONS[0].label;
const DEFAULT_ROUTER_GROUP = 'Office Peers';
const MAX_SESSIONS = { min: 1, max: 50 };
const MAX_PER_USER = { min: 1, max: 10 };
const KEEP_ALIVE = { min: 1, max: 120 };
const FILES_LIMIT = { min: 1, max: 10 };
const muted = 'text-sm text-nb-gray-500 dark:text-nb-gray-400';

const inRange = (value: string, r: { min: number; max: number }) => /^\d+$/.test(value) && Number(value) >= r.min && Number(value) <= r.max;
const validStartPage = (value: string) => {
  const text = value.trim();
  if (!text) return true;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && url.href.length <= 2048;
  } catch { return false; }
};

function gatewayState(st: BrowserStatus | undefined, loading: boolean): { tone: 'ok' | 'warn' | 'bad' | 'unknown'; label: string; detail?: string } {
  if (!st) return { tone: 'unknown', label: loading ? 'Checking…' : 'Status Unavailable' };
  if (!st.enrolled) return { tone: 'bad', label: 'Not Enrolled', detail: 'Create a setup key and start the browser gateway.' };
  if (!st.online) return { tone: 'bad', label: 'Offline', detail: st.reason || undefined };
  if (!st.ready) return { tone: 'warn', label: 'Not Ready', detail: st.reason || undefined };
  return { tone: 'ok', label: 'Ready' };
}

const STATE_ICON = {
  ok: <CheckCircle2 size={16} className="shrink-0 text-green-500" />,
  warn: <AlertTriangle size={16} className="shrink-0 text-amber-500" />,
  bad: <XCircle size={16} className="shrink-0 text-red-500" />,
  unknown: <AlertTriangle size={16} className="shrink-0 text-nb-gray-400" />,
};

export function RemoteBrowserCard({ config, status, statusLoading, readonly, managedGroupIds }: {
  config: BrowserConfig | undefined;
  status: BrowserStatus | undefined;
  statusLoading: boolean;
  readonly: boolean;
  managedGroupIds: Set<string>;
}) {
  const qc = useQueryClient();
  const groupsQ = useGroups();
  const saved = config || BROWSER_DEFAULTS;
  const [busy, setBusy] = useState<'' | 'toggle' | 'save' | 'key'>('');
  const [error, setError] = useState('');
  const [modalError, setModalError] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ routerGroupId: '', maxSessions: '', maxPerUser: '', keepAliveMin: '', startPage: '', files: false, transfer: false, filesLimitGb: '', language: BROWSER_DEFAULTS.language });

  const groups = groupsQ.data || [];
  const groupOptions: SelectOption[] = useMemo(() => groups
    .filter((g) => g.name !== 'All' && !managedGroupIds.has(g.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({ value: g.id, label: g.name, subtitle: `${g.peers_count} device${g.peers_count === 1 ? '' : 's'}` })), [groups, managedGroupIds]);
  const savedGroup = groups.find((g) => g.id === saved.routerGroupId);
  const groupMissing = !!saved.routerGroupId && groupsQ.isSuccess && !savedGroup;
  const setUp = !!saved.routerGroupId && !groupMissing;
  const badge = !setUp ? 'Not Set Up' : saved.enabled ? 'On' : 'Off';
  const gw = gatewayState(status, statusLoading);

  const store = async (next: BrowserConfig) => {
    try {
      const r = await remoteApi.saveConfig({ browser: next });
      qc.setQueryData<RemoteAccessConfig>(['remote-access-config'], (old) => old && ({ ...old, browser: r.config.browser }));
      return '';
    } catch (e) {
      if (e instanceof ApiError && e.status !== 502) return e.message;
      void qc.invalidateQueries({ queryKey: ['remote-access-config'] });
      return e instanceof ApiError ? `${e.message} The setting was saved; NetBird was not fully updated.` : "The setting couldn't be saved. Try again.";
    } finally {
      void qc.invalidateQueries({ queryKey: ['remote-access-status'] });
    }
  };

  const toggle = async (enabled: boolean) => {
    setBusy('toggle'); setError('');
    setError(await store({ ...saved, enabled }));
    setBusy('');
  };

  const openEditor = () => {
    const preset = saved.routerGroupId || groups.find((g) => g.name === DEFAULT_ROUTER_GROUP)?.id || '';
    setDraft({
      routerGroupId: preset, maxSessions: String(saved.maxSessions), maxPerUser: String(saved.maxPerUser), keepAliveMin: String(saved.keepAliveMin), startPage: saved.startPage || '',
      files: !!saved.files, transfer: !!saved.files && !!saved.transfer, filesLimitGb: String(saved.filesLimitGb || BROWSER_DEFAULTS.filesLimitGb),
      language: saved.language || BROWSER_DEFAULTS.language,
    });
    setModalError('');
    setEditing(true);
  };
  const draftValid = !!draft.routerGroupId && inRange(draft.maxSessions, MAX_SESSIONS) && inRange(draft.maxPerUser, MAX_PER_USER) && inRange(draft.keepAliveMin, KEEP_ALIVE) && validStartPage(draft.startPage) && inRange(draft.filesLimitGb, FILES_LIMIT);
  const saveDraft = async () => {
    if (!draftValid) return;
    setBusy('save'); setModalError('');
    const message = await store({
      ...saved, routerGroupId: draft.routerGroupId, maxSessions: Number(draft.maxSessions), maxPerUser: Number(draft.maxPerUser), keepAliveMin: Number(draft.keepAliveMin), startPage: draft.startPage.trim(),
      files: draft.files, transfer: draft.files && draft.transfer, filesLimitGb: Number(draft.filesLimitGb), language: draft.language,
    });
    setBusy('');
    if (message) setModalError(message); else setEditing(false);
  };

  const createKey = async () => {
    setBusy('key'); setError(''); setSetupKey('');
    try { setSetupKey((await remoteApi.setupKey('web')).key); }
    catch (e) { setError(apiText(e, "The setup key couldn't be created. Try again.")); }
    finally { setBusy(''); }
  };

  const switchLocked = readonly || !!busy || (!saved.enabled && !setUp);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3.5 p-4 sm:p-5">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-netbird/10 text-netbird"><Globe size={20} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-nb-gray-900 dark:text-nb-gray-50">Remote Browser</h3>
            <Badge tone={badge === 'On' ? 'green' : 'gray'}>{badge}</Badge>
          </div>
          <p className="mt-0.5 text-[0.82rem] text-nb-gray-500 dark:text-nb-gray-400">Users open a browser for public websites. Nothing internal can be reached from it.</p>
        </div>
        <div className="ml-auto flex shrink-0 flex-col items-end gap-1.5">
          <label className="inline-flex">
            <span className="sr-only">Turn On The Remote Browser</span>
            <Toggle checked={saved.enabled} disabled={switchLocked} onChange={(v) => { void toggle(v); }} />
          </label>
          {!saved.enabled && !setUp && !readonly && (
            <span className="max-w-[180px] text-right text-[0.72rem] leading-snug text-nb-gray-500">Choose an exit group to turn this on.</span>
          )}
        </div>
      </div>
      {readonly && <p className="px-4 pb-3 sm:px-5 text-[0.8rem] text-nb-gray-500">This instance is read-only, so these settings can't be changed here.</p>}

      <StepRow n={1} done={setUp} label="Exit Group" actions={(
        <Button size="sm" variant={setUp ? 'secondary' : 'primary'} onClick={openEditor} disabled={readonly || !!busy}>{setUp ? 'Change' : 'Choose Group'}</Button>
      )}>
        {savedGroup ? (
          <>
            <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 break-words">{savedGroup.name}</div>
            <div className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">Sites see the internet address of these routing peers.</div>
          </>
        ) : groupMissing ? (
          <span className="text-sm text-amber-700 dark:text-amber-400">The chosen group no longer exists in NetBird. Choose another one.</span>
        ) : (
          <span className={muted}>The routing peers the browser goes out through</span>
        )}
      </StepRow>

      <StepRow n={2} done={gw.tone === 'ok'} label="Gateway" actions={(
        <Button size="sm" onClick={() => { void createKey(); }} disabled={readonly || !!busy}>
          <KeyRound size={14} /> {busy === 'key' ? 'Creating…' : 'Create Setup Key'}
        </Button>
      )}>
        <div className="flex items-start gap-2">
          <span className="mt-0.5">{STATE_ICON[gw.tone]}</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">{gw.label}</div>
            {gw.detail && <div className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400 break-words">{gw.detail}</div>}
          </div>
        </div>
        {setupKey && (
          <div className="mt-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/40 p-3">
            <div className="text-[0.8rem] text-nb-gray-500 mb-1"><code>REMOTE_BROWSER_GATEWAY_SETUP_KEY</code> - shown once. Copy it now.</div>
            <div className="flex items-center gap-2">
              <code className="text-sm break-all">{setupKey}</code>
              <CopyButton value={setupKey} />
            </div>
          </div>
        )}
      </StepRow>

      <StepRow n={3} done label="Limits" actions={(
        <Button size="sm" onClick={openEditor} disabled={readonly || !!busy}>Change</Button>
      )}>
        <div className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
          Up to <b>{saved.maxSessions}</b> browser{saved.maxSessions === 1 ? '' : 's'} at a time, <b>{saved.maxPerUser}</b> per user
        </div>
        <div className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">
          A browser keeps running {saved.keepAliveMin} minute{saved.keepAliveMin === 1 ? '' : 's'} after its user disconnects.
        </div>
        <div className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400 break-all">
          {saved.startPage ? <>New browsers open <span className="font-medium text-nb-gray-700 dark:text-nb-gray-200">{saved.startPage}</span></> : 'New browsers open a blank page.'}
        </div>
        <div className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">
          New browsers use <bdi className="font-medium text-nb-gray-700 dark:text-nb-gray-200">{languageName(saved.language)}</bdi>.
        </div>
      </StepRow>

      <StepRow n={4} done label="Files" actions={(
        <Button size="sm" onClick={openEditor} disabled={readonly || !!busy}>Change</Button>
      )}>
        <div className="flex items-start gap-2">
          <FolderDown size={16} className={saved.files ? 'mt-0.5 shrink-0 text-netbird' : 'mt-0.5 shrink-0 text-nb-gray-400'} />
          <div className="min-w-0">
            <div className="text-sm text-nb-gray-700 dark:text-nb-gray-200">
              {!saved.files ? 'Downloads and uploads are blocked in the browser'
                : saved.transfer ? 'Files In The Browser, and transfers to and from computers' : 'Files In The Browser, without transfers to computers'}
            </div>
            {saved.files && (
              <div className="text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">
                Up to {saved.filesLimitGb} GB per browser. Files are deleted when the browser closes.
              </div>
            )}
          </div>
        </div>
      </StepRow>

      {error && <p role="alert" className="border-t border-nb-gray-100 dark:border-nb-gray-900 px-4 py-3 sm:px-5 text-sm text-red-500 break-words">{error}</p>}

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        closeDisabled={busy === 'save'}
        title="Remote Browser Settings"
        icon={<Globe size={18} />}
        size="md"
        footer={(
          <>
            <span className="mr-auto flex min-w-0 items-center gap-1.5 text-[0.75rem] text-nb-gray-500 dark:text-nb-gray-400">
              <ShieldCheck size={14} className="shrink-0" /> {saved.enabled ? "Updates the browser's route in NetBird." : 'Nothing in NetBird changes until you turn it on.'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy === 'save'}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={() => { void saveDraft(); }} disabled={!draftValid || busy === 'save'}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-4">
          <Field label="Exit Group" hint="The browser reaches the internet through this group's routing peers, and sites see their address.">
            <SelectMenu options={groupOptions} value={draft.routerGroupId} searchable
              placeholder={groupsQ.isLoading ? 'Loading Groups…' : 'Choose Group'}
              onChange={(v) => setDraft((d) => ({ ...d, routerGroupId: v }))} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Browsers At A Time" hint="For all users together, 1 to 50.">
              <Input inputMode="numeric" value={draft.maxSessions} aria-invalid={!inRange(draft.maxSessions, MAX_SESSIONS) || undefined}
                onChange={(e) => setDraft((d) => ({ ...d, maxSessions: e.target.value.replace(/\D/g, '') }))} />
            </Field>
            <Field label="Browsers Per User" hint="How many one user may have open, 1 to 10.">
              <Input inputMode="numeric" value={draft.maxPerUser} aria-invalid={!inRange(draft.maxPerUser, MAX_PER_USER) || undefined}
                onChange={(e) => setDraft((d) => ({ ...d, maxPerUser: e.target.value.replace(/\D/g, '') }))} />
            </Field>
            <Field label="Keep Running After Disconnect (Minutes)" hint="So the user can come back to it, 1 to 120.">
              <Input inputMode="numeric" value={draft.keepAliveMin} aria-invalid={!inRange(draft.keepAliveMin, KEEP_ALIVE) || undefined}
                onChange={(e) => setDraft((d) => ({ ...d, keepAliveMin: e.target.value.replace(/\D/g, '') }))} />
            </Field>
          </div>
          <Field label="Start Page" hint="The page a new browser opens on. Leave it empty for a blank page.">
            <Input inputMode="url" placeholder="https://portal.example.com" value={draft.startPage} aria-invalid={!validStartPage(draft.startPage) || undefined}
              onChange={(e) => setDraft((d) => ({ ...d, startPage: e.target.value }))} />
          </Field>
          <Field label="Browser Language" hint="The language of the browser's menus and the language websites are asked for. New browsers only.">
            <SelectMenu options={LANGUAGE_OPTIONS} value={draft.language}
              onChange={(v) => setDraft((d) => ({ ...d, language: v }))} />
          </Field>
          <div className="border-t border-nb-gray-100 pt-4 dark:border-nb-gray-900">
            <SettingRow title="Files In The Browser" checked={draft.files}
              help="Users can download files in the browser and upload them to websites. The files are deleted when the browser closes."
              onChange={(v) => setDraft((d) => ({ ...d, files: v, transfer: v && d.transfer }))} />
            <SettingRow title="Transfer Files To And From Computers" checked={draft.files && draft.transfer} disabled={!draft.files}
              help={draft.files ? "Users can copy the browser's files to their computer, and files from their computer into the browser." : 'Turn on Files In The Browser first.'}
              onChange={(v) => setDraft((d) => ({ ...d, transfer: v }))} />
          </div>
          <Field label="Storage Per Browser (GB)" hint="How much one browser's files may take, 1 to 10. The server's disk needs about this much for each browser at a time.">
            <Input inputMode="numeric" value={draft.filesLimitGb} aria-invalid={!inRange(draft.filesLimitGb, FILES_LIMIT) || undefined}
              onChange={(e) => setDraft((d) => ({ ...d, filesLimitGb: e.target.value.replace(/\D/g, '') }))} />
          </Field>
          {modalError && <p role="alert" className="text-sm text-red-500 break-words">{modalError}</p>}
        </div>
      </Modal>
    </Card>
  );
}
