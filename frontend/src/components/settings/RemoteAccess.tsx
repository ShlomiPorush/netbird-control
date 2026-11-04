import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, KeyRound, Plus, Trash2, XCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useNetworks } from '@/lib/queries';
import { remoteApi, type RdpDisplay, type RemoteAccessConfig, type SshTerminal } from '@/lib/remoteAccess';
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
  const [form, setForm] = useState<RemoteAccessConfig | null>(null);
  const [keys, setKeys] = useState<{ address: string; key: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [setupKey, setSetupKey] = useState<{ kind: 'ip' | 'names'; key: string; expires: string } | null>(null);
  const [keyBusy, setKeyBusy] = useState<'' | 'ip' | 'names'>('');

  useEffect(() => {
    if (cfgQ.data && !form) {
      setForm(cfgQ.data);
      setKeys(Object.entries(cfgQ.data.sshHostKeys || {}).map(([address, key]) => ({ address, key })));
    }
  }, [cfgQ.data, form]);

  if (cfgQ.isLoading || !form) return <LoadingState />;
  const set = <K extends keyof RemoteAccessConfig>(k: K, v: RemoteAccessConfig[K]) => { setForm({ ...form, [k]: v }); setSaved(''); };
  const st = statusQ.data;

  const save = async () => {
    setSaving(true); setError(''); setSaved('');
    try {
      const sshHostKeys = Object.fromEntries(keys.filter((k) => k.address.trim() && k.key.trim()).map((k) => [k.address.trim(), k.key.trim()]));
      const r = await remoteApi.saveConfig({
        enabled: form.enabled, allowAll: form.allowAll, guacdHost: form.guacdHost, guacdPort: Number(form.guacdPort),
        namesGuacdHost: form.namesGuacdHost, namesGuacdPort: Number(form.namesGuacdPort),
        networks: form.networks, maxSessionsPerUser: Number(form.maxSessionsPerUser), maxSessionsTotal: Number(form.maxSessionsTotal),
        idleTimeoutMin: Number(form.idleTimeoutMin), maxDurationHours: Number(form.maxDurationHours), clipboard: form.clipboard, sshHostKeys,
        rdp: form.rdp, ssh: { ...form.ssh, fontSize: Number(form.ssh.fontSize) },
      });
      setForm(r.config);
      setSaved(r.sync ? `Saved. NetBird updated: ${r.sync.added} resource(s) added to the gateway, ${r.sync.removed} removed.` : 'Saved.');
      qc.invalidateQueries({ queryKey: ['remote-access-status'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} The settings were saved; NetBird was not fully updated.` : 'Saving failed.');
      qc.invalidateQueries({ queryKey: ['remote-access-config'] });
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

  return (
    <div className="max-w-2xl flex flex-col gap-5">
      <p className="text-nb-gray-500 text-sm">
        Let users open RDP and SSH sessions from the browser through the Browser Gateway - NetBird peers next to this app.
        Each session is checked against the user's own NetBird access; the gateways can only reach the networks you pick here.
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
              detail={st.guacdReachable ? `${form.guacdHost}:${form.guacdPort}` : `No answer from ${form.guacdHost}:${form.guacdPort}. Are the gateway containers running (docker-compose.remote-access.yml)?`} />
            <StatusLine ok={st.targets > 0} warn label={`${st.targets} Resource${st.targets === 1 ? '' : 's'} Open To The Gateway`} />
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
            {st.names.gateway.enrolled && <StatusLine ok={st.names.targets > 0} warn label={`${st.names.targets} Domain Resource${st.names.targets === 1 ? '' : 's'} Open To The Names Gateway`} />}
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
            {(st.error || st.lastApply.error) && <StatusLine ok={false} label="Problem" detail={st.error || st.lastApply.error} />}
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

      <Field label="Networks Open To The Gateway" hint="IPv4 host and subnet resources of these networks join the IP gateway's target group, and their domain resources join the names gateway's. Keep this list as small as possible, and don't open two networks whose host names can resolve to the same private address.">
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
          with <code>docker-compose.remote-access.yml</code>. docs/remote-access.md has the steps and the host firewall rules.
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
