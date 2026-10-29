import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRightLeft, ShieldCheck, Text as TextIcon, FolderDown, FolderInput, Shield, Power,
  MoveRight, MoveLeft, Plus, Share2, FolderSearch, X, Copy, ClipboardPaste, Check,
} from 'lucide-react';
import { Modal, Tabs, Input, SelectMenu, Label, FieldHint, Checkbox, Button, GroupMultiSelect, PortSelector } from '@/components/ui';
import { META, activeMetas, CertInfoLine, CERT_MOBILE_NOTE, CERT_VERSION_NOTE, type Meta } from '@/components/settings/PostureChecks';
import { useGroups, usePostureChecks, useCountries, useCaCertInspection } from '@/lib/queries';
import { writePolicyClipboard, readPolicyClipboard } from '@/lib/policyClipboard';
import { useSavePolicy } from '@/lib/mutations';
import type { Policy, PolicyGroupRef, PolicyInput, AccessProfile, PostureCheck } from '@/lib/types';
import { cn } from '@/lib/cn';

type Tab = 'policy' | 'posture' | 'general';

function idsOf(items?: PolicyGroupRef[]): string[] {
  return (items || []).map((g) => g.id).filter(Boolean);
}

// Embedded ("staged") mode: the SAME modal, used from Edit Resource → Access Control.
// Instead of hitting the policies API, the result is handed back to the resource form
// and saved together with the resource. The destination is fixed to the resource.
export interface StagedPolicyCtx {
  initial: PolicyInput | null;
  resourceName: string;
  /** Prefill for a NEW staged policy's name (e.g. "My Server Policy"). */
  defaultName: string;
  /** Admin-configured template (Settings → General), e.g. "{resource} - {protocol}". The
   *  suggested name follows protocol changes until the user types their own. NetBird allows
   *  duplicate policy names, so no dedup suffix is added. */
  nameTemplate?: string;
  groups: { id: string; name: string }[];
  /** Pre-selected sources for a NEW staged policy (the network's default source groups). */
  defaultSourceIds: string[];
  /** false = sources come from Network Access config and are read-only here. */
  canChooseSources: boolean;
  presets: AccessProfile[];
  onSave: (p: PolicyInput) => void;
}

// duplicateOf: prefill a NEW policy from an existing one (Policies → Duplicate). It is prefill
// data only - `policy` stays the edit identity, so a duplicate is always created, never updated.
export function PolicyModal({ policy, onClose, staged, initialSources, duplicateOf }: { policy: Policy | null; onClose: () => void; staged?: StagedPolicyCtx; initialSources?: string[]; duplicateOf?: Policy | null }) {
  const groupsQ = useGroups(!staged);
  const postureQ = usePostureChecks();
  const save = useSavePolicy();

  const src = policy || duplicateOf || null; // prefill source (never mutated)
  const rule = (src?.rules && src.rules[0]) || undefined;
  const allRules = src?.rules || [];
  // A policy may target specific resources (a rule's destinationResource) instead of groups;
  // collect all of them so the destination shows every resource, not just the first rule's.
  const destResources = staged
    ? [{ id: 'staged', name: staged.resourceName, type: '' }]
    : (allRules.map((r) => r.destinationResource).filter(Boolean) as NonNullable<typeof rule>['destinationResource'][]);
  const resourceTargeted = destResources.length > 0;
  const multiRule = allRules.length > 1;
  const editing = staged ? !!staged.initial : !!policy;
  // A duplicate whose rules the single-rule form can't reproduce exactly (several rules, a
  // disabled or drop rule, SSH / source-resource fields) is created with the source's rules
  // copied verbatim server-side; only name / description / status / posture come from the form.
  const notReproducible = !!src && (multiRule || !!rule && (
    !!rule.unmodeled || (rule.action || 'accept') !== 'accept' || (rule.enabled !== false) !== (src.enabled !== false)));
  const copyRules = !!duplicateOf && !!duplicateOf.id && notReproducible;
  // Editing such a policy keeps its rules verbatim too (the server refuses a rebuild).
  const keepRules = editing && notReproducible;
  // In both modes the rule fields are shown read-only: the save ignores them.
  const rulesLocked = !staged && (copyRules || keepRules);
  const [tab, setTab] = useState<Tab>('policy');

  // Suggested name from the admin's template ({resource} / {protocol} placeholders).
  // Falls back to defaultName when no template is configured.
  const suggestName = (proto: string): string => {
    if (!staged) return '';
    if (!staged.nameTemplate) return staged.defaultName;
    return staged.nameTemplate
      .replace(/\{resource\}/gi, staged.resourceName)
      .replace(/\{protocol\}/gi, (proto || 'all').toUpperCase())
      .trim() || staged.defaultName;
  };

  const [name, setName] = useState(staged ? (staged.initial?.name || suggestName(staged.initial?.protocol || 'tcp')) : duplicateOf ? `${duplicateOf.name || 'Policy'} (copy)` : (policy?.name || ''));
  const [description, setDescription] = useState(staged ? (staged.initial?.description || '') : (src?.description || ''));
  const [enabled, setEnabled] = useState(staged ? staged.initial?.enabled !== false : src?.enabled !== false);
  // Staged: a NEW policy always prefills the network's default source groups
  // (Network Access edit-grants marked as policy sources); editing keeps what's stored.
  // Standalone create (e.g. the group detail's "Add Policy") can prefill the source group via
  // initialSources; editing an existing policy always reads its stored rule sources.
  const [sources, setSources] = useState<string[]>(
    staged ? (staged.initial ? staged.initial.sources.slice() : staged.defaultSourceIds.slice())
      : (src ? idsOf(rule?.sources) : (initialSources || [])),
  );
  const [destinations, setDestinations] = useState<string[]>(staged ? [] : idsOf(rule?.destinations));
  const [protocol, setProtocol] = useState(staged ? (staged.initial?.protocol || 'tcp') : (rule?.protocol || 'all'));
  const [ports, setPorts] = useState<string[]>(staged ? (staged.initial?.ports || []) : (rule?.ports || []).slice());
  const [bidirectional, setBidirectional] = useState(staged ? !!staged.initial?.bidirectional : (rule ? !!rule.bidirectional : true));
  const [postureChecks, setPostureChecks] = useState<string[]>(staged ? (staged.initial?.postureChecks || []) : (src?.postureChecks || []).slice());
  const [browseChecks, setBrowseChecks] = useState(false);
  const [detailCheck, setDetailCheck] = useState<PostureCheck | null>(null);
  const [error, setError] = useState('');

  const portDisabled = !(protocol === 'tcp' || protocol === 'udp');
  const groupOpts = useMemo(
    () => staged ? staged.groups : (groupsQ.data || []).map((g) => ({ id: g.id, name: g.name })),
    [staged, groupsQ.data],
  );
  const postureList = useMemo(() => postureQ.data || [], [postureQ.data]);

  const canContinue = copyRules || keepRules || (sources.length > 0 && (destinations.length > 0 || resourceTargeted));
  const canSubmit = !!name.trim() && canContinue;

  const togglePosture = (id: string) =>
    setPostureChecks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Protocol changes keep the SUGGESTED name in sync (e.g. "DC - TCP" → "DC - UDP") - but
  // only while the field still holds the previous suggestion; a hand-typed name is never touched.
  const changeProtocol = (v: string) => {
    if (staged && !staged.initial && name === suggestName(protocol)) setName(suggestName(v));
    setProtocol(v);
  };

  const applyPreset = (id: string) => {
    const t = staged?.presets.find((x) => String(x.id) === id);
    if (t) { changeProtocol(t.protocol || 'all'); setPorts((t.ports || []).slice()); }
  };

  // Copy the WHOLE policy (every form field) to the clipboard as tagged JSON, and paste it
  // into any other policy editor - regular or per-resource. Destination is never pasted into
  // a resource-targeted policy (it's fixed), and group ids unknown in the paste context are
  // dropped instead of becoming phantom selections.
  const [clip, setClip] = useState<'idle' | 'copied' | 'pasted' | 'fail'>('idle');
  const flash = (s: 'copied' | 'pasted' | 'fail') => { setClip(s); setTimeout(() => setClip('idle'), 1500); };
  const copyPolicy = async () => {
    try {
      await writePolicyClipboard({
        name: name.trim(), description: description.trim(), enabled,
        sources, destinations: staged ? [] : destinations, protocol, ports, bidirectional, postureChecks,
      });
      flash('copied');
    } catch { flash('fail'); }
  };
  const pastePolicy = async () => {
    const p = await readPolicyClipboard();
    if (!p) { flash('fail'); return; }
    const knownGroup = (id: string) => groupOpts.some((g) => g.id === id);
    if (typeof p.name === 'string' && p.name) setName(p.name);
    if (typeof p.description === 'string') setDescription(p.description);
    if (typeof p.enabled === 'boolean') setEnabled(p.enabled);
    if (Array.isArray(p.postureChecks)) setPostureChecks(p.postureChecks.map(String).filter((id: string) => postureList.some((c) => c.id === id)));
    // Locked rules are kept as stored - pasting into them would show changes that are never saved.
    if (rulesLocked) { flash('pasted'); return; }
    if (typeof p.protocol === 'string') setProtocol(p.protocol);
    if (Array.isArray(p.ports)) setPorts(p.ports.map(String).filter(Boolean));
    if (typeof p.bidirectional === 'boolean') setBidirectional(p.bidirectional);
    if (Array.isArray(p.sources) && (!staged || staged.canChooseSources)) setSources(p.sources.map(String).filter(knownGroup));
    if (Array.isArray(p.destinations) && !resourceTargeted) setDestinations(p.destinations.map(String).filter(knownGroup));
    flash('pasted');
  };
  const clipBtns = (
    <div className="mr-auto flex items-center gap-1.5">
      <Button variant="secondary" size="sm" onClick={copyPolicy} disabled={rulesLocked}
        title={rulesLocked ? "This policy's rules can't be copied from here - duplicate it from the Policies list instead" : "Copy this policy's full configuration"}>
        {clip === 'copied' ? <Check size={14} className="text-green-500" /> : <Copy size={14} />} Copy
      </Button>
      <Button variant="secondary" size="sm" onClick={pastePolicy} title="Paste a copied policy configuration">
        {clip === 'pasted' ? <Check size={14} className="text-green-500" /> : clip === 'fail' ? <X size={14} className="text-red-500" /> : <ClipboardPaste size={14} />} Paste
      </Button>
    </div>
  );

  const submit = async () => {
    if (!canSubmit) { setError('A name, at least one source and one destination are required.'); return; }
    setError('');
    if (staged) {
      staged.onSave({
        sources, protocol, ports: portDisabled ? [] : ports,
        name: name.trim(), description: description.trim(), enabled, bidirectional, postureChecks,
      });
      onClose();
      return;
    }
    try {
      await save.mutateAsync({
        id: policy?.id,
        payload: {
          name: name.trim(), description: description.trim(), enabled,
          sources, destinations, destinationResource: destResources[0] || undefined,
          // Multi-rule policies can't be represented by the single-rule editor — keep their rules
          // verbatim and save only name / description / enabled / posture.
          preserveRules: keepRules,
          rulesFromPolicyId: copyRules ? duplicateOf!.id : undefined,
          protocol, ports: portDisabled ? [] : ports,
          bidirectional, postureChecks,
        },
      });
      onClose();
    } catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  const tabItems = [
    { key: 'policy', label: <span className="inline-flex items-center gap-2"><ArrowRightLeft size={15} /> Policy</span> },
    { key: 'posture', label: <span className="inline-flex items-center gap-2"><ShieldCheck size={15} /> Posture Checks</span> },
    { key: 'general', label: <span className="inline-flex items-center gap-2"><TextIcon size={15} /> Name &amp; Description</span> },
  ];

  return (
    <>
    <Modal
      open
      onClose={onClose}
      icon={<ArrowRightLeft size={18} />}
      title={editing ? 'Update Access Control Policy' : 'Create New Access Control Policy'}
      subtitle={staged ? `Restricts access to the resource "${staged.resourceName}". Saved together with the resource.` : 'Use this policy to restrict access to groups of resources.'}
      size="lg"
      tabs={<Tabs bordered={false} items={tabItems} value={tab} onChange={(k) => setTab(k as Tab)} />}
      footer={
        editing ? (
          <>
            {clipBtns}
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending || !canSubmit}>
              {save.isPending ? '…' : 'Save Changes'}
            </Button>
          </>
        ) : (
          <>
            {clipBtns}
            {tab === 'policy' && <>
              <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => setTab('posture')} disabled={!canContinue}>Continue</Button>
            </>}
            {tab === 'posture' && <>
              <Button variant="secondary" size="sm" onClick={() => setTab('policy')}>Back</Button>
              <Button variant="primary" size="sm" onClick={() => setTab('general')} disabled={!canContinue}>Continue</Button>
            </>}
            {tab === 'general' && <>
              <Button variant="secondary" size="sm" onClick={() => setTab('posture')}>Back</Button>
              <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending || !canSubmit}>
                <Plus size={15} /> {save.isPending ? 'Adding…' : 'Add Policy'}
              </Button>
            </>}
          </>
        )
      }
    >
      {tab === 'policy' && (
        <div className="flex flex-col gap-6">
          {rulesLocked && (
            <div className="rounded-md border border-nb-blue-400/30 bg-nb-blue-400/10 px-3 py-2.5 text-[0.78rem] text-nb-blue-600 dark:text-nb-blue-400">
              This policy has rules this editor can't reproduce exactly (several rules, a disabled or Drop rule, an SSH rule, or source-resource settings).{' '}
              {copyRules ? 'The duplicate keeps all of them as they are' : 'Saving here keeps them as they are'} - you can change the name, description, status and posture checks here, and edit the rules in the NetBird dashboard.
            </div>
          )}
          <fieldset disabled={rulesLocked} aria-disabled={rulesLocked || undefined}
            className={cn('flex flex-col gap-6 min-w-0', rulesLocked && 'opacity-60 pointer-events-none select-none')}>
          {/* Protocol */}
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center sm:gap-10">
            <div className="flex flex-col gap-1">
              <Label>Protocol</Label>
              <FieldHint>
                Allow only specified network protocols. To change traffic direction and ports, select{' '}
                <b className="text-nb-gray-700 dark:text-nb-gray-200">TCP</b> or <b className="text-nb-gray-700 dark:text-nb-gray-200">UDP</b> protocol.
              </FieldHint>
            </div>
            <SelectMenu className="w-full sm:w-[280px] shrink-0" value={protocol} onChange={changeProtocol} searchable={false}
              options={[
                { value: 'all', label: 'ALL' },
                { value: 'tcp', label: 'TCP' },
                { value: 'udp', label: 'UDP' },
                { value: 'icmp', label: 'ICMP' },
                ...(['all', 'tcp', 'udp', 'icmp'].includes(protocol) ? [] : [{ value: protocol, label: protocol.toUpperCase() }]),
              ]} />
          </div>

          {/* Access Profile preset - staged (per-resource) mode only. Always visible so the
              feature is discoverable even before any Direct profile exists. */}
          {staged && (
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center sm:gap-10">
              <div className="flex flex-col gap-1">
                <Label>Access Profile (Preset)</Label>
                <FieldHint>Apply a Direct profile's protocol/ports. Manage profiles in Operations → Access Profiles.</FieldHint>
              </div>
              <SelectMenu className="w-full sm:w-[280px] shrink-0" value="" onChange={(v) => applyPreset(v)}
                placeholder={staged.presets.length ? 'Custom' : 'No Direct profiles yet'}
                disabled={!staged.presets.length}
                options={staged.presets.map((t) => ({ value: String(t.id), label: t.name }))} />
            </div>
          )}

          {/* Source ↔ Destination */}
          <div className="flex flex-col gap-4 sm:flex-row sm:gap-5 sm:items-center">
            <div className="w-full self-start flex flex-col gap-2">
              <Label className="flex items-center gap-2"><FolderDown size={15} /> Source</Label>
              {staged && !staged.canChooseSources ? (
                <>
                  <div className="min-h-[44px] flex items-center flex-wrap gap-1.5 rounded-md border border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 px-3 py-2">
                    {groupOpts.length ? groupOpts.map((g) => (
                      <span key={g.id} className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 px-2.5 py-1 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-300">{g.name}</span>
                    )) : <span className="text-sm text-nb-gray-500">No groups configured in Network Access</span>}
                  </div>
                  <FieldHint>Source groups are pulled automatically from this network's access groups.</FieldHint>
                </>
              ) : (
                <>
                  <GroupMultiSelect groups={groupOpts} value={sources} onChange={setSources} placeholder="Select source(s)…" />
                  {/* A new staged policy prefills the network's default source groups; when the
                      network has none configured, say WHY the field opened empty. */}
                  {staged && !staged.initial && staged.defaultSourceIds.length === 0 && sources.length === 0 && (
                    <FieldHint>
                      No default source groups for this network - set them under the network's <b>Network Access</b> (edit grants are used as policy sources).
                    </FieldHint>
                  )}
                </>
              )}
            </div>
            <PolicyDirection value={bidirectional} onChange={setBidirectional} />
            <div className="w-full self-start flex flex-col gap-2">
              <Label className="flex items-center gap-2"><FolderInput size={15} /> Destination</Label>
              {resourceTargeted ? (
                <>
                  <div className="min-h-[44px] flex items-center flex-wrap gap-1.5 rounded-md border border-neutral-200 dark:border-nb-gray-700 bg-white dark:bg-nb-gray-900/40 px-3 py-2">
                    {destResources.map((r) => (
                      <span key={r!.id} className="inline-flex items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 px-2.5 py-1 text-[0.78rem] text-nb-gray-700 dark:text-nb-gray-300">
                        <Share2 size={12} className="shrink-0" /> {r!.name}
                      </span>
                    ))}
                  </div>
                  <FieldHint>
                    {multiRule && !staged
                      ? 'Targets these specific resources (managed automatically) — only the name and status are saved here.'
                      : 'This policy targets a specific resource, not groups.'}
                  </FieldHint>
                </>
              ) : (
                <GroupMultiSelect groups={groupOpts} value={destinations} onChange={setDestinations} placeholder="Select destination(s)…" />
              )}
            </div>
          </div>

          {/* Ports */}
          <div className={cn('flex flex-col gap-2', portDisabled && 'opacity-30 pointer-events-none')}>
            <div className="flex flex-col gap-1">
              <Label className="flex items-center gap-2"><Shield size={14} /> Ports</Label>
              <FieldHint>Allow network traffic and access only to specified ports. Select ports or port ranges between 1 and 65535.</FieldHint>
            </div>
            <PortSelector value={ports} onChange={setPorts} disabled={portDisabled} />
          </div>
          </fieldset>

          {/* Enable Policy */}
          <div className="flex items-center justify-between gap-4 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-4 py-3.5">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100"><Power size={15} /> Enable Policy</div>
              <p className="mt-0.5 text-[0.78rem] text-nb-gray-500">Use this switch to enable or disable the policy.</p>
            </div>
            <Toggle checked={enabled} onChange={setEnabled} />
          </div>
        </div>
      )}

      {tab === 'posture' && (
        <div className="flex flex-col gap-4">
          {/* Header mirrors the official dashboard: count + hint left, Browse right. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50">
                {postureChecks.length} Posture Check{postureChecks.length === 1 ? '' : 's'}
              </div>
              <FieldHint>Use posture checks to further restrict access in your network.</FieldHint>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setBrowseChecks(true)}>
              <FolderSearch size={15} /> Browse Checks
            </Button>
          </div>

          {postureChecks.length === 0 ? (
            <div className="rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 px-4 py-6 text-center text-sm text-nb-gray-500">
              No posture checks attached. <b>Browse Checks</b> to attach one, or create new ones in Operations → Posture Checks.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {postureChecks.map((id) => {
                const pc = postureList.find((x) => x.id === id);
                if (!pc) return null;
                return (
                  <div key={id} onClick={() => setDetailCheck(pc)}
                    className="flex items-center justify-between gap-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 px-4 py-3 cursor-pointer hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40 transition-colors"
                    title="Click to see what this check enforces">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100 truncate">{pc.name}</div>
                      {pc.description && <div className="text-[0.76rem] text-nb-gray-500 truncate">{pc.description}</div>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {activeMetas(pc.checks).map((m, i) => (
                        <span key={i} title={m.title} onClick={() => setDetailCheck(pc)}
                          className={cn('h-7 w-7 rounded-md flex items-center justify-center shadow-sm cursor-pointer', m.iconClass)}>{m.icon}</span>
                      ))}
                      <button onClick={() => togglePosture(id)} title="Detach from this policy"
                        className="ml-1 text-nb-gray-400 hover:text-red-500 transition-colors"><X size={16} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'general' && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label>Name of the Rule</Label>
            <FieldHint>Set an easily identifiable name for your policy.</FieldHint>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Devs to Servers" autoFocus />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Description (optional)</Label>
            <FieldHint>Write a short description to add more context to this policy.</FieldHint>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="e.g. Devs are allowed to access servers."
              className="rounded-md border px-3 py-2 text-sm outline-none transition-colors resize-none bg-white border-nb-gray-200 text-nb-gray-900 placeholder:text-nb-gray-500 dark:bg-nb-gray-900 dark:border-nb-gray-700 dark:text-nb-gray-100 dark:placeholder:text-nb-gray-400/70 focus:ring-2 focus:ring-netbird-400/30 focus:border-netbird/60"
            />
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
    </Modal>

    {browseChecks && (
      <BrowseChecksModal
        checks={postureList}
        selected={postureChecks}
        onToggle={togglePosture}
        onView={setDetailCheck}
        onClose={() => setBrowseChecks(false)}
      />
    )}
    {detailCheck && <PostureCheckDetailModal check={detailCheck} onClose={() => setDetailCheck(null)} />}
    </>
  );
}

// ─── Browse Checks picker: attach/detach existing posture checks ───
function BrowseChecksModal({ checks, selected, onToggle, onView, onClose }: {
  checks: PostureCheck[];
  selected: string[];
  onToggle: (id: string) => void;
  onView: (pc: PostureCheck) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      icon={<FolderSearch size={18} />}
      title="Browse Posture Checks"
      subtitle="Attach existing posture checks to this policy. Click a check's icons to see its configuration."
      footer={<Button variant="primary" size="sm" onClick={onClose}>Done</Button>}
    >
      {checks.length === 0 ? (
        <div className="py-8 text-center text-sm text-nb-gray-500">
          No posture checks configured yet. Create them in Operations → Posture Checks.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {checks.map((pc) => {
            const on = selected.includes(pc.id);
            return (
              <div key={pc.id} className={cn(
                'flex items-center gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors',
                on ? 'border-netbird/40 bg-netbird/5' : 'border-nb-gray-200 dark:border-nb-gray-800 hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40',
              )} onClick={() => onToggle(pc.id)}>
                <Checkbox checked={on} onChange={() => onToggle(pc.id)} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200 truncate">{pc.name}</div>
                  {pc.description && <div className="text-[0.74rem] text-nb-gray-500 truncate">{pc.description}</div>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                  {activeMetas(pc.checks).map((m, i) => (
                    <span key={i} title={`${m.title} - click for details`} onClick={() => onView(pc)}
                      className={cn('h-6 w-6 rounded-md flex items-center justify-center shadow-sm cursor-pointer [&>svg]:h-3.5 [&>svg]:w-3.5', m.iconClass)}>{m.icon}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ─── Read-only detail view of one posture check's configuration ───
const OS_LABELS: { key: keyof NonNullable<PostureCheck['checks']['os_version_check']>; label: string; kernel?: boolean }[] = [
  { key: 'android', label: 'Android' },
  { key: 'darwin', label: 'macOS' },
  { key: 'ios', label: 'iOS' },
  { key: 'linux', label: 'Linux', kernel: true },
  { key: 'windows', label: 'Windows', kernel: true },
];

function ActionPill({ action }: { action: 'allow' | 'deny' }) {
  return action === 'allow' ? (
    <span className="inline-flex items-center rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-0.5 text-[0.72rem] font-medium text-green-600 dark:text-green-400">Allow Only</span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-[0.72rem] font-medium text-red-600 dark:text-red-400">Block</span>
  );
}

function DetailSection({ meta, action, children }: { meta: Meta; action?: 'allow' | 'deny'; children: ReactNode }) {
  return (
    <div className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-4">
      <div className="flex items-center gap-3">
        <span className={cn('h-9 w-9 rounded-md flex items-center justify-center shadow-sm shrink-0', meta.iconClass)}>{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-nb-gray-900 dark:text-nb-gray-100">{meta.title}</div>
          <div className="text-[0.74rem] text-nb-gray-500">{meta.desc}</div>
        </div>
        {action && <ActionPill action={action} />}
      </div>
      <div className="mt-3 pl-12 text-sm text-nb-gray-700 dark:text-nb-gray-300">{children}</div>
    </div>
  );
}

const MonoChip = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 px-2 py-0.5 font-mono text-[0.74rem] text-nb-gray-700 dark:text-nb-gray-300">{children}</span>
);

function PostureCheckDetailModal({ check, onClose }: { check: PostureCheck; onClose: () => void }) {
  const c = check.checks || {};
  const countriesQ = useCountries(!!c.geo_location_check);
  const countryName = (code: string) => (countriesQ.data || []).find((x) => x.country_code === code)?.country_name || code;
  const verOrAny = (v?: string) => (!v || v === '0' ? 'Any version' : v);
  const certPems = c.certificate_check?.ca_certificates || [];
  const certInfo = useCaCertInspection(certPems);

  return (
    <Modal
      open
      onClose={onClose}
      icon={<ShieldCheck size={18} />}
      title={check.name}
      subtitle={check.description?.trim() || 'Read-only view. Edit this check in Operations → Posture Checks.'}
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        {c.nb_version_check && (
          <DetailSection meta={META.nb}>
            Minimum client version: <b className="text-nb-gray-900 dark:text-nb-gray-100">{verOrAny(c.nb_version_check.min_version)}</b>
          </DetailSection>
        )}

        {c.os_version_check && (
          <DetailSection meta={META.os}>
            <div className="flex flex-col gap-1.5">
              {OS_LABELS.filter((o) => c.os_version_check?.[o.key]).map((o) => {
                const entry = c.os_version_check![o.key] as { min_version?: string; min_kernel_version?: string };
                const v = o.kernel ? entry.min_kernel_version : entry.min_version;
                return (
                  <div key={o.key} className="flex items-center justify-between gap-4">
                    <span>{o.label}{o.kernel ? ' (Kernel)' : ''}</span>
                    <MonoChip>{verOrAny(v)}</MonoChip>
                  </div>
                );
              })}
            </div>
          </DetailSection>
        )}

        {c.geo_location_check && (
          <DetailSection meta={META.geo} action={c.geo_location_check.action}>
            <div className="flex flex-wrap gap-1.5">
              {(c.geo_location_check.locations || []).map((l, i) => (
                <MonoChip key={i}>{countryName(l.country_code)}{l.city_name ? ` - ${l.city_name}` : ''}</MonoChip>
              ))}
              {!(c.geo_location_check.locations || []).length && <span className="text-nb-gray-500">No locations listed.</span>}
            </div>
          </DetailSection>
        )}

        {c.peer_network_range_check && (
          <DetailSection meta={META.net} action={c.peer_network_range_check.action}>
            <div className="flex flex-wrap gap-1.5">
              {(c.peer_network_range_check.ranges || []).map((r, i) => <MonoChip key={i}>{r}</MonoChip>)}
              {!(c.peer_network_range_check.ranges || []).length && <span className="text-nb-gray-500">No ranges listed.</span>}
            </div>
          </DetailSection>
        )}

        {c.certificate_check && (
          <DetailSection meta={META.cert}>
            <div className="flex flex-col gap-2.5">
              {certPems.map((_, i) => (
                <div key={i} className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[0.74rem] text-nb-gray-500">CA Certificate {certPems.length > 1 ? i + 1 : ''}</span>
                  {certInfo.data ? <CertInfoLine info={certInfo.data[i]} /> : <span className="text-xs text-nb-gray-500">{certInfo.isError ? "Couldn't read the certificate." : 'Reading…'}</span>}
                </div>
              ))}
              <span className="text-[0.74rem] text-amber-600 dark:text-amber-400">{CERT_MOBILE_NOTE} {CERT_VERSION_NOTE}</span>
            </div>
          </DetailSection>
        )}

        {c.process_check && (
          <DetailSection meta={META.proc}>
            <div className="flex flex-col gap-2">
              {(c.process_check.processes || []).map((p, i) => (
                <div key={i} className="flex flex-col gap-1">
                  {p.windows_path && <div className="flex items-center gap-2"><span className="w-16 shrink-0 text-[0.74rem] text-nb-gray-500">Windows</span><MonoChip>{p.windows_path}</MonoChip></div>}
                  {p.mac_path && <div className="flex items-center gap-2"><span className="w-16 shrink-0 text-[0.74rem] text-nb-gray-500">macOS</span><MonoChip>{p.mac_path}</MonoChip></div>}
                  {p.linux_path && <div className="flex items-center gap-2"><span className="w-16 shrink-0 text-[0.74rem] text-nb-gray-500">Linux</span><MonoChip>{p.linux_path}</MonoChip></div>}
                </div>
              ))}
              {!(c.process_check.processes || []).length && <span className="text-nb-gray-500">No processes listed.</span>}
            </div>
          </DetailSection>
        )}
      </div>
    </Modal>
  );
}

// Bidirectional / one-way toggle: two stacked arrow pills (→ over ←). Green = both ways,
// blue top + gray bottom = one-way (source → destination).
function PolicyDirection({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      title={value ? 'Bidirectional - traffic both ways' : 'One-way - source to destination'}
      className="flex flex-col gap-2 shrink-0 self-center cursor-pointer hover:opacity-80 transition-opacity"
    >
      <DirPill tone={value ? 'green' : 'blue'}><MoveRight size={20} /></DirPill>
      <DirPill tone={value ? 'green' : 'gray'}><MoveLeft size={20} /></DirPill>
    </button>
  );
}

function DirPill({ tone, children }: { tone: 'green' | 'blue' | 'gray'; children: ReactNode }) {
  const tones = {
    green: 'border-green-500/30 bg-green-500/10 text-green-500',
    blue: 'border-nb-blue-400/40 bg-nb-blue-400/10 text-nb-blue-600 dark:text-nb-blue-400',
    gray: 'border-nb-gray-300 dark:border-nb-gray-700 bg-nb-gray-100 dark:bg-nb-gray-900 text-nb-gray-400 dark:text-nb-gray-600',
  };
  return <span className={cn('inline-flex items-center justify-center w-[68px] h-7 rounded-md border', tones[tone])}>{children}</span>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn('relative h-6 w-11 rounded-full transition-colors shrink-0', checked ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700')}
    >
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}
