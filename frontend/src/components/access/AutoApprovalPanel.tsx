import { useState } from 'react';
import { Zap, Plus, Trash2, X, ShieldCheck, FolderGit2, Hourglass, Ban, Network as NetworkIcon } from 'lucide-react';
import { useAutoApprovalConfig, useAdGroups, useNetworks } from '@/lib/queries';
import { useSaveAutoApproval } from '@/lib/mutations';
import type { AutoApprovalAccess, AutoApprovalConfig, AutoApprovalRule, AutoApprovalTrusted, GrantTarget } from '@/lib/types';
import { Badge, Button, IconButton, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td, Modal, Field, FieldHint, Input, GroupMultiSelect, SelectMenu, PortSelector, Checkbox } from '@/components/ui';
import { useTableSort } from '@/lib/useTableSort';
import { TargetSearch } from '@/components/access/TargetSearch';
import { TARGET_META } from '@/components/access/targets';

// Small on/off switch for pausing an entry/rule in place (delete was the only option before).
function MiniToggle({ checked, onChange, title }: { checked: boolean; onChange: () => void; title: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      className={`relative h-5 w-9 rounded-full transition-colors shrink-0 ${checked ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

// "8h" / "2 days" / "As requested" for a rule's max-duration cap.
function capLabel(min: number): string {
  if (!min) return 'As Requested';
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'}`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}
const hoursToMinutes = (s: string) => (s.trim() ? Math.max(0, Math.round(parseFloat(s) * 60)) || 0 : 0);
const minutesToHours = (m: number) => (m ? String(m / 60) : '');
const asTargets = (arr: { type: GrantTarget['type']; id: string; name: string }[]): GrantTarget[] =>
  arr.map((t) => ({ type: t.type, id: t.id, name: t.name }));

// "TCP: 80, 443 · UDP: all · Ping" summary of a rule's access spec (null = mirror existing).
function accessSummary(a?: AutoApprovalAccess | null): string {
  if (!a) return '';
  const parts: string[] = [];
  if (a.tcp) parts.push(`TCP: ${a.tcp.length ? a.tcp.join(', ') : 'all'}`);
  if (a.udp) parts.push(`UDP: ${a.udp.length ? a.udp.join(', ') : 'all'}`);
  if (a.icmp) parts.push('Ping');
  return parts.join(' · ');
}

// null = closed · 'new' = add · number = editing that index.
type Editing = number | 'new' | null;

/**
 * The Auto-Approval tab on the Access Requests page (admin only). Two rule tables; rows are
 * clickable to edit and each carries its own duration cap. Every change saves immediately:
 *  - Trusted Requesters: groups whose members are auto-approved for ANY target (minus blocked ones).
 *  - Self-Service Resources: specific targets auto-approved for chosen groups.
 */
export function AutoApprovalPanel() {
  const { data, isLoading } = useAutoApprovalConfig();
  const { data: adGroups } = useAdGroups();
  const save = useSaveAutoApproval();
  const [trustedEdit, setTrustedEdit] = useState<Editing>(null);
  const [ruleEdit, setRuleEdit] = useState<Editing>(null);
  const [error, setError] = useState('');

  const trusted = data?.trusted || [];
  const rules = data?.rules || [];
  const groupName = (id: string) => (adGroups || []).find((g) => g.id === id)?.name || `${id.slice(0, 8)}…`;

  const persist = async (next: Partial<AutoApprovalConfig>) => {
    setError('');
    try { await save.mutateAsync({ trusted, rules, ...next }); }
    catch (e) { setError((e as Error).message || 'Failed to save'); throw e; }
  };
  const upsert = <T,>(list: T[], edit: Editing, value: T): T[] =>
    edit === 'new' ? [...list, value] : list.map((x, i) => (i === edit ? value : x));

  // Sort the two config tables. Carry each entry's ORIGINAL index so row click (edit) and
  // delete keep targeting the right entry even when the visible order changes.
  const trustedRows = trusted.map((t, i) => ({ t, i }));
  const { sorted: trustedSorted, state: trustedState } = useTableSort(trustedRows, {
    groups: (x) => x.t.groupIds.map(groupName).join(', '),
    blocked: (x) => (x.t.excludedTargets || []).map((e) => e.name || e.id).join(', '),
    maxDuration: (x) => x.t.maxMinutes,
  });
  const ruleRows = rules.map((r, i) => ({ r, i }));
  const { sorted: rulesSorted, state: rulesState } = useTableSort(ruleRows, {
    targets: (x) => x.r.targets.map((t) => t.name || t.id).join(', '),
    groups: (x) => x.r.groupIds.map(groupName).join(', '),
    access: (x) => accessSummary(x.r.access) || 'As exposed',
    maxDuration: (x) => x.r.maxMinutes,
  });

  if (isLoading) return <LoadingState />;

  const groupBadges = (ids: string[]) => (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((gid) => <Badge key={gid} tone="gray" icon={<FolderGit2 size={11} />}>{groupName(gid)}</Badge>)}
    </div>
  );
  const capBadge = (min: number) => <Badge tone={min ? 'cyan' : 'gray'} icon={<Hourglass size={11} />}>{capLabel(min)}</Badge>;
  // What the auto-approved grant opens: gray = mirrors the target's existing exposure,
  // orange chips = the rule pins exact protocols/ports (one temp policy per protocol).
  const accessBadges = (a?: AutoApprovalAccess | null) => !a
    ? <Badge tone="gray">As Exposed</Badge>
    : (
      <div className="flex flex-wrap gap-1.5">
        {a.tcp && <Badge tone="orange">TCP{a.tcp.length ? `: ${a.tcp.join(', ')}` : ': all'}</Badge>}
        {a.udp && <Badge tone="orange">UDP{a.udp.length ? `: ${a.udp.join(', ')}` : ': all'}</Badge>}
        {a.icmp && <Badge tone="orange">Ping</Badge>}
      </div>
    );
  // Network-scope chips for a trusted entry: green = only these networks, red = except these.
  const networkScope = (t: AutoApprovalTrusted) =>
    t.networkMode && t.networkMode !== 'all' && t.networks?.length ? (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[0.72rem] text-nb-gray-500">{t.networkMode === 'allow' ? 'Only:' : 'Except:'}</span>
        {t.networks.map((n) => (
          <Badge key={n.id} tone={t.networkMode === 'allow' ? 'green' : 'red'} icon={<NetworkIcon size={11} />}>{n.name || n.id}</Badge>
        ))}
      </div>
    ) : null;
  const del = (e: React.MouseEvent, run: () => Promise<void>) => { e.stopPropagation(); run().catch(() => { }); };
  // Pause/resume without deleting: a disabled entry keeps its configuration but never matches.
  const setTrustedEnabled = (i: number, on: boolean) =>
    persist({ trusted: trusted.map((t, idx) => (idx === i ? { ...t, enabled: on } : t)) }).catch(() => { });
  const setRuleEnabled = (i: number, on: boolean) =>
    persist({ rules: rules.map((r, idx) => (idx === i ? { ...r, enabled: on } : r)) }).catch(() => { });
  const offCls = 'opacity-50';
  const cardCls = 'rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 p-3.5 cursor-pointer active:bg-nb-gray-50 dark:active:bg-nb-gray-900/40 transition-colors';

  return (
    <div className="flex flex-col gap-8">
      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* Trusted requesters */}
      <div>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-nb-gray-900 dark:text-nb-gray-50"><ShieldCheck size={17} className="text-netbird" /> Trusted Requesters</h2>
            <p className="text-sm text-nb-gray-500 mt-0.5">Members of these groups are approved automatically for <b>any</b> request - except the entry's <b>blocked targets</b> (critical resources that always go to review) - up to the entry's max duration.</p>
          </div>
          <Button variant="primary" className="shrink-0" onClick={() => setTrustedEdit('new')}><Plus size={15} /><span className="hidden sm:inline">Add Groups</span></Button>
        </div>
        {!trusted.length ? (
          <EmptyState title="No Trusted Groups" hint="Add groups whose members (e.g. senior staff) should never wait for approval." icon={<ShieldCheck size={22} />} />
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <THead>
                  <SortTh label="Groups" sortKey="groups" state={trustedState} />
                  <SortTh label="Blocked Targets" sortKey="blocked" state={trustedState} />
                  <SortTh label="Max Duration" sortKey="maxDuration" state={trustedState} />
                  <Th className="text-right">{''}</Th>
                </THead>
                <TBody>
                  {trustedSorted.map(({ t, i }) => (
                    <Tr key={i} onClick={() => setTrustedEdit(i)}>
                      <Td><div className={t.enabled === false ? offCls : undefined}>{groupBadges(t.groupIds)}</div></Td>
                      <Td>
                        <div className={`flex flex-col gap-1.5 ${t.enabled === false ? offCls : ''}`}>
                          {t.excludedTargets?.length ? (
                            <div className="flex flex-wrap gap-1.5">
                              {t.excludedTargets.map((x) => <Badge key={`${x.type}-${x.id}`} tone="red" icon={<Ban size={11} />}>{x.name || x.id}</Badge>)}
                            </div>
                          ) : null}
                          {networkScope(t)}
                          {!t.excludedTargets?.length && !(t.networkMode && t.networkMode !== 'all' && t.networks?.length) && (
                            <span className="text-nb-gray-500 text-xs italic">None</span>
                          )}
                        </div>
                      </Td>
                      <Td><span className={t.enabled === false ? offCls : undefined}>{capBadge(t.maxMinutes)}</span></Td>
                      <Td className="text-right">
                        <div className="inline-flex items-center gap-2.5">
                          <MiniToggle checked={t.enabled !== false} title={t.enabled === false ? 'Paused - click to enable' : 'Active - click to pause'}
                            onChange={() => setTrustedEnabled(i, t.enabled === false)} />
                          <IconButton onClick={(e) => del(e, () => persist({ trusted: trusted.filter((_, idx) => idx !== i) }))} title="Remove" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
            <div className="md:hidden flex flex-col gap-2.5">
              {trusted.map((t, i) => (
                <div key={i} onClick={() => setTrustedEdit(i)} className={cardCls}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">{groupBadges(t.groupIds)}</div>
                    <span className="shrink-0 inline-flex items-center gap-1.5">
                      {capBadge(t.maxMinutes)}
                      <MiniToggle checked={t.enabled !== false} title={t.enabled === false ? 'Paused - click to enable' : 'Active - click to pause'}
                        onChange={() => setTrustedEnabled(i, t.enabled === false)} />
                      <IconButton onClick={(e) => del(e, () => persist({ trusted: trusted.filter((_, idx) => idx !== i) }))} title="Remove" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                    </span>
                  </div>
                  {t.excludedTargets?.length ? (
                    <div className="mt-2">
                      <div className="text-[0.7rem] uppercase tracking-wide text-nb-gray-400 mb-1">Blocked</div>
                      <div className="flex flex-wrap gap-1.5">{t.excludedTargets.map((x) => <Badge key={`${x.type}-${x.id}`} tone="red" icon={<Ban size={11} />}>{x.name || x.id}</Badge>)}</div>
                    </div>
                  ) : null}
                  {networkScope(t) && <div className="mt-2">{networkScope(t)}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Self-service rules */}
      <div>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-nb-gray-900 dark:text-nb-gray-50"><Zap size={17} className="text-netbird" /> Self-Service Resources</h2>
            <p className="text-sm text-nb-gray-500 mt-0.5">Requests for these targets are approved automatically for members of the allowed groups, up to the rule's max duration.</p>
          </div>
          <Button variant="primary" className="shrink-0" onClick={() => setRuleEdit('new')}><Plus size={15} /><span className="hidden sm:inline">Add Rule</span></Button>
        </div>
        {!rules.length ? (
          <EmptyState title="No Self-Service Rules" hint="Add a rule to let chosen groups get resources, networks or access profiles on demand - no approval needed." icon={<Zap size={22} />} />
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <THead>
                  <SortTh label="Targets" sortKey="targets" state={rulesState} />
                  <SortTh label="Allowed Groups" sortKey="groups" state={rulesState} />
                  <SortTh label="Granted Access" sortKey="access" state={rulesState} />
                  <SortTh label="Max Duration" sortKey="maxDuration" state={rulesState} />
                  <Th className="text-right">{''}</Th>
                </THead>
                <TBody>
                  {rulesSorted.map(({ r, i }) => (
                    <Tr key={i} onClick={() => setRuleEdit(i)}>
                      <Td>
                        <div className={`flex flex-wrap gap-1.5 ${r.enabled === false ? offCls : ''}`}>
                          {r.targets.map((t) => <Badge key={`${t.type}-${t.id}`} tone="gray" icon={<span className="inline-flex">{TARGET_META[t.type].icon}</span>}>{t.name || t.id}</Badge>)}
                        </div>
                      </Td>
                      <Td><div className={r.enabled === false ? offCls : undefined}>{groupBadges(r.groupIds)}</div></Td>
                      <Td><div className={r.enabled === false ? offCls : undefined}>{accessBadges(r.access)}</div></Td>
                      <Td><span className={r.enabled === false ? offCls : undefined}>{capBadge(r.maxMinutes)}</span></Td>
                      <Td className="text-right">
                        <div className="inline-flex items-center gap-2.5">
                          <MiniToggle checked={r.enabled !== false} title={r.enabled === false ? 'Paused - click to enable' : 'Active - click to pause'}
                            onChange={() => setRuleEnabled(i, r.enabled === false)} />
                          <IconButton onClick={(e) => del(e, () => persist({ rules: rules.filter((_, idx) => idx !== i) }))} title="Remove rule" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
            <div className="md:hidden flex flex-col gap-2.5">
              {rules.map((r, i) => (
                <div key={i} onClick={() => setRuleEdit(i)} className={cardCls}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex flex-wrap gap-1.5">
                      {r.targets.map((t) => <Badge key={`${t.type}-${t.id}`} tone="gray" icon={<span className="inline-flex">{TARGET_META[t.type].icon}</span>}>{t.name || t.id}</Badge>)}
                    </div>
                    <span className="shrink-0 inline-flex items-center gap-1.5">
                      {capBadge(r.maxMinutes)}
                      <MiniToggle checked={r.enabled !== false} title={r.enabled === false ? 'Paused - click to enable' : 'Active - click to pause'}
                        onChange={() => setRuleEnabled(i, r.enabled === false)} />
                      <IconButton onClick={(e) => del(e, () => persist({ rules: rules.filter((_, idx) => idx !== i) }))} title="Remove rule" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                    </span>
                  </div>
                  <div className="mt-2">
                    <div className="text-[0.7rem] uppercase tracking-wide text-nb-gray-400 mb-1">Allowed Groups</div>
                    {groupBadges(r.groupIds)}
                  </div>
                  <div className="mt-2">
                    <div className="text-[0.7rem] uppercase tracking-wide text-nb-gray-400 mb-1">Granted Access</div>
                    {accessBadges(r.access)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {trustedEdit !== null && (
        <TrustedModal adGroups={adGroups || []} busy={save.isPending}
          initial={typeof trustedEdit === 'number' ? trusted[trustedEdit] : undefined}
          onSubmit={async (entry) => { await persist({ trusted: upsert(trusted, trustedEdit, entry) }); setTrustedEdit(null); }}
          onClose={() => setTrustedEdit(null)} />
      )}
      {ruleEdit !== null && (
        <RuleModal adGroups={adGroups || []} busy={save.isPending}
          initial={typeof ruleEdit === 'number' ? rules[ruleEdit] : undefined}
          onSubmit={async (rule) => { await persist({ rules: upsert(rules, ruleEdit, rule) }); setRuleEdit(null); }}
          onClose={() => setRuleEdit(null)} />
      )}
    </div>
  );
}

const MAX_HINT = 'The requested duration is honored up to this. Blank = as requested (no cap).';

const NETWORK_MODES = [
  { value: 'all', label: 'Any Network' },
  { value: 'allow', label: 'Only These Networks' },
  { value: 'block', label: 'Any Except These Networks' },
];

function TrustedModal({ adGroups, busy, initial, onSubmit, onClose }: {
  adGroups: { id: string; name: string }[];
  busy: boolean;
  initial?: AutoApprovalTrusted;
  onSubmit: (entry: AutoApprovalTrusted) => Promise<void>;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<string[]>(initial?.groupIds || []);
  const [maxHours, setMaxHours] = useState(minutesToHours(initial?.maxMinutes || 0));
  const [blocked, setBlocked] = useState<GrantTarget[]>(asTargets(initial?.excludedTargets || []));
  const [networkMode, setNetworkMode] = useState<'all' | 'allow' | 'block'>(initial?.networkMode || 'all');
  const [netIds, setNetIds] = useState<string[]>((initial?.networks || []).map((n) => n.id));
  const allNetworks = useNetworks().data || [];
  const netRefs = allNetworks.map((n) => ({ id: n.id, name: n.name || n.id }));
  const editing = !!initial;

  const submit = () => onSubmit({
    groupIds: groups, maxMinutes: hoursToMinutes(maxHours),
    excludedTargets: blocked.map((t) => ({ type: t.type, id: t.id, name: t.name })),
    networkMode: netIds.length ? networkMode : 'all',
    networks: netIds.map((id) => ({ id, name: netRefs.find((n) => n.id === id)?.name || id })),
    enabled: initial ? initial.enabled !== false : true, // editing must not silently re-enable a paused entry
  }).catch(() => { });

  return (
    <Modal open onClose={onClose} size="md" icon={<ShieldCheck size={18} />}
      title={editing ? 'Edit Trusted Groups' : 'Add Trusted Groups'}
      subtitle="Members are approved automatically for any request, except the blocked targets."
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || !groups.length}>{busy ? '…' : editing ? 'Save' : 'Add'}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <Field label="Groups">
          <GroupMultiSelect groups={adGroups} value={groups} onChange={setGroups} placeholder="Select groups…" />
        </Field>
        <Field label="Blocked Targets (Optional)" hint="Critical resources this entry must NOT auto-approve - requests for them go to normal review.">
          <TargetSearch chosen={blocked} onPick={(t) => setBlocked((p) => [...p, t])} placeholder="Search resources, networks or access profiles…" />
          {blocked.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {blocked.map((t, i) => (
                <span key={`${t.type}-${t.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 pl-2 pr-1 py-1 text-[0.78rem]">
                  <Ban size={11} className="text-red-500" />
                  <span className="text-nb-gray-700 dark:text-nb-gray-200">{t.name}</span>
                  <button type="button" onClick={() => setBlocked((p) => p.filter((_, idx) => idx !== i))} className="text-nb-gray-400 hover:text-red-500"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </Field>
        <Field label="Network Scope" hint={networkMode === 'allow'
          ? 'Auto-approve ONLY networks/resources inside the selected networks - everything else goes to review (profiles and groups too, since they aren’t network-bound).'
          : networkMode === 'block'
            ? 'Auto-approve anywhere EXCEPT the selected networks - the networks themselves and any resource in them go to review.'
            : 'Requests for any network are eligible. Pick a mode to approve or block whole networks (including their resources).'}>
          <div className="flex flex-col gap-2">
            <SelectMenu value={networkMode} onChange={(v) => setNetworkMode(v as 'all' | 'allow' | 'block')} searchable={false} options={NETWORK_MODES} />
            {networkMode !== 'all' && (
              <GroupMultiSelect groups={netRefs} value={netIds} onChange={setNetIds}
                placeholder="Select networks…" searchPlaceholder="Search networks…" />
            )}
          </div>
        </Field>
        <Field label="Max Duration (Hours)" hint={MAX_HINT}>
          <Input value={maxHours} onChange={(e) => setMaxHours(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="No cap" className="w-40" />
        </Field>
      </div>
    </Modal>
  );
}

function RuleModal({ adGroups, busy, initial, onSubmit, onClose }: {
  adGroups: { id: string; name: string }[];
  busy: boolean;
  initial?: AutoApprovalRule;
  onSubmit: (rule: AutoApprovalRule) => Promise<void>;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<string[]>(initial?.groupIds || []);
  const [targets, setTargets] = useState<GrantTarget[]>(asTargets(initial?.targets || []));
  const [maxHours, setMaxHours] = useState(minutesToHours(initial?.maxMinutes || 0));
  const editing = !!initial;

  // Granted access: 'auto' mirrors the target's existing exposure (the original behavior);
  // 'custom' pins exact protocols/ports - each enabled protocol becomes its own temp policy.
  const acc = initial?.access || null;
  const [accessMode, setAccessMode] = useState<'auto' | 'custom'>(acc ? 'custom' : 'auto');
  const [tcpOn, setTcpOn] = useState(!!(acc && acc.tcp !== undefined));
  const [tcpPorts, setTcpPorts] = useState<string[]>(acc?.tcp || []);
  const [udpOn, setUdpOn] = useState(!!(acc && acc.udp !== undefined));
  const [udpPorts, setUdpPorts] = useState<string[]>(acc?.udp || []);
  const [icmpOn, setIcmpOn] = useState(!!acc?.icmp);
  const customEmpty = accessMode === 'custom' && !tcpOn && !udpOn && !icmpOn;

  const submit = () => onSubmit({
    targets: targets.map((t) => ({ type: t.type, id: t.id, name: t.name })),
    groupIds: groups, maxMinutes: hoursToMinutes(maxHours),
    access: accessMode === 'custom' && !customEmpty
      ? { ...(tcpOn ? { tcp: tcpPorts } : {}), ...(udpOn ? { udp: udpPorts } : {}), ...(icmpOn ? { icmp: true } : {}) }
      : null,
    enabled: initial ? initial.enabled !== false : true, // editing must not silently re-enable a paused rule
  }).catch(() => { });

  return (
    <Modal open onClose={onClose} size="md" icon={<Zap size={18} />}
      title={editing ? 'Edit Self-Service Rule' : 'Add Self-Service Rule'}
      subtitle="Members of the allowed groups get these targets instantly when they request them."
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || !targets.length || !groups.length || customEmpty}>{busy ? '…' : editing ? 'Save' : 'Add Rule'}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <Field label="Allowed Groups" hint="Members may get these targets on demand.">
          <GroupMultiSelect groups={adGroups} value={groups} onChange={setGroups} placeholder="Select groups…" />
        </Field>
        <Field label="Targets" hint="Pick one or more resources, networks or access profiles.">
          <TargetSearch chosen={targets} onPick={(t) => setTargets((p) => [...p, t])} />
          {targets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {targets.map((t, i) => (
                <span key={`${t.type}-${t.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900 pl-2 pr-1 py-1 text-[0.78rem]">
                  <span className="text-nb-gray-400">{TARGET_META[t.type].icon}</span>
                  <span className="text-nb-gray-700 dark:text-nb-gray-200">{t.name}</span>
                  <button type="button" onClick={() => setTargets((p) => p.filter((_, idx) => idx !== i))} className="text-nb-gray-400 hover:text-red-500"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </Field>
        <Field label="Granted Access" hint={accessMode === 'auto'
          ? 'The grant mirrors each target’s existing policy exposure (a resource open only on TCP 1433 stays TCP 1433); a target with no policies gets full access.'
          : 'The grant opens exactly these protocols/ports - behind the scenes each protocol becomes its own policy (NetBird can’t mix TCP/UDP/ICMP in one).'}>
          <div className="flex flex-col gap-2.5">
            <SelectMenu value={accessMode} onChange={(v) => setAccessMode(v as 'auto' | 'custom')} searchable={false}
              options={[
                { value: 'auto', label: 'As Currently Exposed (Automatic)' },
                { value: 'custom', label: 'Custom Protocols & Ports' },
              ]} />
            {accessMode === 'custom' && (
              <div className="flex flex-col gap-2.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-3">
                <div className="flex items-start gap-3">
                  <label className="flex items-center gap-2 w-20 shrink-0 pt-3 cursor-pointer text-sm text-nb-gray-800 dark:text-nb-gray-200">
                    <Checkbox checked={tcpOn} onChange={(e) => setTcpOn(e.target.checked)} /> TCP
                  </label>
                  <div className={tcpOn ? 'flex-1' : 'flex-1 opacity-40 pointer-events-none'}>
                    <PortSelector value={tcpPorts} onChange={setTcpPorts} disabled={!tcpOn} />
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <label className="flex items-center gap-2 w-20 shrink-0 pt-3 cursor-pointer text-sm text-nb-gray-800 dark:text-nb-gray-200">
                    <Checkbox checked={udpOn} onChange={(e) => setUdpOn(e.target.checked)} /> UDP
                  </label>
                  <div className={udpOn ? 'flex-1' : 'flex-1 opacity-40 pointer-events-none'}>
                    <PortSelector value={udpPorts} onChange={setUdpPorts} disabled={!udpOn} />
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-sm text-nb-gray-800 dark:text-nb-gray-200">
                  <Checkbox checked={icmpOn} onChange={(e) => setIcmpOn(e.target.checked)} /> ICMP (Ping)
                </label>
                <FieldHint>Leave a protocol’s port list empty to allow all of its ports. {customEmpty && <span className="text-red-500">Enable at least one protocol.</span>}</FieldHint>
              </div>
            )}
          </div>
        </Field>
        <Field label="Max Duration (Hours)" hint={MAX_HINT}>
          <Input value={maxHours} onChange={(e) => setMaxHours(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="No cap" className="w-40" />
        </Field>
      </div>
    </Modal>
  );
}
