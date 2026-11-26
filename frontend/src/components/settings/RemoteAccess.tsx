import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, KeyRound, Plus, Server, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAccessProfiles, useNetworks } from '@/lib/queries';
import { remoteApi, type CreateResourcesConfig, type LaunchNetworkResult, type RdpDisplay, type RemoteAccessConfig, type SshTerminal } from '@/lib/remoteAccess';
import { Badge, Button, Card, CopyButton, Field, Input, LoadingState, Select, SelectMenu, Textarea, type SelectOption } from '@/components/ui';
import { LaunchNetworkRow, StepRow } from './LaunchNetworkPanel';
import { Toggle } from './NetbirdFields';
import { StatusLine, gatewaysSummary } from '@/components/admin/RemoteAccessOps';

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

const CREATE_DEFAULTS: CreateResourcesConfig = { enabled: false, networkId: '', profileId: 0, groupId: '', max: 50 };

const box = 'rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-4';
const toggleCard = 'flex items-start gap-3 p-3.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/30 cursor-pointer';

export function RemoteAccessSettings() {
  const qc = useQueryClient();
  const cfgQ = useQuery({ queryKey: ['remote-access-config'], queryFn: remoteApi.config });
  const statusQ = useQuery({ queryKey: ['remote-access-status'], queryFn: remoteApi.status, refetchInterval: 30000 });
  const networksQ = useNetworks();
  const profilesQ = useAccessProfiles();
  const createdQ = useQuery({ queryKey: ['remote-access-created'], queryFn: remoteApi.createdResources, refetchInterval: 30000 });
  const [form, setForm] = useState<RemoteAccessConfig | null>(null);
  const [keys, setKeys] = useState<{ address: string; key: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [setupKey, setSetupKey] = useState<{ kind: 'ip' | 'names'; key: string; expires: string } | null>(null);
  const [keyBusy, setKeyBusy] = useState<'' | 'ip' | 'names'>('');
  // As last loaded or saved: the section is sent only when it changed.
  const [savedCr, setSavedCr] = useState<CreateResourcesConfig | null>(null);

  useEffect(() => {
    if (cfgQ.data && !form) {
      setForm(cfgQ.data);
      setSavedCr(cfgQ.data.createResources || CREATE_DEFAULTS);
      setKeys(Object.entries(cfgQ.data.sshHostKeys || {}).map(([address, key]) => ({ address, key })));
    }
  }, [cfgQ.data, form]);

  if (cfgQ.isLoading || !form) return <LoadingState />;
  const set = <K extends keyof RemoteAccessConfig>(k: K, v: RemoteAccessConfig[K]) => { setForm({ ...form, [k]: v }); setSaved(''); };
  const st = statusQ.data;
  const cr = form.createResources || CREATE_DEFAULTS;
  const setCr = (patch: Partial<CreateResourcesConfig>) => set('createResources', { ...cr, ...patch });
  const crKey = (c: CreateResourcesConfig) => JSON.stringify([!!c.enabled, Number(c.profileId) || 0, Number(c.max)]);
  const crChanged = crKey(cr) !== crKey(savedCr || CREATE_DEFAULTS);
  // The network's Managed By Remote Access badge follows these settings too.
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
        ...(crChanged ? { createResources: { enabled: cr.enabled, profileId: Number(cr.profileId) || 0, max: Number(cr.max) } } : {}),
      });
      setForm(r.config);
      // The form starts from the cache when this page is opened again.
      qc.setQueryData<RemoteAccessConfig>(['remote-access-config'], (old) => ({ ...old, ...r.config }));
      setSavedCr(r.config.createResources || CREATE_DEFAULTS);
      setSaved(r.sync?.removed ? `Saved. NetBird updated: ${r.sync.removed} server(s) taken off the gateways.` : 'Saved.');
      qc.invalidateQueries({ queryKey: ['remote-access-status'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      refreshCreated();
    } catch (e) {
      // Any status but the 502 of a failed NetBird update is a refusal: nothing was saved.
      if (e instanceof ApiError && e.status !== 502) {
        setError(e.message);
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

  // It always stays open to the gateway (the server keeps it too).
  const launchNetworkId = (savedCr || CREATE_DEFAULTS).networkId;
  const toggleNetwork = (id: string) => {
    if (id === launchNetworkId) return;
    set('networks', form.networks.includes(id) ? form.networks.filter((n) => n !== id) : [...form.networks, id]);
  };
  // Only what the network action changed is applied; other unsaved edits stay.
  const onLaunchNetwork = (r: Pick<LaunchNetworkResult, 'config'>) => {
    const newId = r.config.createResources.networkId;
    const off = newId ? {} : { enabled: false };
    setForm((f) => f && ({
      ...f,
      networks: newId ? [...f.networks.filter((n) => n !== newId), newId] : f.networks,
      createResources: { ...(f.createResources || CREATE_DEFAULTS), networkId: newId, ...off },
    }));
    setSavedCr((s) => ({ ...(s || CREATE_DEFAULTS), networkId: newId, ...off }));
    // The form starts from the cache when this page is opened again.
    qc.setQueryData<RemoteAccessConfig>(['remote-access-config'], (old) => old && ({ ...old, networks: r.config.networks, createResources: r.config.createResources }));
    refreshCreated();
  };

  const created = createdQ.data;
  const crReadonly = !!form.readonly || !!created?.readonly;
  const managedIds = new Set(Object.values(form.managed || {}).filter(Boolean));
  const sharedProfiles = (profilesQ.data || []).filter((p) => p.shared).sort((a, b) => a.name.localeCompare(b.name));
  const chosenProfile = sharedProfiles.find((p) => p.id === Number(cr.profileId));
  // A saved profile that no longer fits stays visible, so the server's refusal explains it.
  const profileOptions: SelectOption[] = [
    { value: '0', label: 'None' },
    ...sharedProfiles.map((p) => ({ value: String(p.id), label: p.name })),
    ...(cr.profileId && !chosenProfile && !profilesQ.isLoading ? [{ value: String(cr.profileId), label: `Profile #${cr.profileId} (not available)` }] : []),
  ];
  const savedCrNow = savedCr || CREATE_DEFAULTS;
  const crInUse = (created?.items || []).filter((i) => ['creating', 'unknown', 'created', 'kept'].includes(i.state)).length;
  const crNetMissing = !!launchNetworkId && networksQ.isSuccess && !(networksQ.data || []).some((n) => n.id === launchNetworkId);
  const crReady = !!launchNetworkId && !crNetMissing && !!Number(cr.profileId);
  const crStatus = !launchNetworkId || !Number(savedCrNow.profileId) ? 'Not Set Up' : savedCrNow.enabled ? 'On' : 'Off';
  const crSwitchLocked = crReadonly || (!cr.enabled && !crReady);

  return (
    <div className="max-w-2xl flex flex-col gap-5">
      <p className="text-nb-gray-500 text-sm">
        Let users open RDP and SSH sessions from the browser through the Browser Gateway - NetBird peers next to this app.
        Each session is checked against the user's own NetBird access. The gateways reach only servers in the networks you pick here,
        once someone has opened a session to them, unless one of your NetBird policies lets them reach more. Servers added by launch links are
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

      <Card className="px-4 py-2">
        {statusQ.isLoading ? <StatusLine ok={null} label="Checking The Gateways…" />
          : st ? (() => {
            const g = gatewaysSummary(st);
            return <StatusLine ok={g.ok} warn={g.warn} label={g.label} detail={g.ok ? undefined : 'Details in Operations → Remote Access.'} />;
          })()
            : <StatusLine ok={false} label="The Status Could Not Be Loaded" />}
      </Card>

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
              : (networksQ.data || []).map((n) => {
                const locked = n.id === launchNetworkId;
                return (
                  <label key={n.id} className={`flex items-center gap-2 text-sm ${locked ? 'cursor-default' : 'cursor-pointer'}`}>
                    <input type="checkbox" className="accent-netbird" checked={locked || form.networks.includes(n.id)} disabled={locked} onChange={() => toggleNetwork(n.id)} />
                    <span>{n.name || n.id}</span>
                    {typeof n.resources === 'number' && <span className="text-[0.75rem] text-nb-gray-500">{n.resources} resources</span>}
                    {locked && <span className="text-[0.75rem] font-medium text-nb-blue-600 dark:text-nb-blue-400">Used by launch links</span>}
                  </label>
                );
              })}
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

      <Card className="flex flex-col gap-4 p-4">
        <div>
          <div className="text-sm font-bold tracking-tight text-nb-gray-800 dark:text-nb-gray-100">RDP Display</div>
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
      </Card>

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

      <Card className="overflow-hidden">
        <div className="flex items-start gap-3.5 p-4 sm:p-5">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-netbird/10 text-netbird"><Server size={20} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold text-nb-gray-900 dark:text-nb-gray-50">Servers From Launch Links</h3>
              <Badge tone={crStatus === 'On' ? 'green' : 'gray'}>{crStatus}</Badge>
              {crNetMissing && <Badge tone="orange" icon={<AlertTriangle size={11} />}>Network Missing</Badge>}
            </div>
            <p className="mt-0.5 text-[0.82rem] text-nb-gray-500 dark:text-nb-gray-400">Launch links can add a public server NetBird doesn't have yet. It's removed after the hold time.</p>
          </div>
          <div className="ml-auto flex shrink-0 flex-col items-end gap-1.5">
            <label className="inline-flex">
              <span className="sr-only">Add Missing Servers From Launch Links</span>
              <Toggle checked={cr.enabled} disabled={crSwitchLocked} onChange={(v) => setCr({ enabled: v })} />
            </label>
            {!cr.enabled && !crReady && !crReadonly && (
              <span className="max-w-[180px] text-right text-[0.72rem] leading-snug text-nb-gray-500">Set a network and an Access Profile to turn this on.</span>
            )}
          </div>
        </div>
        {crReadonly && <p className="px-4 pb-3 sm:px-5 text-[0.8rem] text-nb-gray-500">This instance is read-only, so these settings can't be changed here.</p>}

        <LaunchNetworkRow networkId={launchNetworkId} readonly={crReadonly} managedGroupIds={managedIds} onDone={onLaunchNetwork}
          inUse={crInUse} done={!!launchNetworkId && !crNetMissing} />

        <StepRow n={2} done={!!chosenProfile} label="Who Can Reach Them" actions={(
          <Link className="text-[0.82rem] font-medium text-netbird hover:underline underline-offset-4" to="/operations?tab=profiles">Manage Access Profiles</Link>
        )}>
          <div className="max-w-xs">
            <SelectMenu options={profileOptions} value={String(Number(cr.profileId) || 0)} disabled={crReadonly}
              placeholder={profilesQ.isLoading ? 'Loading Profiles…' : 'Choose Access Profile'}
              onChange={(v) => setCr({ profileId: Number(v) || 0 })} />
          </div>
          {!Number(cr.profileId) && !!cr.groupId && (
            <div className="mt-1.5 text-[0.78rem] text-amber-700 dark:text-amber-400">Choose an Access Profile before turning this on.</div>
          )}
        </StepRow>

        <StepRow n={3} done={crReady} label="Limit">
          <div className="flex flex-wrap items-center gap-2 text-sm text-nb-gray-700 dark:text-nb-gray-200">
            Up to
            <Input inputMode="numeric" aria-label="Most servers at a time (1 to 500)" className="w-16 text-center font-semibold" value={String(cr.max)} disabled={crReadonly}
              onChange={(e) => setCr({ max: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            servers at a time
          </div>
        </StepRow>

        <div className="flex items-center gap-2 border-t border-nb-gray-100 dark:border-nb-gray-900 bg-nb-gray-50 dark:bg-nb-gray-900/40 px-4 py-3 sm:px-5 text-[0.78rem] text-nb-gray-500 dark:text-nb-gray-400">
          <KeyRound size={13} className="shrink-0" /> The API key also needs the Create Missing Resources permission (Settings → API Keys).
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        {saved && <span className="text-sm text-green-600 dark:text-green-500">{saved}</span>}
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>

      <Card className="p-4">
        <div className="text-sm font-bold tracking-tight mb-1 text-nb-gray-800 dark:text-nb-gray-100">Enroll The Gateways</div>
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
      </Card>
    </div>
  );
}
