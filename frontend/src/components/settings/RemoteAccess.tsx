import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Plus, Trash2, XCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { docsUrl } from '@/lib/docs';
import { useGroups, useNetworks, useVersion } from '@/lib/queries';
import { formatTimestamp } from '@/lib/logfmt';
import { remoteApi, type CreatedResourceState, type CreateResourcesConfig, type RdpDisplay, type RemoteAccessConfig, type SshTerminal } from '@/lib/remoteAccess';
import { Button, CopyButton, Field, Input, LoadingState, Select, Textarea } from '@/components/ui';

// guacd's keymaps, by name. An id missing here shows as is.
const LAYOUT_NAMES: Record<string, string> = {
  'en-us-qwerty': 'English (US)', 'en-gb-qwerty': 'English (UK)', 'cs-cz-qwertz': 'Czech', 'da-dk-qwerty': 'Danish',
  'de-ch-qwertz': 'German (Switzerland)', 'de-de-qwertz': 'German', 'es-es-qwerty': 'Spanish', 'es-latam-qwerty': 'Spanish (Latin America)',
  'fr-be-azerty': 'French (Belgium)', 'fr-ca-qwerty': 'French (Canada)', 'fr-ch-qwertz': 'French (Switzerland)', 'fr-fr-azerty': 'French',
  'hu-hu-qwertz': 'Hungarian', 'it-it-qwerty': 'Italian', 'ja-jp-qwerty': 'Japanese', 'no-no-qwerty': 'Norwegian', 'pl-pl-qwerty': 'Polish',
  'pt-br-qwerty': 'Portuguese (Brazil)', 'pt-pt-qwerty': 'Portuguese', 'ro-ro-qwerty': 'Romanian', 'sv-se-qwerty': 'Swedish', 'tr-tr-qwerty': 'Turkish',
  failsafe: 'Unicode Only (Failsafe)',
};
const DEPTH_NAMES: Record<number, string> = { 8: '8-Bit (256 Colors)', 16: '16-Bit', 24: '24-Bit', 32: '32-Bit (Full Color)' };
const SCHEME_NAMES: Record<string, string> = { 'gray-black': 'Gray On Black', 'black-white': 'Black On White', 'green-black': 'Green On Black', 'white-black': 'White On Black' };
const RDP_EFFECTS: { key: 'fontSmoothing' | 'wallpaper' | 'theming' | 'fullWindowDrag' | 'desktopComposition' | 'menuAnimations'; label: string; hint: string }[] = [
  { key: 'fontSmoothing', label: 'Font Smoothing (ClearType)', hint: 'Smooth text. Costs little.' },
  { key: 'wallpaper', label: 'Desktop Wallpaper', hint: 'Costs bandwidth, mostly on the first screen.' },
  { key: 'theming', label: 'Windows Themes', hint: 'Themed buttons and windows instead of the classic look.' },
  { key: 'fullWindowDrag', label: 'Window Contents While Dragging', hint: 'Costs bandwidth while a window moves.' },
  { key: 'desktopComposition', label: 'Desktop Composition', hint: 'Transparent window borders and shadows.' },
  { key: 'menuAnimations', label: 'Menu Animations', hint: 'Menus fade and slide.' },
];

// Resources created by the launch API: each state in plain words, and its text color.
const CREATED_STATES: Record<CreatedResourceState, { label: string; tone: string }> = {
  creating: { label: 'Creating', tone: 'text-nb-gray-500' },
  unknown: { label: 'Unconfirmed', tone: 'text-amber-600 dark:text-amber-400' },
  created: { label: 'Active', tone: 'text-green-600 dark:text-green-500' },
  deleting: { label: 'Removing', tone: 'text-nb-gray-500' },
  kept: { label: 'Kept', tone: 'text-amber-600 dark:text-amber-400' },
  failed: { label: 'Failed', tone: 'text-nb-gray-500' },
  deleted: { label: 'Removed', tone: 'text-nb-gray-500' },
  gone: { label: 'Gone', tone: 'text-nb-gray-500' },
};
// States that come with a reason worth showing under them.
const CREATED_REASON_STATES: CreatedResourceState[] = ['kept', 'unknown', 'failed', 'gone'];
const CREATE_DEFAULTS: CreateResourcesConfig = { enabled: false, networkId: '', groupId: '', max: 50 };
const createdCols = 'grid grid-cols-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_11rem_minmax(0,1fr)] gap-x-3 gap-y-1.5';

const box = 'rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-4';
const toggleCard = 'flex items-start gap-3 p-3.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/30 cursor-pointer';

function StatusLine({ ok, warn, label, detail }: { ok: boolean | null; warn?: boolean; label: string; detail?: string }) {
  const icon = ok === null ? <AlertTriangle size={16} className="text-nb-gray-400" />
    : ok ? <CheckCircle2 size={16} className="text-green-500" />
      : warn ? <AlertTriangle size={16} className="text-amber-500" /> : <XCircle size={16} className="text-red-500" />;
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5">{icon}</span>
      <div>
        <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">{label}</div>
        {detail && <div className="text-[0.8rem] text-nb-gray-500 dark:text-nb-gray-400">{detail}</div>}
      </div>
    </div>
  );
}

export function RemoteAccessSettings() {
  const qc = useQueryClient();
  const cfgQ = useQuery({ queryKey: ['remote-access-config'], queryFn: remoteApi.config });
  const statusQ = useQuery({ queryKey: ['remote-access-status'], queryFn: remoteApi.status, refetchInterval: 30000 });
  const networksQ = useNetworks();
  const groupsQ = useGroups();
  const version = useVersion().data;
  const createdQ = useQuery({ queryKey: ['remote-access-created'], queryFn: remoteApi.createdResources, refetchInterval: 30000 });
  const [form, setForm] = useState<RemoteAccessConfig | null>(null);
  const [keys, setKeys] = useState<{ address: string; key: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [setupKey, setSetupKey] = useState<{ kind: 'ip' | 'names'; key: string; expires: string } | null>(null);
  const [keyBusy, setKeyBusy] = useState<'' | 'ip' | 'names'>('');
  // The section for resources created by the API as last loaded or saved: it is sent only when it changed.
  const [savedCr, setSavedCr] = useState<CreateResourcesConfig | null>(null);

  useEffect(() => {
    if (cfgQ.data && !form) {
      setForm(cfgQ.data);
      setSavedCr(cfgQ.data.createResources || CREATE_DEFAULTS);
      setKeys(Object.entries(cfgQ.data.sshHostKeys || {}).map(([address, key]) => ({ address, key })));
    }
  }, [cfgQ.data, form]);

  if (cfgQ.isError && !form) {
    return (
      <div className="max-w-2xl flex flex-col items-start gap-3">
        <p className="text-sm text-red-500">{cfgQ.error instanceof ApiError && cfgQ.error.message ? cfgQ.error.message : 'The Remote Access settings could not be loaded. Try again.'}</p>
        <Button variant="secondary" size="sm" onClick={() => cfgQ.refetch()} disabled={cfgQ.isFetching}>{cfgQ.isFetching ? 'Retrying…' : 'Retry'}</Button>
      </div>
    );
  }
  if (cfgQ.isLoading || !form) return <LoadingState />;
  const set = <K extends keyof RemoteAccessConfig>(k: K, v: RemoteAccessConfig[K]) => { setForm({ ...form, [k]: v }); setSaved(''); };
  const st = statusQ.data;
  const cr = form.createResources || CREATE_DEFAULTS;
  const setCr = (patch: Partial<CreateResourcesConfig>) => set('createResources', { ...cr, ...patch });
  const crKey = (c: CreateResourcesConfig) => JSON.stringify([!!c.enabled, c.networkId || '', c.groupId || '', Number(c.max)]);
  const crChanged = crKey(cr) !== crKey(savedCr || CREATE_DEFAULTS);
  const crDiff = (): Partial<CreateResourcesConfig> => {
    const base = savedCr || CREATE_DEFAULTS;
    const now = { enabled: cr.enabled, networkId: cr.networkId, groupId: cr.groupId, max: Number(cr.max) };
    return Object.fromEntries(Object.entries(now).filter(([k, v]) => v !== base[k as keyof CreateResourcesConfig]));
  };
  // The network that holds the resources the API creates follows these settings, and so does its badge.
  const refreshCreated = () => {
    qc.invalidateQueries({ queryKey: ['remote-access-created'] });
    qc.invalidateQueries({ queryKey: ['networks'] });
    qc.invalidateQueries({ queryKey: ['network-detail'] });
  };

  const save = async () => {
    setSaving(true); setError(''); setSaved('');
    try {
      const sshHostKeys = Object.fromEntries(keys.filter((k) => k.address.trim() && k.key.trim()).map((k) => [k.address.trim(), k.key.trim()]));
      const r = await remoteApi.saveConfig({
        enabled: form.enabled, allowAll: form.allowAll, guacdHost: form.guacdHost, guacdPort: Number(form.guacdPort),
        namesGuacdHost: form.namesGuacdHost, namesGuacdPort: Number(form.namesGuacdPort),
        networks: form.networks, maxSessionsPerUser: Number(form.maxSessionsPerUser), maxSessionsTotal: Number(form.maxSessionsTotal),
        idleTimeoutMin: Number(form.idleTimeoutMin), maxDurationHours: Number(form.maxDurationHours), holdHours: Number(form.holdHours),
        clipboard: form.clipboard, sshHostKeys,
        rdp: form.rdp, ssh: { ...form.ssh, fontSize: Number(form.ssh.fontSize) },
        // Only when that section changed: saving another field never changes it.
        // Only the fields that changed: the server keeps the others as stored.
        ...(crChanged ? { createResources: crDiff() } : {}),
      });
      setForm(r.config);
      setSavedCr(r.config.createResources || CREATE_DEFAULTS);
      setSaved(r.sync?.removed ? `Saved. NetBird updated: ${r.sync.removed} server(s) taken off the gateways.` : 'Saved.');
      qc.invalidateQueries({ queryKey: ['remote-access-status'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      refreshCreated();
    } catch (e) {
      // notSaved: the settings were refused before anything was saved, and the reason says why.
      const notSaved = e instanceof ApiError && !!(e.body as { notSaved?: boolean } | null)?.notSaved;
      if (notSaved) {
        setError((e as ApiError).message);
      } else {
        setError(e instanceof ApiError ? `${e.message} The settings were saved; NetBird was not fully updated.` : 'Saving failed.');
        qc.invalidateQueries({ queryKey: ['remote-access-config'] });
        refreshCreated();
      }
    } finally {
      setSaving(false);
    }
  };

  const createKey = async (kind: 'ip' | 'names') => {
    setKeyBusy(kind); setError('');
    try { setSetupKey({ kind, ...(await remoteApi.setupKey(kind)) }); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'The setup key could not be created.'); }
    finally { setKeyBusy(''); }
  };

  const setRdp = <K extends keyof RdpDisplay>(k: K, v: RdpDisplay[K]) => set('rdp', { ...form.rdp, [k]: v });
  const setSsh = <K extends keyof SshTerminal>(k: K, v: SshTerminal[K]) => set('ssh', { ...form.ssh, [k]: v });
  const opts = form.options || { rdpLayouts: [form.rdp.serverLayout], rdpColorDepths: [form.rdp.colorDepth], sshColorSchemes: [form.ssh.colorScheme] };

  const toggleNetwork = (id: string) => set('networks', form.networks.includes(id) ? form.networks.filter((n) => n !== id) : [...form.networks, id]);

  // Resources created by the API: the network is one of those open to the gateway; the group is any
  // group but All and the groups this page manages. A saved choice that no longer fits stays
  // visible in its select, so the server's refusal explains it instead of a silent change.
  const created = createdQ.data;
  const crReadonly = !!form.readonly || !!created?.readonly;
  const netName = (id: string) => (networksQ.data || []).find((n) => n.id === id)?.name || id;
  const crNetworks = form.networks.map((id) => ({ id, name: netName(id) }));
  const managedIds = new Set(Object.values(form.managed || {}).filter(Boolean));
  const crGroups = (groupsQ.data || []).filter((g) => g.name !== 'All' && !managedIds.has(g.id)).sort((a, b) => a.name.localeCompare(b.name));
  const groupName = (id: string) => (groupsQ.data || []).find((g) => g.id === id)?.name || id;

  return (
    <div className="max-w-2xl flex flex-col gap-5">
      <p className="text-nb-gray-500 text-sm">
        Let users open RDP and SSH sessions from the browser through the Browser Gateway - NetBird peers next to this app.
        Each session is checked against the user's own NetBird access. The gateways reach only servers in the networks you pick here,
        once someone has opened a session to them, unless one of your NetBird policies lets them reach more. Resources created by the API are
        public, so the app doesn't check that for their group.
        The IP gateway serves IPv4 addresses. The names gateway, which is optional, serves host names of NetBird domain resources.
      </p>

      {!form.ssoEnabled && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[0.85rem] text-nb-gray-700 dark:text-nb-gray-200">
          Remote access needs SSO: without sign-in there is no NetBird identity to check access against. Configure SSO first.
        </p>
      )}
      {form.readonly && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[0.85rem] text-nb-gray-700 dark:text-nb-gray-200">
          This instance is read-only (NETBIRD_READONLY=true), so the gateway's NetBird objects can't be created or updated.
        </p>
      )}

      {/* Status */}
      <div className={box}>
        <div className="text-sm font-semibold mb-1 text-nb-gray-800 dark:text-nb-gray-100">Status</div>
        {statusQ.isLoading ? <div className="text-sm text-nb-gray-500">Checking…</div> : st ? (
          <>
            <div className="text-[0.75rem] font-semibold uppercase tracking-wide text-nb-gray-500 mt-1">IP Gateway</div>
            <StatusLine ok={st.gateway.enrolled && st.gateway.online} warn={st.gateway.enrolled}
              label={!st.gateway.enrolled ? 'Gateway Not Enrolled' : st.gateway.online ? 'Gateway Online' : 'Gateway Offline'}
              detail={st.gateway.enrolled ? st.gateway.peers.map((p) => `${p.name}${p.connected ? '' : ' (offline)'}`).join(', ') : 'Create a setup key below and start the gateway containers.'} />
            <StatusLine ok={st.guacdReachable} label={st.guacdReachable ? 'guacd Reachable' : 'guacd Not Reachable'}
              detail={st.guacdReachable ? `${form.guacdHost}:${form.guacdPort}` : `No answer from ${form.guacdHost}:${form.guacdPort}. Are the gateway containers running (netbird-docker-compose-files/docker-compose-remote-access.yml)?`} />
            {st.reachError && <StatusLine ok={false} label="Unreadable Policy Blocks Every Session" detail={st.reachError} />}
            {st.domainRoutes.length > 0 && (
              <StatusLine ok={false} label="Domain Routes Block Every Session"
                detail={`The gateway receives domain-based routes (${st.domainRoutes.slice(0, 4).map((d) => d.name || d.address).join(', ')}). They can't be bounded to addresses, so all sessions are refused. Change those policies' or routes' groups so they don't include the gateway (often the All group).`} />
            )}
            {st.extraReach.length > 0 && (
              <StatusLine ok={false} warn label="The Gateway Reaches More Than You Selected"
                detail={`Other policies or routes give the gateway access to ${st.extraReach.slice(0, 5).map((e) => `${e.name} (${e.address})`).join(', ')}${st.extraReach.length > 5 ? ` and ${st.extraReach.length - 5} more` : ''}. Sessions still need each user's own access, but a compromised gateway could reach these too. Usually caused by policies whose source is All.`} />
            )}
            <div className="text-[0.75rem] font-semibold uppercase tracking-wide text-nb-gray-500 mt-3">Names Gateway (Optional)</div>
            <StatusLine ok={st.names.gateway.enrolled ? st.names.gateway.online : null} warn={st.names.gateway.enrolled}
              label={!st.names.gateway.enrolled ? 'Not Enrolled - Host Names Of Domain Resources Are Refused' : st.names.gateway.online ? 'Gateway Online' : 'Gateway Offline'}
              detail={st.names.gateway.enrolled ? st.names.gateway.peers.map((p) => `${p.name}${p.connected ? '' : ' (offline)'}`).join(', ') : 'Optional. Create a names gateway setup key below and start it with the remote-names profile.'} />
            {st.names.gateway.enrolled && (
              <StatusLine ok={st.names.guacdReachable} label={st.names.guacdReachable ? 'guacd Reachable' : 'guacd Not Reachable'}
                detail={st.names.guacdReachable ? `${form.namesGuacdHost}:${form.namesGuacdPort}` : `No answer from ${form.namesGuacdHost}:${form.namesGuacdPort}. Is the names gateway running (profile remote-names)?`} />
            )}
            {st.names.reachError && <StatusLine ok={false} label="Unreadable Policy Blocks Connecting By Name" detail={st.names.reachError} />}
            {st.names.extraReach.length > 0 && (
              <StatusLine ok={false} label="Address Routes Block Connecting By Name"
                detail={`The names gateway receives address routes (${st.names.extraReach.slice(0, 5).map((e) => `${e.name} (${e.address})`).join(', ')}${st.names.extraReach.length > 5 ? ` and ${st.names.extraReach.length - 5} more` : ''}). One of them could capture the address a name resolves to, so connecting by name is refused. Usually caused by policies whose source is All.`} />
            )}
            {st.conflicts.length > 0 && (
              <>
                <StatusLine ok={false} warn label="Address Conflicts In The Selected Networks"
                  detail={`The same address is a resource in more than one network: ${st.conflicts.slice(0, 4).map((c) => `${c.address} (${c.networks.join(', ')})`).join('; ')}${st.conflicts.length > 4 ? ` and ${st.conflicts.length - 4} more` : ''}. Sessions to such an address are refused while the gateways can reach more than one of them. Fix it on the Networks page.`} />
                <div className="text-[0.8rem] ml-6"><Link className="text-netbird hover:underline" to="/networks">Open Networks</Link></div>
              </>
            )}
            {st.membership && st.membership.removed.length > 0 && (
              <StatusLine ok={false} warn label="Members Added Outside NetBird Control Were Removed"
                detail={`${st.membership.removed.slice(0, 5).map((r) => `${r.kind === 'user' ? 'User' : 'Device'} ${r.name} from ${r.group} (${formatTimestamp(r.at)})`).join('; ')}. Only the gateways belong in these groups. A gateway enrolled by signing in as a user is removed too: enroll it again with a setup key from this page.`} />
            )}
            {st.membership?.error && <StatusLine ok={false} label="Couldn't Remove A Member Added Outside NetBird Control" detail={`${st.membership.error} It is tried again on the next read from NetBird.`} />}
            {(st.error || st.lastApply.error) && <StatusLine ok={false} label="Problem" detail={st.error || st.lastApply.error} />}
            <div className="text-[0.75rem] font-semibold uppercase tracking-wide text-nb-gray-500 mt-3">Opened Servers</div>
            {(st.held || []).length === 0
              ? <div className="text-[0.8rem] text-nb-gray-500 py-1.5">None right now. A server opens to its gateway when someone starts a session to it.</div>
              : (
                <ul className="flex flex-col py-1">
                  {(st.held || []).map((h) => (
                    <li key={h.resourceId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1 text-sm">
                      <span className="min-w-0 break-words text-nb-gray-800 dark:text-nb-gray-100">
                        {h.name}{h.name !== h.address && <span className="text-nb-gray-500"> ({h.address})</span>}
                        <span className="text-[0.78rem] text-nb-gray-500"> - {h.network}</span>
                      </span>
                      <span className={h.inUse ? 'text-[0.78rem] font-medium text-green-600 dark:text-green-500' : 'text-[0.78rem] text-nb-gray-500'}>
                        {h.inUse ? 'In Use' : `Until ${formatTimestamp(h.expiresAt)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            <div className="text-[0.78rem] text-nb-gray-500 mt-1">{st.activeSessions} active session(s)</div>
          </>
        ) : <div className="text-sm text-red-500">The status could not be loaded.</div>}
      </div>

      {/* Main switches */}
      <label className={toggleCard}>
        <input type="checkbox" className="mt-1 accent-netbird" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        <div>
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Enable Browser Remote Access</div>
          <div className="text-[0.8rem] text-nb-gray-500">Turning it off closes every open session at once and disables the gateway's NetBird policy.</div>
        </div>
      </label>

      <Field label="Who Can Use It">
        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="radio" className="mt-1 accent-netbird" checked={!form.allowAll} onChange={() => set('allowAll', false)} />
            <span>Only users with the <b>Browser Remote Access</b> permission (Settings → Permissions)</span>
          </label>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="radio" className="mt-1 accent-netbird" checked={form.allowAll} onChange={() => set('allowAll', true)} />
            <span>Every signed-in user - each still reaches only what their own NetBird access allows</span>
          </label>
        </div>
      </Field>

      <Field label="Networks Open To The Gateway" hint="Servers in these networks can be opened from the browser: IPv4 host and subnet resources through the IP gateway, exact domain resources through the names gateway. A server joins its gateway's targets only when someone opens a session to it. Keep this list as small as possible, and don't open two networks whose host names can resolve to the same private address.">
        <div className={`${box} max-h-64 overflow-auto flex flex-col gap-1.5`}>
          {networksQ.isLoading ? <span className="text-sm text-nb-gray-500">Loading networks…</span>
            : (networksQ.data || []).length === 0 ? <span className="text-sm text-nb-gray-500">No networks found.</span>
              : (networksQ.data || []).map((n) => (
                <label key={n.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" className="accent-netbird" checked={form.networks.includes(n.id)} onChange={() => toggleNetwork(n.id)} />
                  <span>{n.name || n.id}</span>
                  {typeof n.resources === 'number' && <span className="text-[0.75rem] text-nb-gray-500">{n.resources} resources</span>}
                </label>
              ))}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Sessions Per User"><Input inputMode="numeric" value={String(form.maxSessionsPerUser)} onChange={(e) => set('maxSessionsPerUser', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
        <Field label="Sessions In Total"><Input inputMode="numeric" value={String(form.maxSessionsTotal)} onChange={(e) => set('maxSessionsTotal', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
        <Field label="Idle Timeout (Minutes)"><Input inputMode="numeric" value={String(form.idleTimeoutMin)} onChange={(e) => set('idleTimeoutMin', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
        <Field label="Maximum Session Length (Hours)"><Input inputMode="numeric" value={String(form.maxDurationHours)} onChange={(e) => set('maxDurationHours', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
        <Field label="Keep Opened Servers Available For (Hours)" hint="After a session starts, its server stays open to the gateway this long (1 to 72), so the next session to it opens at once. An open session keeps it open.">
          <Input inputMode="numeric" value={String(form.holdHours ?? 10)} onChange={(e) => set('holdHours', Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </Field>
      </div>

      <label className={toggleCard}>
        <input type="checkbox" className="mt-1 accent-netbird" checked={form.clipboard} onChange={(e) => set('clipboard', e.target.checked)} />
        <div>
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Allow Clipboard</div>
          <div className="text-[0.8rem] text-nb-gray-500">Copy and paste text between the browser and the remote session. File transfer is always off.</div>
        </div>
      </label>

      {/* How sessions look. Applies to sessions opened after saving. */}
      <div className={`${box} flex flex-col gap-4`}>
        <div>
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">RDP Display</div>
          <div className="text-[0.8rem] text-nb-gray-500">Applies to sessions opened after saving.</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Colors" hint="Below 32-bit, the RDP graphics pipeline (GFX) is turned off.">
            <Select value={String(form.rdp.colorDepth)} onChange={(e) => setRdp('colorDepth', Number(e.target.value))}>
              {opts.rdpColorDepths.map((d) => <option key={d} value={d}>{DEPTH_NAMES[d] || `${d}-Bit`}</option>)}
            </Select>
          </Field>
          <Field label="Keyboard Layout" hint="The layout of the remote server. Characters it doesn't have are sent as Unicode text.">
            <Select value={form.rdp.serverLayout} onChange={(e) => setRdp('serverLayout', e.target.value)}>
              {opts.rdpLayouts.map((l) => <option key={l} value={l}>{LAYOUT_NAMES[l] || l}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {RDP_EFFECTS.map((f) => (
            <label key={f.key} className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" className="mt-1 accent-netbird" checked={form.rdp[f.key]} onChange={(e) => setRdp(f.key, e.target.checked)} />
              <span>
                <span className="text-nb-gray-800 dark:text-nb-gray-100">{f.label}</span>
                <span className="block text-[0.78rem] text-nb-gray-500">{f.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="border-t border-nb-gray-200 dark:border-nb-gray-800 pt-3">
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">SSH Terminal</div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Font Size">
            <Input inputMode="numeric" value={String(form.ssh.fontSize)} onChange={(e) => setSsh('fontSize', Number(e.target.value.replace(/\D/g, '')) || 0)} />
          </Field>
          <Field label="Colors">
            <Select value={form.ssh.colorScheme} onChange={(e) => setSsh('colorScheme', e.target.value)}>
              {opts.sshColorSchemes.map((s) => <option key={s} value={s}>{SCHEME_NAMES[s] || s}</option>)}
            </Select>
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_8rem] gap-3">
        <Field label="guacd Address" hint="The IP gateway's guacd, as this app reaches it."><Input value={form.guacdHost} onChange={(e) => set('guacdHost', e.target.value)} /></Field>
        <Field label="guacd Port"><Input inputMode="numeric" value={String(form.guacdPort)} onChange={(e) => set('guacdPort', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
        <Field label="Names guacd Address" hint="The names gateway's guacd, as this app reaches it."><Input value={form.namesGuacdHost} onChange={(e) => set('namesGuacdHost', e.target.value)} /></Field>
        <Field label="Names guacd Port"><Input inputMode="numeric" value={String(form.namesGuacdPort)} onChange={(e) => set('namesGuacdPort', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
      </div>

      <Field label="SSH Host Keys" hint="Optional. When a server has a host key here, SSH sessions to it verify the key and refuse a mismatch. Without one, the server's identity is not verified. RDP server certificates are not verified.">
        <div className="flex flex-col gap-2">
          {keys.map((k, i) => (
            <div key={i} className={`${box} flex flex-col gap-2`}>
              <div className="flex gap-2">
                <Input placeholder="10.0.0.5 or server.example.com" value={k.address} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))} />
                <Button variant="ghost" onClick={() => setKeys(keys.filter((_, j) => j !== i))} aria-label="Remove host key"><Trash2 size={15} /></Button>
              </div>
              <Textarea placeholder="ssh-ed25519 AAAA…" rows={2} value={k.key} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            </div>
          ))}
          <div><Button size="sm" onClick={() => setKeys([...keys, { address: '', key: '' }])}><Plus size={14} /> Add Host Key</Button></div>
        </div>
      </Field>

      {/* Resources created by the launch API */}
      <div className={`${box} flex flex-col gap-4`}>
        <div>
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Resources Created By The API</div>
          <div className="text-[0.8rem] text-nb-gray-500">
            A launch request through the API can create a resource for a public server that NetBird has none for. It joins the group below, where an admin
            policy decides who can reach it, and it is removed after the hold time once nobody uses it.
          </div>
          <a href={docsUrl(version, 'docs/api.md#creating-a-missing-resource-createresource')} target="_blank" rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-[0.8rem] font-medium text-netbird hover:underline">
            API Documentation <ExternalLink size={12} />
          </a>
        </div>
        {crReadonly && <div className="text-[0.8rem] text-nb-gray-500">This instance is read-only, so these settings can't be changed here.</div>}

        <label className={`${toggleCard} ${crReadonly ? 'cursor-default! opacity-70' : ''}`}>
          <input type="checkbox" className="mt-1 accent-netbird" checked={cr.enabled} disabled={crReadonly} onChange={(e) => setCr({ enabled: e.target.checked })} />
          <div>
            <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Create Missing Resources From The API</div>
            <div className="text-[0.8rem] text-nb-gray-500">Off by default. The API key also needs the Create Missing Resources permission (Settings → API Keys).</div>
          </div>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Network" hint="One of the networks open to the gateway above. The app manages it: other changes to it are refused.">
            <Select value={cr.networkId} disabled={crReadonly} onChange={(e) => setCr({ networkId: e.target.value })}>
              <option value="">Choose A Network</option>
              {crNetworks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
              {cr.networkId && !form.networks.includes(cr.networkId) && (
                <option value={cr.networkId}>{netName(cr.networkId)} (not open to the gateway)</option>
              )}
            </Select>
          </Field>
          <Field label="Group" hint="Created resources join this group. Give it an admin policy in NetBird to decide who can reach them.">
            <Select value={cr.groupId} disabled={crReadonly} onChange={(e) => setCr({ groupId: e.target.value })}>
              <option value="">{groupsQ.isLoading ? 'Loading Groups…' : 'Choose A Group'}</option>
              {crGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              {cr.groupId && !crGroups.some((g) => g.id === cr.groupId) && (
                <option value={cr.groupId}>{groupName(cr.groupId)}{groupsQ.isLoading ? '' : ' (not available)'}</option>
              )}
            </Select>
          </Field>
          <Field label="Maximum Active Created Resources" hint="1 to 500. The API creates no more resources while this many exist.">
            <Input inputMode="numeric" value={String(cr.max)} disabled={crReadonly} onChange={(e) => setCr({ max: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          </Field>
        </div>

        <div className="border-t border-nb-gray-200 dark:border-nb-gray-800 pt-3">
          <div className="text-[0.75rem] font-semibold uppercase tracking-wide text-nb-gray-500 mb-1">Created Resources</div>
          {createdQ.isLoading ? <div className="text-[0.8rem] text-nb-gray-500 py-1.5">Loading…</div>
            : !created ? <div className="text-sm text-red-500 py-1.5">The list could not be loaded.</div>
              : created.items.length === 0 ? <div className="text-[0.8rem] text-nb-gray-500 py-1.5">None right now.</div>
                : (
                  <div>
                    <div className={`${createdCols} hidden sm:grid py-1.5 text-[0.72rem] font-medium uppercase tracking-wide text-nb-gray-500`}>
                      <span>Address</span><span>Name</span><span>Created</span><span>State</span>
                    </div>
                    <ul>
                      {created.items.map((it) => {
                        const s = CREATED_STATES[it.state] || { label: it.state, tone: 'text-nb-gray-500' };
                        const cellLabel = 'sm:hidden block text-[0.7rem] uppercase tracking-wide text-nb-gray-500';
                        return (
                          <li key={it.id} className={`${createdCols} py-2 border-t border-nb-gray-100 dark:border-nb-gray-900 text-sm`}>
                            <div className="min-w-0">
                              <span className={cellLabel}>Address</span>
                              <span className="font-mono text-[0.82rem] break-all text-nb-gray-800 dark:text-nb-gray-100" title={it.resourceName || undefined}>{it.address}</span>
                            </div>
                            <div className="min-w-0">
                              <span className={cellLabel}>Name</span>
                              <span className="break-words text-nb-gray-700 dark:text-nb-gray-200">{it.name || '-'}</span>
                            </div>
                            <div className="min-w-0">
                              <span className={cellLabel}>Created</span>
                              <span className="text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-400">{it.createdAt ? formatTimestamp(it.createdAt) : '-'}</span>
                            </div>
                            <div className="min-w-0">
                              <span className={cellLabel}>State</span>
                              <span className={`text-[0.8rem] font-medium ${s.tone}`}>{s.label}</span>
                              {CREATED_REASON_STATES.includes(it.state) && it.reason && (
                                <span className="block text-[0.76rem] text-nb-gray-500 break-words">{it.reason}</span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {created.finishedMore && (
                      <div className="pt-2 text-[0.76rem] text-nb-gray-500">Only the latest 50 finished entries are shown.</div>
                    )}
                  </div>
                )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        {saved && <span className="text-sm text-green-600 dark:text-green-500">{saved}</span>}
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>

      {/* Enrollment */}
      <div className={box}>
        <div className="text-sm font-semibold mb-1 text-nb-gray-800 dark:text-nb-gray-100">Enroll The Gateways</div>
        <p className="text-[0.82rem] text-nb-gray-500 mb-3">
          Each button creates a one-time NetBird setup key (valid for 1 day) for one gateway.
          Put it in <code>.env</code> as <code>REMOTE_GATEWAY_SETUP_KEY</code> or <code>REMOTE_NAMES_GATEWAY_SETUP_KEY</code> and keep it there:
          the gateway needs it at every start, and a used key can't enroll anything else. Then start the gateways
          with <code>netbird-docker-compose-files/docker-compose-remote-access.yml</code>. docs/remote-access.md has the steps and the host firewall rules.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => createKey('ip')} disabled={!!keyBusy || form.readonly}><KeyRound size={15} /> {keyBusy === 'ip' ? 'Creating…' : 'Create IP Gateway Setup Key'}</Button>
          <Button onClick={() => createKey('names')} disabled={!!keyBusy || form.readonly}><KeyRound size={15} /> {keyBusy === 'names' ? 'Creating…' : 'Create Names Gateway Setup Key'}</Button>
        </div>
        {setupKey && (
          <div className="mt-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/40 p-3">
            <div className="text-[0.8rem] text-nb-gray-500 mb-1">{setupKey.kind === 'names' ? 'REMOTE_NAMES_GATEWAY_SETUP_KEY' : 'REMOTE_GATEWAY_SETUP_KEY'} - shown once. Copy it now.</div>
            <div className="flex items-center gap-2">
              <code className="text-sm break-all">{setupKey.key}</code>
              <CopyButton value={setupKey.key} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
