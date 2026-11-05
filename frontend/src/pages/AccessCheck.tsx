import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion, UserSearch, ScanSearch, Monitor, TriangleAlert, Route, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatMaybeDate } from '@/lib/logfmt';
import { useAccessCheckOptions, useUserAccessCheck, useWhoHasAccess, type AccessCheckParams } from '@/lib/queries';
import type {
  AccessVerdict, AccessAnswer, AccessSummary, AccessConditional, AccessNetworkAnswer, AccessPart, AccessDevice,
  AccessDeviceBlocker, AccessPortsDesc, AccessRouterStatus, AccessQuery, AccessTargetInfo, UserAccessResult, WhoHasAccessResult,
  AccessCompactDevice, WhoHasAccessUser,
} from '@/lib/types';
import { Badge, Button, Field, Input, PillTabs, SelectMenu, Spinner, StatusDot, EmptyState, type SelectOption } from '@/components/ui';

// Access Check: "does this user have access to that resource?" and "who has access to it?",
// answered from a fresh read of NetBird. The backend (lib/access-check.js) owns every rule;
// this page only explains its answer. State lives in the URL so the shortcuts on the user page
// and in the resource editor can open it prefilled.

type Mode = 'user' | 'who';
type Tone = 'green' | 'amber' | 'red' | 'gray';

const VERDICT: Record<AccessVerdict | 'cannot_connect', { label: string; tone: Tone }> = {
  granted: { label: 'Has Access', tone: 'green' },
  partial: { label: 'Partial Access', tone: 'amber' },
  conditional: { label: 'Depends On Posture Checks', tone: 'amber' },
  port_blocked: { label: 'Not On This Port', tone: 'amber' },
  cannot_determine: { label: 'Cannot Determine', tone: 'gray' },
  pending: { label: 'Pending Device', tone: 'gray' },
  denied: { label: 'No Access', tone: 'red' },
  cannot_connect: { label: 'Cannot Connect', tone: 'red' },
};

const TONE_BADGE: Record<Tone, 'green' | 'orange' | 'red' | 'gray'> = { green: 'green', amber: 'orange', red: 'red', gray: 'gray' };

const BLOCKER: Record<AccessDeviceBlocker, string> = {
  user_blocked: 'The user is blocked',
  login_expired: 'The sign-in expired - the device must sign in again',
  compliance: 'Blocked by compliance checks (no bypass)',
  compliance_unknown: 'Waiting for compliance approval - the bypass status could not be read',
};

const PART_REASON: Record<string, string> = {
  no_route: 'No route - no policy reaches this part for this device',
  ambiguous_route: 'Two resources have exactly this address - NetBird may pick either one',
  unparsable_rule: 'A blocking rule has a port format this check does not understand',
  not_checked: 'No policy targets this resource directly, and overlap is not checked for this address type',
  router_unknown: 'A resource in another network also covers this part, and it is not known whether the same routing peer serves it - its rules could change the answer',
};

function verdictLabel(v: AccessVerdict | 'cannot_connect', q?: AccessQuery) {
  if (v === 'port_blocked' && q && !q.port) return 'Not For This Protocol';
  return VERDICT[v].label;
}

function VerdictBadge({ v, q }: { v: AccessVerdict | 'cannot_connect'; q?: AccessQuery }) {
  return <Badge tone={TONE_BADGE[VERDICT[v].tone]} className="py-1 px-2.5">{verdictLabel(v, q)}</Badge>;
}

const queryText = (q: AccessQuery) => (q.protocol === 'any' ? 'any traffic' : `${q.protocol.toUpperCase()}${q.port ? ` port ${q.port}` : ''}`);

function portsText(p?: AccessPortsDesc) {
  if (!p) return '';
  const out: string[] = [];
  if (p.tcp) out.push(`TCP ${p.tcp}`);
  if (p.udp) out.push(`UDP ${p.udp}`);
  if (p.icmp) out.push('ICMP');
  if (p.tcp === 'all' && p.udp === 'all' && p.icmp) return 'All traffic';
  return out.join(' · ') || 'Nothing';
}

const isConditional = (a: AccessAnswer | AccessNetworkAnswer): a is AccessConditional => 'ifChecksPass' in a;
const isNetwork = (a: AccessAnswer | AccessNetworkAnswer): a is AccessNetworkAnswer => 'perResource' in a;

// ─── Form ───

function useAccessParams() {
  const [params, setParams] = useSearchParams();
  const mode: Mode = params.get('mode') === 'who' ? 'who' : 'user';
  const user = params.get('user') || '';
  const target = params.get('target') || '';
  const protocol = params.get('protocol') || 'any';
  const port = params.get('port') || '';
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };
  return { mode, user, target, protocol, port, set };
}

function toParams(target: string, protocol: string, port: string): AccessCheckParams | null {
  const i = target.indexOf(':');
  if (i < 1) return null;
  const type = target.slice(0, i) as 'resource' | 'network';
  if (type !== 'resource' && type !== 'network') return null;
  const proto = ['tcp', 'udp'].includes(protocol) ? protocol : (protocol === 'icmp' ? 'icmp' : 'any');
  return { type, id: target.slice(i + 1), protocol: proto, port: ['tcp', 'udp'].includes(proto) ? port : '' };
}

export default function AccessCheck() {
  const p = useAccessParams();
  const opts = useAccessCheckOptions();
  // Form fields edit a draft; "Check" commits it to the URL, which is what the queries read.
  const [draft, setDraft] = useState({ user: p.user, target: p.target, protocol: p.protocol, port: p.port });
  useEffect(() => { setDraft({ user: p.user, target: p.target, protocol: p.protocol, port: p.port }); }, [p.user, p.target, p.protocol, p.port]);

  const userOptions: SelectOption[] = useMemo(() => (opts.data?.users || []).map((u) => ({
    value: u.id, label: u.name, subtitle: u.email && u.email !== u.name ? u.email : undefined,
  })), [opts.data]);
  const targetOptions: SelectOption[] = useMemo(() => {
    const d = opts.data;
    if (!d) return [];
    return [
      ...(d.networks.length ? [{ value: '__h-n', label: 'Networks', heading: true }] : []),
      ...d.networks.map((n) => ({ value: `network:${n.id}`, label: n.name, subtitle: 'Every resource in this network' })),
      ...(d.resources.length ? [{ value: '__h-r', label: 'Resources', heading: true }] : []),
      ...d.resources.map((r) => ({
        value: `resource:${r.id}`, label: r.name,
        subtitle: [r.address, r.network?.name, r.enabled === false ? 'disabled' : ''].filter(Boolean).join(' · '),
      })),
    ];
  }, [opts.data]);

  const portEnabled = draft.protocol === 'tcp' || draft.protocol === 'udp';
  const portValid = !draft.port || (/^\d{1,5}$/.test(draft.port) && Number(draft.port) >= 1 && Number(draft.port) <= 65535);
  const ready = !!draft.target && (p.mode === 'who' || !!draft.user) && portValid;
  const committed = toParams(p.target, p.protocol, p.port);
  const userQ = useUserAccessCheck(p.mode === 'user' ? p.user : '', p.mode === 'user' ? committed : null);
  const whoQ = useWhoHasAccess(p.mode === 'who' ? committed : null);
  const active = p.mode === 'user' ? userQ : whoQ;
  // Committing the same values leaves the query key unchanged, so ask for a fresh read instead:
  // a repeated Check must reflect NetBird now (after a change, or after a failed read).
  const run = () => {
    const next = { user: draft.user, target: draft.target, protocol: draft.protocol === 'any' ? '' : draft.protocol, port: portEnabled ? draft.port : '' };
    const unchanged = next.target === p.target && (next.protocol || 'any') === p.protocol && next.port === p.port && (p.mode === 'who' || next.user === p.user);
    if (unchanged && committed) void active.refetch();
    else p.set(next);
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-nb-gray-500 dark:text-nb-gray-400 max-w-3xl">
        Check what NetBird allows right now: whether a user's devices can reach a resource, or everyone who can.
        The answer follows NetBird's own rules - device groups, the most specific route, and blocking rules.
      </p>

      <PillTabs
        value={p.mode}
        onChange={(k) => p.set({ mode: k === 'who' ? 'who' : '' })}
        items={[
          { key: 'user', label: 'User Access', icon: <UserSearch size={15} /> },
          { key: 'who', label: 'Who Has Access', icon: <ScanSearch size={15} /> },
        ]}
      />

      <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-4">
        <div className={cn('grid gap-4', p.mode === 'user' && 'md:grid-cols-2')}>
          {p.mode === 'user' && (
            <Field label="User" className="min-w-0">
              <SelectMenu options={userOptions} value={draft.user} onChange={(v) => setDraft((d) => ({ ...d, user: v }))}
                placeholder={opts.isLoading ? 'Loading…' : 'Choose a user'} searchable searchPlaceholder="Search users..." />
            </Field>
          )}
          <Field label="Resource Or Network" className="min-w-0">
            <SelectMenu options={targetOptions} value={draft.target} onChange={(v) => setDraft((d) => ({ ...d, target: v }))}
              placeholder={opts.isLoading ? 'Loading…' : 'Choose a resource or network'} searchable searchPlaceholder="Search resources..." />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-4 items-end">
          <Field label="Protocol" className="w-[calc(50%-0.5rem)] sm:w-36">
            <SelectMenu
              options={[{ value: 'any', label: 'Any' }, { value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }, { value: 'icmp', label: 'ICMP' }]}
              value={draft.protocol} onChange={(v) => setDraft((d) => ({ ...d, protocol: v }))} searchable={false} />
          </Field>
          <Field label="Port" className="w-[calc(50%-0.5rem)] sm:w-32">
            <Input inputMode="numeric" placeholder={portEnabled ? 'Any' : '-'} disabled={!portEnabled} value={portEnabled ? draft.port : ''}
              onChange={(e) => setDraft((d) => ({ ...d, port: e.target.value.trim() }))}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) run(); }}
              className={cn('w-full', !portValid && 'border-red-500/60')} aria-invalid={!portValid} />
          </Field>
          <Button variant="primary" className="w-full sm:w-auto" onClick={run} disabled={!ready || active.isFetching}>
            {active.isFetching ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <ShieldCheck size={15} />} Check
          </Button>
        </div>
        {!portValid && <p className="mt-2 text-xs text-red-500">Enter a port from 1 to 65535, or leave it empty for any port.</p>}
        {opts.isError && <p className="mt-2 text-xs text-red-500">{(opts.error as Error).message}</p>}
      </div>

      {active.isError && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
          {(active.error as Error).message}
        </div>
      )}
      {active.isFetching && !active.data && <div className="flex justify-center py-10"><Spinner /></div>}
      {p.mode === 'user' && userQ.data && !userQ.isError && <UserResult r={userQ.data} />}
      {p.mode === 'who' && whoQ.data && !whoQ.isError && <WhoResult r={whoQ.data} onDetails={(uid) => p.set({ mode: '', user: uid })} />}
    </div>
  );
}

// ─── Shared pieces ───

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950', className)}>{children}</div>;
}

const BANNER: Record<Tone, string> = {
  green: 'border-green-500/40 bg-green-500/5',
  amber: 'border-netbird/40 bg-netbird/5',
  red: 'border-red-500/40 bg-red-500/5',
  gray: 'border-nb-gray-300 dark:border-nb-gray-700 bg-nb-gray-100/60 dark:bg-nb-gray-920',
};
const BANNER_ICON: Record<Tone, ReactNode> = {
  green: <ShieldCheck size={26} className="text-green-600 dark:text-green-500" />,
  amber: <ShieldAlert size={26} className="text-netbird" />,
  red: <ShieldX size={26} className="text-red-600 dark:text-red-500" />,
  gray: <ShieldQuestion size={26} className="text-nb-gray-500" />,
};

function Banner({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  return (
    <div className={cn('rounded-lg border p-5 flex gap-4 items-start', BANNER[tone])}>
      <div className="shrink-0 mt-0.5">{BANNER_ICON[tone]}</div>
      <div className="min-w-0">
        <h2 className="text-lg md:text-xl font-semibold text-nb-gray-900 dark:text-nb-gray-50 break-words">{title}</h2>
        {children && <div className="mt-1 text-sm text-nb-gray-600 dark:text-nb-gray-300 space-y-1">{children}</div>}
      </div>
    </div>
  );
}

function Warnings({ target, routers, legacy }: { target: AccessTargetInfo; routers: AccessRouterStatus[]; legacy?: { resource: string; route: string }[] }) {
  const items: string[] = [];
  if (target.type === 'resource' && target.enabled === false) items.push('This resource is disabled. Only an enabled resource with an overlapping address can still route to it.');
  for (const r of routers) {
    if (r.status === 'offline') items.push(`No routing peer is online in network "${r.network.name}" - nothing routes through it right now.`);
    if (r.status === 'none') items.push(`Network "${r.network.name}" has no routing peer - nothing routes through it.`);
    if (r.status === 'unknown') items.push(`The routing peers of network "${r.network.name}" could not be read - their status is unknown.`);
  }
  for (const route of [...new Set((legacy || []).map((l) => l.route))]) items.push(`The legacy network route "${route}" also covers this address. This check does not evaluate legacy routes.`);
  if (!items.length) return null;
  return (
    <div className="rounded-lg border border-netbird/40 bg-netbird/5 p-4 flex flex-col gap-1.5">
      {items.map((t) => (
        <p key={t} className="flex gap-2 text-sm text-nb-gray-700 dark:text-nb-gray-300"><TriangleAlert size={15} className="text-netbird shrink-0 mt-0.5" />{t}</p>
      ))}
    </div>
  );
}

function targetName(t: AccessTargetInfo) {
  return t.type === 'network' ? `network ${t.name}` : `${t.name}${t.address && t.address !== t.name ? ` (${t.address})` : ''}`;
}

// ─── User Access result ───

function userExplanation(r: UserAccessResult): ReactNode[] {
  const q = queryText(r.query);
  const out: ReactNode[] = [];
  switch (r.verdict) {
    case 'granted': out.push(`At least one of ${r.user.name}'s devices can reach it (${q}).`); break;
    case 'partial': out.push(`A device can reach only part of it (${q}). The breakdown below shows which part.`); break;
    case 'conditional': out.push(`Access depends on posture checks that run on the device. Both outcomes are shown below.`); break;
    case 'port_blocked': out.push(`A device can reach it, but not for ${q}. The open ports are shown below.`); break;
    case 'cannot_determine': out.push('NetBird\'s configuration does not give one clear answer. The reasons are shown below.'); break;
    case 'pending': out.push(`${r.user.name}'s groups would give a device access, but none of their devices is in those groups yet.`); break;
    case 'denied': out.push('No policy lets any of this user\'s devices reach it.'); break;
  }
  if (r.reason === 'user_blocked') out.splice(0, out.length, 'The user is blocked in NetBird, so none of their devices can connect.');
  if (r.reason === 'device_cannot_connect') out.splice(0, out.length, 'A device matches a policy, but it cannot connect right now. The reason is shown on the device.');
  if (r.reason === 'no_devices') out.push('The user has no devices.');
  return out;
}

function UserResult({ r }: { r: UserAccessResult }) {
  const tone = VERDICT[r.verdict].tone;
  const title = `${r.user.name}: ${verdictLabel(r.verdict, r.query)}`;
  return (
    <div className="flex flex-col gap-4">
      <Banner tone={tone} title={title}>
        <p className="text-nb-gray-500">Target: {targetName(r.target)} · {queryText(r.query)}</p>
        {userExplanation(r).map((t, i) => <p key={i}>{t}</p>)}
      </Banner>
      <Warnings target={r.target} routers={r.routers} legacy={r.legacyRoutes} />
      {r.devices.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-semibold text-nb-gray-800 dark:text-nb-gray-100">{r.devices.length} Device{r.devices.length === 1 ? '' : 's'}</h3>
          {r.devices.map((d) => <DeviceCard key={d.id} d={d} q={r.query} defaultOpen={r.devices.length === 1 || d.effective === r.verdict} />)}
        </div>
      )}
    </div>
  );
}

function DeviceCard({ d, q, defaultOpen }: { d: AccessDevice; q: AccessQuery; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Panel>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex flex-wrap items-center gap-x-3 gap-y-2 p-4 text-left">
        {open ? <ChevronDown size={16} className="text-nb-gray-400" /> : <ChevronRight size={16} className="text-nb-gray-400" />}
        <Monitor size={16} className="text-nb-gray-500" />
        <Link to={`/peers/${encodeURIComponent(d.id)}`} onClick={(e) => e.stopPropagation()} className="font-medium text-nb-gray-900 dark:text-nb-gray-100 hover:underline break-all">{d.name}</Link>
        <span className="inline-flex items-center gap-1.5 text-xs text-nb-gray-500"><StatusDot on={d.connected} />{d.connected ? 'Online' : 'Offline'}</span>
        {d.infrastructure && <Badge tone="cyan" className="py-1 px-2">Infrastructure</Badge>}
        <span className="ml-auto"><VerdictBadge v={d.effective} q={q} /></span>
      </button>
      {d.blockers.length > 0 && (
        <div className="px-4 pb-3 -mt-1 flex flex-col gap-1">
          {d.blockers.map((b) => <p key={b} className="flex gap-2 text-sm text-red-600 dark:text-red-400"><TriangleAlert size={14} className="shrink-0 mt-0.5" />{BLOCKER[b]}</p>)}
        </div>
      )}
      {open && <div className="border-t border-nb-gray-100 dark:border-nb-gray-900 p-4"><AnswerView a={d.answer} q={q} /></div>}
    </Panel>
  );
}

function AnswerView({ a, q }: { a: AccessAnswer | AccessNetworkAnswer; q: AccessQuery }) {
  if (isNetwork(a)) {
    if (!a.perResource.length) return <p className="text-sm text-nb-gray-500">This network has no resources.</p>;
    return (
      <div className="flex flex-col gap-3">
        {a.perResource.map((r) => <NetworkResourceRow key={r.resource.id} r={r} q={q} />)}
      </div>
    );
  }
  if (isConditional(a)) {
    return (
      <div className="flex flex-col gap-4">
        <div className="text-sm text-nb-gray-600 dark:text-nb-gray-300 flex flex-col gap-1">
          {a.posturePolicies.map((p) => (
            <p key={p.policy}><span className="font-medium">{p.policy}</span> requires: {p.checks.join(', ') || 'posture checks'}</p>
          ))}
          <p className="text-xs text-nb-gray-500">Below are the two extremes. A device that passes only some checks can get a different answer.</p>
        </div>
        <SummaryView title="If The Device Passes Every Check" s={a.ifChecksPass} q={q} />
        <SummaryView title="If The Device Fails Every Check" s={a.ifChecksFail} q={q} />
      </div>
    );
  }
  return <SummaryView s={a} q={q} />;
}

function NetworkResourceRow({ r, q }: { r: AccessNetworkAnswer['perResource'][number]; q: AccessQuery }) {
  const [open, setOpen] = useState(r.verdict !== 'denied');
  return (
    <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex flex-wrap items-center gap-2 px-3 py-2.5 text-left">
        {open ? <ChevronDown size={14} className="text-nb-gray-400" /> : <ChevronRight size={14} className="text-nb-gray-400" />}
        <span className="font-medium text-sm text-nb-gray-800 dark:text-nb-gray-100">{r.resource.name}</span>
        <span className="text-xs text-nb-gray-500 break-all">{r.resource.address}</span>
        <span className="ml-auto"><VerdictBadge v={r.verdict} q={q} /></span>
      </button>
      {open && <div className="border-t border-nb-gray-100 dark:border-nb-gray-900 p-3"><AnswerView a={r.answer} q={q} /></div>}
    </div>
  );
}

function SummaryView({ s, q, title }: { s: AccessSummary; q: AccessQuery; title?: string }) {
  return (
    <div className="flex flex-col gap-2">
      {title && (
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-nb-gray-700 dark:text-nb-gray-200">{title}</h4>
          <VerdictBadge v={s.verdict} q={q} />
        </div>
      )}
      {s.overlapNotChecked && <p className="text-xs text-nb-gray-500">Overlap with other resources is not checked for this address type.</p>}
      {!!s.postureIndependent?.length && (
        <p className="text-xs text-nb-gray-500">The same answer whether or not the device passes {s.postureIndependent.map((x) => x.checks.join(', ')).filter(Boolean)[0] || 'its posture checks'} ({s.postureIndependent.map((x) => x.policy).join(', ')}).</p>
      )}
      <div className="flex flex-col gap-2">
        {s.parts.map((p) => <PartRow key={p.label} p={p} single={s.parts.length === 1} />)}
      </div>
    </div>
  );
}

const ANSWER_DOT: Record<AccessPart['answer'], string> = { yes: 'bg-green-500', no: 'bg-red-500', unknown: 'bg-nb-gray-400' };

function PartRow({ p, single }: { p: AccessPart; single: boolean }) {
  return (
    <div className="rounded-md bg-nb-gray-50 dark:bg-nb-gray-920/60 px-3 py-2.5 text-sm flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full shrink-0', ANSWER_DOT[p.answer])} />
        {!single && <span className="font-mono text-[0.8rem] text-nb-gray-800 dark:text-nb-gray-100 break-all">{p.label}</span>}
        <span className="text-nb-gray-600 dark:text-nb-gray-300">{p.answer === 'yes' ? 'Reachable' : p.answer === 'no' ? 'Not reachable' : 'Cannot tell'}</span>
        {p.winner && (
          <span className="inline-flex items-center gap-1 text-xs text-nb-gray-500">
            <Route size={12} /> via {p.winner.name}{p.winner.network ? ` (${p.winner.network.name})` : ''}{p.overlapping ? ' - an overlapping resource' : ''}
          </span>
        )}
      </div>
      {p.reason && <p className="text-xs text-nb-gray-500">{PART_REASON[p.reason]}{p.winners?.length ? `: ${p.winners.map((w) => `${w.name}${w.network ? ` (${w.network.name})` : ''}`).join(', ')}` : ''}</p>}
      {p.allowed && <p className="text-xs text-nb-gray-600 dark:text-nb-gray-400"><span className="font-medium">Open:</span> {portsText(p.allowed)}</p>}
      {!!p.grantedBy?.length && (
        <div className="flex flex-col gap-1">
          {p.grantedBy.map((g, i) => (
            <p key={`${g.policyId}-${i}`} className="text-xs text-nb-gray-600 dark:text-nb-gray-400 flex flex-wrap items-center gap-1.5">
              <span className="font-medium text-nb-gray-700 dark:text-nb-gray-300">{g.policy}</span>
              <span>({portsText(g.ports)}) through {g.via.join(', ')}</span>
              {g.infra && <Badge tone="cyan" className="py-0.5 px-1.5 text-[0.68rem]">Browser Gateway</Badge>}
              {g.temp?.state === 'active' && <Badge tone="gray" className="py-0.5 px-1.5 text-[0.68rem] whitespace-normal! text-left">Temporary #{g.temp.id}{g.temp.expiresAt ? ` until ${formatMaybeDate(g.temp.expiresAt)}` : ''}</Badge>}
              {g.temp?.state === 'ended' && <Badge tone="red" className="py-0.5 px-1.5 text-[0.68rem] whitespace-normal! text-left">Temporary #{g.temp.id} ended - still open in NetBird, cleanup not finished</Badge>}
            </p>
          ))}
        </div>
      )}
      {!!p.blockedBy?.length && <p className="text-xs text-nb-gray-600 dark:text-nb-gray-400"><span className="font-medium">Blocked by:</span> {p.blockedBy.join(', ')}</p>}
      {p.note === 'unparsable_accept' && <p className="text-xs text-nb-gray-500">A rule with a port format this check does not understand was skipped.</p>}
    </div>
  );
}

// ─── Who Has Access result ───

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function WhoResult({ r, onDetails }: { r: WhoHasAccessResult; onDetails: (userId: string) => void }) {
  // Only granted and partial are proven access; the rest are listed with what they are.
  const count = (v: AccessVerdict) => r.users.filter((u) => u.verdict === v).length;
  const full = count('granted');
  const proven = full + count('partial');
  const conditional = count('conditional');
  const uncertain = count('cannot_determine');
  const portOnly = count('port_blocked');
  const devicesWith = r.devices.filter((d) => d.effective === 'granted' || d.effective === 'partial').length;
  const devicesOther = r.devices.length - devicesWith;
  const tone: Tone = full ? 'green' : proven || conditional ? 'amber' : uncertain ? 'gray' : 'red';
  const title = proven ? `${plural(proven, 'User', 'Users')} With Access` : 'No User With Access';
  return (
    <div className="flex flex-col gap-4">
      <Banner tone={tone} title={title}>
        <p className="text-nb-gray-500">Target: {targetName(r.target)} · {queryText(r.query)}</p>
        {proven > full && <p>{plural(proven - full, 'of them reaches', 'of them reach')} only part of it.</p>}
        {conditional > 0 && <p>{plural(conditional, 'more depends', 'more depend')} on posture checks.</p>}
        {uncertain > 0 && <p>For {plural(uncertain, 'more user', 'more users')} the answer cannot be determined - the reasons are in their details.</p>}
        {portOnly > 0 && <p>{plural(portOnly, 'more reaches', 'more reach')} it, but not for {queryText(r.query)}.</p>}
        {r.pending.length > 0 && <p>{plural(r.pending.length, 'more would', 'more would')} get access once one of their devices joins the right group.</p>}
        {devicesWith > 0 && <p>{plural(devicesWith, 'device', 'devices')} without a listed owner also {devicesWith === 1 ? 'has' : 'have'} access.</p>}
        {devicesOther > 0 && <p>{plural(devicesOther, 'other device matches', 'other devices match')} a policy but cannot connect, or the answer is not certain.</p>}
      </Banner>
      <Warnings target={r.target} routers={r.routers} legacy={r.legacyRoutes} />
      {r.users.length > 0 && <UsersTable title="Users" rows={r.users} q={r.query} onDetails={onDetails} />}
      {r.pending.length > 0 && <UsersTable title="Pending - No Device In The Right Group Yet" rows={r.pending} q={r.query} onDetails={onDetails} />}
      {r.devices.length > 0 && (
        <Panel className="overflow-hidden">
          <h3 className="px-4 pt-4 pb-2 text-base font-semibold text-nb-gray-800 dark:text-nb-gray-100">Other Devices</h3>
          <p className="px-4 pb-3 text-xs text-nb-gray-500">Devices with access that belong to no listed user, such as servers added with a setup key.</p>
          <div className="divide-y divide-nb-gray-100 dark:divide-nb-gray-900">
            {r.devices.map((d) => (
              <div key={d.id} className="px-4 py-3 flex flex-wrap items-center gap-2">
                <DeviceChip d={d} q={r.query} />
                <span className="text-xs text-nb-gray-500">{deviceVia(d)}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {!r.users.length && !r.pending.length && !r.devices.length && (
        <Panel><EmptyState title="Nobody Has Access" hint="No policy lets any user or device reach this target." /></Panel>
      )}
    </div>
  );
}

function deviceVia(d: AccessCompactDevice) {
  if (d.resources?.length) return d.resources.map((x) => `${x.resource.name}: ${verdictLabel(x.verdict)}`).join(' · ');
  return d.policies?.length ? `via ${d.policies.join(', ')}` : '';
}

function DeviceChip({ d, q }: { d: AccessCompactDevice; q: AccessQuery }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusDot on={d.connected} />
      <Link to={`/peers/${encodeURIComponent(d.id)}`} className="text-sm text-nb-gray-800 dark:text-nb-gray-100 hover:underline break-all">{d.name}</Link>
      {d.infrastructure && <Badge tone="cyan" className="py-0.5 px-1.5 text-[0.68rem]">Infrastructure</Badge>}
      {d.endedGrant && <Badge tone="red" className="py-0.5 px-1.5 text-[0.68rem]">Ended Grant Still Open</Badge>}
      {d.effective !== 'granted' && <VerdictBadge v={d.effective} q={q} />}
      {d.blockers.map((b) => <span key={b} className="text-xs text-red-600 dark:text-red-400">{BLOCKER[b]}</span>)}
    </span>
  );
}

function UsersTable({ title, rows, q, onDetails }: { title: string; rows: WhoHasAccessUser[]; q: AccessQuery; onDetails: (userId: string) => void }) {
  return (
    <Panel className="overflow-hidden">
      <h3 className="px-4 pt-4 pb-3 text-base font-semibold text-nb-gray-800 dark:text-nb-gray-100">{title}</h3>
      <div className="divide-y divide-nb-gray-100 dark:divide-nb-gray-900">
        {rows.map((u) => (
          <div key={u.user.id} className="px-4 py-3 flex flex-col gap-2 md:flex-row md:items-start md:gap-4">
            <div className="md:w-48 shrink-0 min-w-0">
              <p className="font-medium text-sm text-nb-gray-900 dark:text-nb-gray-100 break-words">{u.user.name}</p>
              {u.user.email && u.user.email !== u.user.name && <p className="text-xs text-nb-gray-500 break-all">{u.user.email}</p>}
            </div>
            <div className="shrink-0"><VerdictBadge v={u.verdict} q={q} /></div>
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              {u.devices.length
                ? u.devices.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-2">
                    <DeviceChip d={d} q={q} />
                    <span className="text-xs text-nb-gray-500">{deviceVia(d)}</span>
                  </div>
                ))
                : <span className="text-xs text-nb-gray-500">{u.verdict === 'pending' ? 'No device in the right group yet' : 'No devices'}</span>}
            </div>
            <Button size="sm" variant="ghost" className="self-start" onClick={() => onDetails(u.user.id)}>Details</Button>
          </div>
        ))}
      </div>
    </Panel>
  );
}
