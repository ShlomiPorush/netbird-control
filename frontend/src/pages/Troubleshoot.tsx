import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Play, X, MonitorSmartphone, Globe, Route, History, Check, Loader2, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api, getTenantMode } from '@/lib/api';
import { usePeers, useDiagnosticsInfo, useDiagNotices } from '@/lib/queries';
import { useNetbirdRefresh, useDismissNbNotice } from '@/lib/mutations';
import { useViewer } from '@/contexts/ViewerContext';
import { formatTimestamp } from '@/lib/logfmt';
import type { DeviceDiagnosis, DiagCheck, GrantTarget, TargetDiagnosis } from '@/lib/types';
import { Badge, Button, PageHeader, SelectMenu } from '@/components/ui';
import { TargetSearch } from '@/components/access/TargetSearch';

/* ─── Browser-side probes - these test the USER's network, which the server cannot see ─── */

// TCP+TLS reachability of an HTTPS host. An opaque (no-cors) response still proves the
// connection completed; only a network-level failure rejects.
async function httpsProbe(host: string, timeoutMs = 8000): Promise<{ ok: boolean; ms?: number }> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(`https://${host}/`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return { ok: true, ms: Math.round(performance.now() - t0) };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// Real STUN binding via WebRTC: a server-reflexive ICE candidate proves UDP works
// end-to-end from this network, and carries the public IP the STUN server saw.
// `gathered` reports whether ICE produced ANY candidate - separates "UDP blocked on the
// network" (candidates, no srflx) from "WebRTC blocked in the browser" (nothing at all).
interface StunResult { ok: boolean; publicIp?: string; ms?: number; gathered: boolean }
function stunProbe(host: string, port = 3478, timeoutMs = 8000): Promise<StunResult> {
  return new Promise((resolve) => {
    let done = false;
    let gathered = false;
    let pc: RTCPeerConnection | null = null;
    const t0 = performance.now();
    const finish = (r: StunResult) => {
      if (done) return;
      done = true;
      try { pc?.close(); } catch { /* already closed */ }
      resolve(r);
    };
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:${host}:${port}` }] });
    } catch {
      finish({ ok: false, gathered: false });
      return;
    }
    pc.createDataChannel('probe');
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      gathered = true;
      const c = e.candidate.candidate || '';
      if (c.includes(' typ srflx')) {
        finish({ ok: true, publicIp: c.split(' ')[4], ms: Math.round(performance.now() - t0), gathered: true });
      }
    };
    setTimeout(() => finish({ ok: false, gathered }), timeoutMs);
    pc.createOffer().then((o) => pc!.setLocalDescription(o)).catch(() => finish({ ok: false, gathered }));
  });
}

/* ─── Result rendering ─── */

const STATUS_STYLE: Record<DiagCheck['status'], string> = {
  PASS: 'bg-green-500/10 text-green-600 dark:text-green-500 border-green-500/30',
  WARN: 'bg-amber-500/10 text-amber-600 dark:text-amber-500 border-amber-500/30',
  FAIL: 'bg-red-500/10 text-red-600 dark:text-red-500 border-red-500/30',
  INFO: 'bg-nb-gray-100 text-nb-gray-600 border-nb-gray-200 dark:bg-nb-gray-900 dark:text-nb-gray-300 dark:border-nb-gray-800/50',
};

function CheckRow({ c }: { c: DiagCheck }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-nb-gray-100 dark:border-nb-gray-900 last:border-0">
      <span className={cn('inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-[0.7rem] font-semibold tracking-wide w-14 justify-center', STATUS_STYLE[c.status])}>
        {c.status}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-nb-gray-900 dark:text-nb-gray-100">{c.label}</div>
        <div className="text-[0.82rem] text-nb-gray-600 dark:text-nb-gray-300">
          {c.detail}
          {c.at && <span className="text-nb-gray-500"> · {formatTimestamp(c.at)}</span>}
        </div>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: JSX.Element; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100 mb-1">
        {icon}{title}
      </div>
      {children}
    </div>
  );
}

export default function Troubleshoot() {
  const [params] = useSearchParams();
  // While managing a tenant the Request Access shortcut is hidden - requesting access is a
  // MAIN-account feature (the server refuses it in tenant context).
  const inTenant = !!getTenantMode();
  // own=true: a non-admin picks only among THEIR devices, even with View All Peers. In tenant
  // mode the server elevates the support user to admin, so this returns ALL tenant peers - and
  // the browser-IP auto-match simply finds nothing, so the picker just waits for a choice.
  const peers = usePeers(true, true).data || [];
  const info = useDiagnosticsInfo().data;
  const notices = useDiagNotices().data?.notices || [];

  // The peers cache can lag behind reality - a connected device showing "offline" in
  // the picker undermines the whole page. Re-pull from NetBird once on entry (the
  // mutation invalidates every query, so the list refetches by itself).
  const refresh = useNetbirdRefresh();
  useEffect(() => {
    refresh.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [peerId, setPeerId] = useState('');
  // The downloadable diagnostics script is Windows-only PowerShell - only surface it for a
  // selected Windows device (the OS string is self-reported, e.g. "Windows 11").
  const isWindowsDevice = /windows/i.test(peers.find((p) => p.id === peerId)?.os || '');
  const [addr, setAddr] = useState(''); // free-typed address (set by pressing Enter in the search field)
  const [target, setTarget] = useState<GrantTarget | null>(null);
  const [running, setRunning] = useState(false);
  // The average user only needs the verdict - the full PASS/FAIL sections are opt-in.
  const [showDetails, setShowDetails] = useState(false);
  const [steps, setSteps] = useState<{ key: string; label: string; done: boolean }[] | null>(null);
  const [browserChecks, setBrowserChecks] = useState<DiagCheck[] | null>(null);
  const [device, setDevice] = useState<DeviceDiagnosis | null>(null);
  const [targetDiag, setTargetDiag] = useState<TargetDiagnosis | null>(null);
  const [error, setError] = useState('');

  // Preselect: ?peer= deep link → IP-matched device → the only device there is.
  useEffect(() => {
    if (peerId) return;
    const fromUrl = params.get('peer');
    if (fromUrl && peers.some((p) => p.id === fromUrl)) { setPeerId(fromUrl); return; }
    if (info?.matches.length === 1) { setPeerId(info.matches[0].id); return; }
    if (peers.length === 1) setPeerId(peers[0].id);
  }, [params, peers, info, peerId]);

  // Grouped picker: the viewer's own devices first, then everyone else's (support view).
  // Subtitle = owner (or Server + IP) - shown as a second line AND searchable, so support
  // can find a device by typing the user's name.
  const { viewer, isAdmin } = useViewer();
  const dismissNotice = useDismissNbNotice();
  const deviceOptions = useMemo(() => {
    const email = (viewer?.email || '').toLowerCase();
    const uid = viewer?.user_id || '';
    const isMine = (p: (typeof peers)[number]) => !!(
      (uid && (p.user_id === uid || String(p.user_id || '').endsWith(`|${uid}`)))
      || (email && (p.owner_email || '').toLowerCase() === email)
    );
    const toOpt = (p: (typeof peers)[number]) => ({
      value: p.id,
      label: `${p.name}${p.connected ? '' : ' (offline)'}`,
      subtitle: p.kind === 'server'
        ? `Server${p.ip ? ` · ${p.ip}` : ''}`
        : `${p.owner_name || p.owner_email || 'No owner'}${p.ip ? ` · ${p.ip}` : ''}`,
    });
    const byName = (a: (typeof peers)[number], b: (typeof peers)[number]) => (a.name || '').localeCompare(b.name || '');
    const mine = peers.filter(isMine).sort(byName);
    const others = peers.filter((p) => !isMine(p)).sort(byName);
    const opts: { value: string; label: string; subtitle?: string; heading?: boolean }[] = [{ value: '', label: 'Select a device…' }];
    if (mine.length && others.length) {
      opts.push({ value: '__h_mine', label: 'My Devices', heading: true }, ...mine.map(toOpt));
      opts.push({ value: '__h_others', label: 'All Other Devices', heading: true }, ...others.map(toOpt));
    } else {
      opts.push(...mine.map(toOpt), ...others.map(toOpt));
    }
    return opts;
  }, [peers, viewer]);

  const run = async () => {
    if (!peerId || running) return;
    setRunning(true);
    setError('');
    setShowDetails(false);
    setBrowserChecks(null);
    setDevice(null);
    setTargetDiag(null);
    const hosts = info?.hosts || { management: 'api.netbird.io', signal: 'signal.netbird.io', stun: 'stun.netbird.io' };
    const peerName = peers.find((p) => p.id === peerId)?.name || 'device';
    const freeAddr = addr.trim();
    const tgtLabel = target?.name || freeAddr;

    // Every probe runs concurrently; each ticks its own step off as it lands, so the
    // progress list is honest (slow probes visibly stay "checking" until their timeout).
    const defs = [
      { key: 'device', label: `Device state - ${peerName} (server view)` },
      { key: 'mgmt', label: `Management server - ${hosts.management}` },
      { key: 'signal', label: `Signal server - ${hosts.signal}` },
      { key: 'stun', label: 'STUN / UDP (WebRTC, this browser)' },
      ...(tgtLabel ? [{ key: 'tgt', label: `Access path - ${tgtLabel}` }] : []),
    ];
    setSteps(defs.map((d) => ({ ...d, done: false })));
    const tick = (key: string) => setSteps((s) => s && s.map((x) => (x.key === key ? { ...x, done: true } : x)));
    const track = <T,>(key: string, p: Promise<T>): Promise<T> => p.finally(() => tick(key));

    try {
      const [mgmt, signal, stunNbAll, stunRef, dev, tgt] = await Promise.all([
        track('mgmt', httpsProbe(hosts.management)),
        track('signal', httpsProbe(hosts.signal)),
        // Per docs.netbird.io/about-netbird/ports-and-firewalls, NetBird's STUN answers on
        // UDP 80/443/3478/5555 - any one working port is enough. A reference server (Google)
        // is probed too, separating "NetBird STUN blocked" / "all UDP blocked" / "WebRTC blocked".
        track('stun', Promise.all([3478, 5555, 443, 80].map((p) => stunProbe(hosts.stun, p).then((r) => ({ ...r, port: p }))))),
        stunProbe('stun.l.google.com', 19302),
        track('device', api.get<DeviceDiagnosis>('/api/diagnostics/device', { peer_id: peerId })),
        freeAddr
          ? track('tgt', api.get<TargetDiagnosis>('/api/diagnostics/address', { peer_id: peerId, address: freeAddr }))
          : target
            ? track('tgt', api.get<TargetDiagnosis>('/api/diagnostics/target', { peer_id: peerId, type: target.type, id: target.id }))
            : Promise.resolve(null),
      ]);
      const stunNb = stunNbAll.find((r) => r.ok);
      const nbGathered = stunNbAll.some((r) => r.gathered);
      let stunRow: DiagCheck;
      if (stunNb) {
        stunRow = {
          key: 'b-stun', label: 'STUN (UDP)', status: 'PASS',
          detail: `Binding response on UDP ${stunNb.port} (${stunNb.ms} ms)${stunNb.publicIp ? ` - public IP ${stunNb.publicIp}` : ''}${stunNb.port !== 3478 ? '. Port 3478 did not answer - fine, NetBird also uses 80/443/5555' : ''}`,
        };
      } else if (stunRef.ok) {
        stunRow = { key: 'b-stun', label: 'STUN (UDP)', status: 'WARN', detail: `${hosts.stun} did not answer on any port (80/443/3478/5555), but a reference STUN server (Google) did - UDP works here, so a firewall rule is likely blocking NetBird's STUN specifically` };
      } else if (nbGathered || stunRef.gathered) {
        stunRow = { key: 'b-stun', label: 'STUN (UDP)', status: 'WARN', detail: 'No response from ANY STUN server - outbound UDP appears blocked on this network; direct (P2P) connections may fail and traffic will fall back to relay (slower, but works)' };
      } else {
        stunRow = { key: 'b-stun', label: 'STUN (UDP)', status: 'WARN', detail: 'WebRTC produced no candidates at all - a browser extension, privacy setting or policy is blocking WebRTC (common with ad/privacy blockers). Try another browser or a private window, or run the downloadable script for a network-level UDP test' };
      }
      setBrowserChecks([
        mgmt.ok
          ? { key: 'b-mgmt', label: 'Management Server', status: 'PASS', detail: `Reached ${hosts.management} over HTTPS (${mgmt.ms} ms) from this browser` }
          : { key: 'b-mgmt', label: 'Management Server', status: 'FAIL', detail: `Could not reach ${hosts.management}:443 from this network - a firewall or proxy here is blocking it` },
        signal.ok
          ? { key: 'b-signal', label: 'Signal Server', status: 'PASS', detail: `Reached ${hosts.signal} over HTTPS (${signal.ms} ms) from this browser` }
          : { key: 'b-signal', label: 'Signal Server', status: 'FAIL', detail: `Could not reach ${hosts.signal}:443 from this network - a firewall or proxy here is blocking it` },
        stunRow,
      ]);
      setDevice(dev);
      setTargetDiag(tgt);
    } catch (e) {
      setError((e as Error).message || 'Diagnostics failed');
    } finally {
      setRunning(false);
      setSteps(null);
    }
  };

  // "Open Request Access" carries the diagnosed target along, so the user doesn't have
  // to search for it again on the request page. An address check resolves to the covering
  // resource - the returned target is preferred, so even a raw IP arrives as the resource.
  const requestLink = useMemo(() => {
    const resolved = targetDiag?.target && targetDiag.target.id
      ? {
        type: targetDiag.target.type as GrantTarget['type'], id: targetDiag.target.id, name: targetDiag.target.name,
        networkId: targetDiag.target.networkId, resourceType: targetDiag.target.resourceType, access: undefined,
      }
      : target;
    if (!resolved) return '/request-access';
    const p = new URLSearchParams({ type: resolved.type, id: resolved.id, name: resolved.name });
    if (resolved.networkId) p.set('networkId', resolved.networkId);
    if (resolved.resourceType) p.set('resourceType', resolved.resourceType);
    if (resolved.access) p.set('access', JSON.stringify(resolved.access));
    return `/request-access?${p.toString()}`;
  }, [target, targetDiag]);

  // Verdict: every FAIL/WARN from all three sources, most severe first.
  const allChecks = useMemo(() => [
    ...(device?.checks || []),
    ...(browserChecks || []),
    ...(targetDiag?.findings || []),
  ], [device, browserChecks, targetDiag]);
  const fails = allChecks.filter((c) => c.status === 'FAIL');
  const warns = allChecks.filter((c) => c.status === 'WARN');
  const ran = browserChecks !== null || device !== null;

  // One plain-language conclusion for non-technical users: what is wrong, whose fault
  // it is, and the single next step. First matching rule wins (most fundamental first);
  // the technical rows stay below as "Details".
  const verdict = useMemo((): { tone: 'ok' | 'warn' | 'bad'; headline: string; todo: string; button?: { label: string; to: string } } | null => {
    if (!ran) return null;
    const fail = (key: string) => allChecks.some((c) => c.key === key && c.status === 'FAIL');
    if (fail('compliance')) return {
      tone: 'bad', headline: 'Your device is blocked by the organization\'s security checks.',
      todo: 'It has no network access right now - nothing you reach through NetBird will work until it passes the checks or an admin approves a bypass.',
      button: { label: 'Request a Bypass', to: '/request-access' },
    };
    if (fail('connection')) return device?.peer.login_expired
      ? {
        tone: 'bad', headline: 'Your device is signed out of NetBird.',
        todo: 'Open the NetBird app on the device and sign in again (or run: netbird up). Everything should come back once you are signed in.',
      }
      : {
        tone: 'bad', headline: 'Your device is not connected to NetBird.',
        todo: 'Make sure the NetBird app is running and connected on the device. If it looks connected and this persists, run the downloadable script on it.',
      };
    if (fail('target')) return {
      tone: 'bad', headline: 'The target you checked is disabled or no longer exists.',
      todo: 'An admin disabled or removed it. If you still need it, contact your admin.',
    };
    if (fail('coverage')) return {
      tone: 'bad', headline: 'This address is not part of the NetBird network.',
      todo: 'NetBird is not involved when you connect to it, so whatever fails there is not a NetBird problem. If it SHOULD be reachable through NetBird, ask your admin to add it as a resource.',
    };
    if (fail('routers')) return {
      tone: 'bad', headline: 'The problem is on the server side - not your device.',
      todo: 'No routing peer is online in the target\'s network, so it is unreachable for EVERYONE right now. Contact your admin.',
    };
    if (fail('policy')) return {
      tone: 'bad', headline: 'You do not have permission to reach this target.',
      todo: 'Your device and connection are fine - there is simply no access rule that includes you. Request access and an approver will review it.',
      button: { label: 'Request Access', to: requestLink },
    };
    if (fail('port')) return {
      tone: 'bad', headline: 'You have access to this target - but not on this port.',
      todo: 'Request access for the specific port you need and an approver will review it.',
      button: { label: 'Request Access', to: requestLink },
    };
    if (fail('route')) return {
      tone: 'bad', headline: 'Your device does not receive this route.',
      todo: 'The address is routed through NetBird, but your device is not in the group that gets the route. Ask your admin to add it.',
    };
    if (allChecks.some((c) => (c.key === 'b-mgmt' || c.key === 'b-signal') && c.status === 'FAIL')) return {
      tone: 'bad', headline: 'The network you are browsing from is blocking NetBird.',
      todo: 'This is about your current location (a firewall or proxy there), not your device or your account. Try a different network or contact your IT.',
    };
    const exit = allChecks.find((c) => c.key === 'exitnode');
    if (exit) return {
      tone: 'ok', headline: 'This address is not routed through NetBird.',
      todo: `Traffic to it takes the regular internet path, so a problem reaching it is not a NetBird problem. (Side note: an Exit Node is offered to this device - turning it on from the NetBird tray menu would send ALL internet traffic, including this address, through NetBird. ${exit.detail}.)`,
    };
    if (warns.length) return {
      tone: 'warn', headline: 'Everything works - with a small caveat.',
      todo: warns[0].detail,
    };
    return {
      tone: 'ok', headline: 'Everything looks good.',
      todo: 'All checks passed. If something still does not work, run the downloadable script on the device itself - it checks what a browser cannot.',
    };
  }, [ran, allChecks, warns, device, requestLink]);

  const matchNote = info && info.matches.length > 0 && (
    <span className="text-[0.8rem] text-nb-gray-500">
      This browser's IP ({info.ip}) matches{' '}
      {info.matches.slice(0, 2).map((m, i) => (
        <span key={m.id}>
          {i > 0 && ', '}
          <button type="button" className="text-netbird hover:underline" onClick={() => setPeerId(m.id)}>{m.name}</button>
        </span>
      ))}
      {info.matches.length > 2 ? ` +${info.matches.length - 2} more` : ''}
    </span>
  );

  return (
    <div>
      <PageHeader
        title="Troubleshoot"
        description="Something not working? Pick your device (and optionally what you are trying to reach) - the app checks the connection from every side it can see and tells you what to do next."
      />

      <div className="max-w-3xl flex flex-col gap-4">
        {notices.length > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-100">
              <AlertTriangle size={15} className="text-amber-500 shrink-0" /> Known Issues Right Now
            </div>
            {notices.map((n, i) => (
              <div key={n.id || i} className="mt-1.5 flex items-start gap-2 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200">
                <span className="min-w-0 flex-1">
                  <b>{n.event}</b>{n.peerName ? ` - ${n.peerName}` : ''}
                  {n.message && n.message !== n.event ? ` · ${n.message}` : ''}
                  <span className="text-nb-gray-500"> · {formatTimestamp(n.at)}</span>
                </span>
                {/* Admin-only: hides this notice for EVERYONE (banner + dashboard). */}
                {isAdmin && n.id && (
                  <button type="button" title="Ignore - hide this notice for everyone"
                    disabled={dismissNotice.isPending}
                    onClick={() => dismissNotice.mutate(n.id)}
                    className="shrink-0 mt-0.5 text-nb-gray-400 hover:text-red-500 transition-colors">
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
            <p className="mt-2 text-[0.75rem] text-nb-gray-500">
              Reported by NetBird itself. If your problem involves one of these, it is already known - no need to dig further.
            </p>
          </div>
        )}

        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-4 flex flex-col gap-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-[0.8rem] font-medium text-nb-gray-700 dark:text-nb-gray-200 mb-1.5">Device</div>
              <SelectMenu value={peerId} onChange={setPeerId} searchable options={deviceOptions} />
              {matchNote}
            </div>
            <div>
              <div className="text-[0.8rem] font-medium text-nb-gray-700 dark:text-nb-gray-200 mb-1.5">What Can't You Reach? (Optional)</div>
              {target ? (
                <div className="flex items-center gap-2 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-3 py-2">
                  <span className="text-sm truncate text-nb-gray-800 dark:text-nb-gray-100">{target.name}</span>
                  <button type="button" onClick={() => setTarget(null)} title="Clear target"
                    className="ml-auto text-nb-gray-400 hover:text-nb-gray-600 dark:hover:text-nb-gray-200"><X size={15} /></button>
                </div>
              ) : addr ? (
                <div className="flex items-center gap-2 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-3 py-2">
                  <span className="text-sm truncate font-mono text-nb-gray-800 dark:text-nb-gray-100">{addr}</span>
                  <span className="text-[0.66rem] uppercase text-nb-gray-400 whitespace-nowrap">Address</span>
                  <button type="button" onClick={() => setAddr('')} title="Clear address"
                    className="ml-auto text-nb-gray-400 hover:text-nb-gray-600 dark:hover:text-nb-gray-200"><X size={15} /></button>
                </div>
              ) : (
                <TargetSearch chosen={[]} onPick={setTarget} types={['resource', 'network']}
                  onEnterFree={(t) => { setAddr(t); setTarget(null); }}
                  placeholder="Search - or type an IP / address and press Enter" />
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={run} disabled={!peerId || running}>
              <Play size={14} className={cn('mr-1.5', running && 'animate-pulse')} />
              {running ? 'Running Checks…' : 'Run Diagnostics'}
            </Button>
            {/* The script is a Windows PowerShell diagnostic - only offer it for a Windows device. */}
            {isWindowsDevice && (
              <>
                <a href="/api/diagnostics/script" download className="inline-flex items-center gap-1.5 text-[0.85rem] text-netbird hover:underline">
                  <Download size={14} /> Download Diagnostics Script
                </a>
                <span className="text-[0.75rem] text-nb-gray-500">
                  A Windows script that runs ON the device and covers what a browser cannot: client service, tunnel adapter, firewall, MTU and the client log.
                </span>
              </>
            )}
          </div>
          {error && <div className="text-sm text-red-500">{error}</div>}
        </div>

        {running && steps && (
          <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-4">
            <div className="h-1.5 rounded-full bg-nb-gray-100 dark:bg-nb-gray-900 overflow-hidden mb-3">
              <div className="h-full rounded-full bg-netbird transition-all duration-500"
                style={{ width: `${Math.max(6, (steps.filter((s) => s.done).length / steps.length) * 100)}%` }} />
            </div>
            {steps.map((s) => (
              <div key={s.key} className="flex items-center gap-2.5 py-1">
                {s.done
                  ? <Check size={15} className="shrink-0 text-green-500" />
                  : <Loader2 size={15} className="shrink-0 text-netbird animate-spin" />}
                <span className={cn('text-[0.85rem]', s.done ? 'text-nb-gray-500' : 'text-nb-gray-800 dark:text-nb-gray-100')}>
                  {s.done ? s.label : `Checking ${s.label}…`}
                </span>
              </div>
            ))}
          </div>
        )}

        {ran && verdict && (
          <div className={cn('rounded-lg border p-4',
            verdict.tone === 'bad' ? 'border-red-500/40 bg-red-500/5'
              : verdict.tone === 'warn' ? 'border-amber-500/40 bg-amber-500/5'
                : 'border-green-500/40 bg-green-500/5')}>
            <div className="text-[0.95rem] font-semibold text-nb-gray-900 dark:text-nb-gray-100">{verdict.headline}</div>
            <p className="text-sm text-nb-gray-700 dark:text-nb-gray-200 mt-1">{verdict.todo}</p>
            {verdict.button && !inTenant && (
              <div className="mt-3">
                <Link to={verdict.button.to}><Button variant="primary">{verdict.button.label}</Button></Link>
              </div>
            )}
            {(fails.length > 0 || warns.length > 0) && (
              <div className="mt-3 pt-2.5 border-t border-nb-gray-200/70 dark:border-nb-gray-800/70">
                <div className="text-[0.68rem] uppercase tracking-wide text-nb-gray-500 mb-1">Details</div>
                {[...fails, ...warns].slice(0, 6).map((c) => (
                  <div key={c.key + c.label} className="text-[0.78rem] text-nb-gray-600 dark:text-nb-gray-300 mt-0.5">
                    <b>{c.label}:</b> {c.detail}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {ran && (
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="self-start inline-flex items-center gap-1.5 text-[0.82rem] text-nb-gray-500 hover:text-nb-gray-700 dark:hover:text-nb-gray-300 transition-colors"
          >
            {showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {showDetails ? 'Hide Technical Details' : 'Show Technical Details'}
          </button>
        )}

        {showDetails && device && (
          <Section icon={<MonitorSmartphone size={15} />} title={`Device - ${device.peer.name} (Server View)`}>
            {device.checks.map((c) => <CheckRow key={c.key} c={c} />)}
          </Section>
        )}

        {showDetails && browserChecks && (
          <Section icon={<Globe size={15} />} title="Your Network (Checked From This Browser)">
            {browserChecks.map((c) => <CheckRow key={c.key} c={c} />)}
            <p className="text-[0.75rem] text-nb-gray-500 mt-2">
              These probes ran from the browser you are using right now - they test THIS network, which may differ from the device's network.
            </p>
          </Section>
        )}

        {showDetails && targetDiag && (
          <Section icon={<Route size={15} />} title={`Access Path${targetDiag.target ? ` - ${targetDiag.target.name}` : ''}`}>
            {targetDiag.findings.map((c) => <CheckRow key={c.key + c.label} c={c} />)}
          </Section>
        )}

        {showDetails && device && device.recentEvents.length > 0 && (
          <Section icon={<History size={15} />} title="Recent NetBird Events For This Device">
            {device.recentEvents.map((e, i) => (
              <div key={i} className="flex items-baseline gap-3 py-1.5 border-b border-nb-gray-100 dark:border-nb-gray-900 last:border-0">
                <span className="text-[0.75rem] text-nb-gray-500 whitespace-nowrap">{formatTimestamp(e.timestamp)}</span>
                <span className="text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200"><Badge>{e.message}</Badge></span>
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
