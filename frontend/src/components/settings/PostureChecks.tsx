import { useMemo, useState, type ReactNode } from 'react';
import {
  Plus, Pencil, Trash2, ShieldCheck, ShieldX, MinusCircle, CircleDot, LayoutList, Text,
  Hexagon, Disc3, Flag, Network, ServerCog, FileKey2, AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePostureChecks, useCountries, useCities, useCaCertInspection } from '@/lib/queries';
import { useSavePostureCheck, useDeletePostureCheck } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import type {
  PostureCheck, PostureCheckInput, PostureChecks as Checks, OsVersionCheck,
  GeoLocationCheck, PeerNetworkRangeCheck, ProcessCheck, CaCertInfo,
} from '@/lib/types';
import {
  Button, IconButton, EmptyState, LoadingState, Table, THead, Th, SortTh, TBody, Tr, Td,
  Modal, Tabs, Field, Input, SelectMenu, Label, FieldHint,
} from '@/components/ui';
import { useTableSort } from '@/lib/useTableSort';
import { useDebounced } from '@/lib/useDebounced';

const WINDOWS_VERSIONS = [{ value: '10.0', label: 'Windows 10' }, { value: '10.0.2', label: 'Windows 11' }];
const IOS_VERSIONS = ['14.0', '15.0', '16.0', '17.0', '18.0'].map((v) => ({ value: v, label: `iOS ${v.split('.')[0]}.x` }));
const MACOS_VERSIONS = [
  ['10.12', 'macOS Sierra'], ['10.13', 'High Sierra'], ['10.14', 'Mojave'], ['10.15', 'Catalina'],
  ['11.0', 'Big Sur'], ['12.0', 'Monterey'], ['13.0', 'Ventura'], ['14.0', 'Sonoma'], ['15.0', 'Sequoia'],
].map(([value, label]) => ({ value, label }));
const ANDROID_VERSIONS = ['8.0', '9.0', '10', '11', '12', '13', '14', '15', '16'].map((v) => ({ value: v, label: `Android ${v}` }));

// Exported: the policy modal's Posture Checks tab reuses these icons/labels so a check
// looks identical wherever it appears.
export type Meta = { icon: ReactNode; iconClass: string; title: string; desc: string };
export const META: Record<'nb' | 'os' | 'geo' | 'net' | 'proc' | 'cert', Meta> = {
  nb: { icon: <Hexagon size={18} />, iconClass: 'bg-linear-to-tr/srgb from-netbird-200 to-netbird-100 text-netbird-950', title: 'NetBird Client Version', desc: 'Restrict access to peers with a specific NetBird client version.' },
  os: { icon: <Disc3 size={16} />, iconClass: 'bg-linear-to-tr/srgb from-nb-gray-500 to-nb-gray-300 text-nb-gray-900', title: 'Operating System', desc: 'Restrict access in your network based on the operating system.' },
  geo: { icon: <Flag size={16} />, iconClass: 'bg-linear-to-tr/srgb from-indigo-500 to-indigo-400 text-white', title: 'Country & Region', desc: 'Restrict access in your network based on country or region.' },
  net: { icon: <Network size={16} />, iconClass: 'bg-linear-to-tr/srgb from-blue-500 to-blue-400 text-white', title: 'Peer Network Range', desc: 'Restrict access by allowing or blocking peer network ranges.' },
  proc: { icon: <ServerCog size={18} />, iconClass: 'bg-linear-to-tr/srgb from-nb-gray-500 to-nb-gray-300 text-nb-gray-900', title: 'Process', desc: 'Restrict access in your network based on running processes of a peer.' },
  cert: { icon: <FileKey2 size={16} />, iconClass: 'bg-linear-to-tr/srgb from-emerald-500 to-emerald-400 text-white', title: 'Certificate', desc: 'Restrict access to peers holding a certificate issued by your own certificate authority.' },
};

// Shown wherever a Certificate check is configured or displayed (official wording).
export const CERT_MOBILE_NOTE = 'This check is not supported on mobile devices. Peers running the NetBird iOS or Android app will always fail this check and be denied access.';
export const CERT_VERSION_NOTE = 'Requires NetBird management and clients v0.81 or newer.';

// One line per CA certificate: subject + SHA-256 fingerprint, or why it can't be used.
export function CertInfoLine({ info }: { info?: CaCertInfo }) {
  if (!info) return null;
  if (!info.ok) return <span className="text-xs text-red-500">{info.error}</span>;
  return (
    <span className="flex flex-col gap-0.5 text-xs text-nb-gray-500 dark:text-nb-gray-400 min-w-0">
      <span className="truncate" title={info.subject}>{info.subject}</span>
      <span className="font-mono break-all text-nb-gray-400">SHA-256 {info.fingerprint256}</span>
      {info.expired && <span className="text-red-500">Expired on {new Date(info.validTo || '').toLocaleDateString()}</span>}
      {!info.isCA && <span className="text-amber-600 dark:text-amber-400">Not marked as a CA certificate - peers' certificates won't chain to it unless it is the issuing CA.</span>}
    </span>
  );
}

let _uid = 0;
const uid = () => `r${++_uid}`;

// The check types this editor models. Any other key on a loaded check (a type NetBird added
// later, e.g. certificate_check) is kept as-is on save and shown with a generic badge.
const KNOWN_CHECK_KEYS = ['nb_version_check', 'os_version_check', 'geo_location_check', 'peer_network_range_check', 'process_check', 'certificate_check'];
const unknownChecks = (c: Checks): Record<string, unknown> =>
  Object.fromEntries(Object.entries(c || {}).filter(([k, v]) => !KNOWN_CHECK_KEYS.includes(k) && v));

export const activeMetas = (c: Checks): Meta[] => {
  const out: Meta[] = [];
  if (c.nb_version_check) out.push(META.nb);
  if (c.os_version_check) out.push(META.os);
  if (c.geo_location_check) out.push(META.geo);
  if (c.peer_network_range_check) out.push(META.net);
  if (c.process_check) out.push(META.proc);
  if (c.certificate_check) out.push(META.cert);
  for (const k of Object.keys(unknownChecks(c))) out.push({ icon: <ShieldCheck size={16} />, iconClass: META.os.iconClass, title: k.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()), desc: '' });
  return out;
};

// ─── List ───
export function PostureChecks() {
  const { data, isLoading } = usePostureChecks();
  const del = useDeletePostureCheck();
  const confirm = useConfirm();
  const [modal, setModal] = useState<{ check: PostureCheck | null } | null>(null);
  const checks = data || [];

  // Sort the two data columns. Rows are keyed by id and edited/deleted by object, so reordering is safe.
  const { sorted, state } = useTableSort(checks, {
    name: (c) => c.name || '',
    checks: (c) => activeMetas(c.checks).map((m) => m.title).join(', '),
  });

  const onDelete = async (c: PostureCheck) => {
    const ok = await confirm({
      title: 'Delete posture check',
      message: `Delete “${c.name}”? It will be removed from any Access Profile that uses it.`,
      confirmText: 'Delete',
    });
    if (ok) await del.mutateAsync(c.id);
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
        <div>
          <p className="text-nb-gray-500 text-sm max-w-2xl">Use posture checks to further restrict access in your network. Attach them to a <b>Shared</b> Access Profile to enforce them on its global policy.</p>
        </div>
        <Button variant="primary" onClick={() => setModal({ check: null })} className="self-start sm:shrink-0"><Plus size={15} /> Add Posture Check</Button>
      </div>

      {isLoading ? <LoadingState /> : !checks.length ? (
        <EmptyState title="No Posture Checks" hint="Create one, then attach it to a shared Access Profile." icon={<ShieldCheck size={22} />} />
      ) : (
        <Table>
          <THead>
            <SortTh label="Name" sortKey="name" state={state} />
            <SortTh label="Checks" sortKey="checks" state={state} />
            <Th className="text-right">{''}</Th>
          </THead>
          <TBody>
            {sorted.map((c) => (
              <Tr key={c.id} onClick={() => setModal({ check: c })}>
                <Td>
                  <div className="text-sm text-nb-gray-800 dark:text-nb-gray-200">{c.name}</div>
                  {c.description && <div className="text-[0.78rem] text-nb-gray-500">{c.description}</div>}
                </Td>
                <Td>
                  <div className="flex items-center gap-1.5">
                    {activeMetas(c.checks).map((m, i) => (
                      <span key={i} title={m.title} className={cn('h-7 w-7 rounded-md flex items-center justify-center shadow-xs', m.iconClass)}>{m.icon}</span>
                    ))}
                    {!activeMetas(c.checks).length && <span className="text-nb-gray-500 text-xs">-</span>}
                  </div>
                </Td>
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex items-center gap-1.5">
                    <IconButton onClick={() => setModal({ check: c })} title="Edit"><Pencil size={15} /></IconButton>
                    <IconButton onClick={() => onDelete(c)} title="Delete" className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><Trash2 size={15} /></IconButton>
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      {modal && <PostureCheckModal check={modal.check} onClose={() => setModal(null)} />}
    </div>
  );
}

// ─── Card row (opens a nested editor modal) ───
function CardRow({ meta, active, onOpen, onReset }: { meta: Meta; active: boolean; onOpen: () => void; onReset: () => void }) {
  const confirm = useConfirm();
  const togglePill = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!active) { onOpen(); return; }
    const ok = await confirm({ title: 'Disable this check?', message: 'Are you sure? All settings of this check will be lost.', confirmText: 'Disable' });
    if (ok) onReset();
  };
  return (
    <div onClick={onOpen} className="cursor-pointer rounded-md border border-transparent transition-all hover:bg-nb-gray-100/70 dark:hover:bg-nb-gray-920/80 hover:border-nb-gray-200 dark:hover:border-nb-gray-900">
      <div className="flex gap-4 items-center w-full px-4 py-3">
        <div className={cn('h-9 w-9 shrink-0 shadow-xl rounded-md flex items-center justify-center select-none', meta.iconClass)}>{meta.icon}</div>
        <div className="w-full min-w-0">
          <div className="text-sm font-medium text-nb-gray-800 dark:text-nb-gray-100">{meta.title}</div>
          <div className="text-xs mt-0.5 text-nb-gray-500 dark:text-nb-gray-300">{meta.desc}</div>
        </div>
        <span onClick={togglePill}
          className={cn('shrink-0 text-[10px] rounded-full px-1 py-1 flex items-center gap-1 w-[50px] justify-center uppercase font-medium transition-all',
            active ? 'text-green-500 bg-green-500/15 hover:bg-green-500/25' : 'text-nb-gray-400 bg-nb-gray-100 dark:bg-nb-gray-900')}>
          <CircleDot size={8} /> {active ? 'On' : 'Off'}
        </span>
      </div>
    </div>
  );
}

// Header + footer wrapper for a nested check-editor modal (gradient icon, like NetBird).
function EditorModal({ meta, size = 'md', onClose, onSave, saveDisabled, children }: {
  meta: Meta; size?: 'md' | 'lg'; onClose: () => void; onSave: () => void; saveDisabled?: boolean; children: ReactNode;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      icon={meta.icon}
      iconWrapClass={cn(meta.iconClass, 'shadow-xl')}
      title={meta.title}
      subtitle={meta.desc}
      size={size}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={onSave} disabled={saveDisabled}>Save</Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

// shrink-0 + nowrap: the toggle must never be crushed by the label next to it (a squeezed
// flex child used to clip "Block" behind a tiny horizontal scrollbar).
function AllowBlock({ value, onChange }: { value: 'allow' | 'deny'; onChange: (v: 'allow' | 'deny') => void }) {
  return (
    <div className="inline-flex shrink-0 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-0.5 gap-0.5">
      <button onClick={() => onChange('allow')} className={cn('flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-sm text-sm font-medium transition-colors',
        value === 'allow' ? 'bg-green-500/15 text-green-500' : 'text-nb-gray-500 hover:text-nb-gray-700 dark:hover:text-nb-gray-300')}>
        <ShieldCheck size={15} /> Allow
      </button>
      <button onClick={() => onChange('deny')} className={cn('flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-sm text-sm font-medium transition-colors',
        value === 'deny' ? 'bg-red-500/15 text-red-500' : 'text-nb-gray-500 hover:text-nb-gray-700 dark:hover:text-nb-gray-300')}>
        <ShieldX size={15} /> Block
      </button>
    </div>
  );
}

function DottedAdd({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center justify-center gap-2 rounded-md border border-dashed border-nb-gray-300 dark:border-nb-gray-700 text-nb-gray-600 dark:text-nb-gray-300 hover:border-netbird hover:text-netbird py-2.5 text-sm font-medium transition-colors">
      <Plus size={14} /> {children}
    </button>
  );
}

// ─── The 5 check cards (each card + its editor modal) ───
function NbCard({ value, onChange }: { value?: { min_version: string }; onChange: (v?: { min_version: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(value?.min_version || '');
  return (
    <>
      <CardRow meta={META.nb} active={value !== undefined} onOpen={() => { setV(value?.min_version || ''); setOpen(true); }} onReset={() => onChange(undefined)} />
      {open && (
        <EditorModal meta={META.nb} onClose={() => setOpen(false)} onSave={() => { onChange(v.trim() ? { min_version: v.trim() } : undefined); setOpen(false); }}>
          <Field label="Minimum Version" hint="Peers running an older NetBird client are denied access.">
            <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="e.g. 0.30.0" autoFocus />
          </Field>
        </EditorModal>
      )}
    </>
  );
}

function OsCard({ value, onChange }: { value?: OsVersionCheck; onChange: (v?: OsVersionCheck) => void }) {
  const [open, setOpen] = useState(false);
  const [linux, setLinux] = useState(value?.linux?.min_kernel_version || '');
  const [windows, setWindows] = useState(value?.windows?.min_kernel_version || '');
  const [darwin, setDarwin] = useState(value?.darwin?.min_version || '');
  const [ios, setIos] = useState(value?.ios?.min_version || '');
  const [android, setAndroid] = useState(value?.android?.min_version || '');
  const reset = () => {
    setLinux(value?.linux?.min_kernel_version || ''); setWindows(value?.windows?.min_kernel_version || '');
    setDarwin(value?.darwin?.min_version || ''); setIos(value?.ios?.min_version || ''); setAndroid(value?.android?.min_version || '');
  };
  const save = () => {
    const os: OsVersionCheck = {};
    if (linux.trim()) os.linux = { min_kernel_version: linux.trim() };
    if (windows) os.windows = { min_kernel_version: windows };
    if (darwin) os.darwin = { min_version: darwin };
    if (ios) os.ios = { min_version: ios };
    if (android) os.android = { min_version: android };
    onChange(Object.keys(os).length ? os : undefined);
    setOpen(false);
  };
  return (
    <>
      <CardRow meta={META.os} active={value !== undefined} onOpen={() => { reset(); setOpen(true); }} onReset={() => onChange(undefined)} />
      {open && (
        <EditorModal meta={META.os} onClose={() => setOpen(false)} onSave={save}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <Field label="Linux (Min Kernel)"><Input value={linux} onChange={(e) => setLinux(e.target.value)} placeholder="e.g. 5.3.0" /></Field>
            <Field label="Windows"><SelectMenu value={windows} onChange={(v) => setWindows(v)} options={[{ value: '', label: 'Any' }, ...WINDOWS_VERSIONS]} /></Field>
            <Field label="macOS"><SelectMenu value={darwin} onChange={(v) => setDarwin(v)} options={[{ value: '', label: 'Any' }, ...MACOS_VERSIONS]} /></Field>
            <Field label="iOS"><SelectMenu value={ios} onChange={(v) => setIos(v)} options={[{ value: '', label: 'Any' }, ...IOS_VERSIONS]} /></Field>
            <Field label="Android"><SelectMenu value={android} onChange={(v) => setAndroid(v)} options={[{ value: '', label: 'Any' }, ...ANDROID_VERSIONS]} /></Field>
          </div>
          <FieldHint>Leave a platform on “Any” to skip it.</FieldHint>
        </EditorModal>
      )}
    </>
  );
}

type Loc = { id: string; country_code: string; city_name: string };
function GeoCard({ value, onChange }: { value?: GeoLocationCheck; onChange: (v?: GeoLocationCheck) => void }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<'allow' | 'deny'>(value?.action || 'allow');
  const [locs, setLocs] = useState<Loc[]>((value?.locations || []).map((l) => ({ id: uid(), country_code: l.country_code, city_name: l.city_name || '' })));
  const reopen = () => { setAction(value?.action || 'allow'); setLocs((value?.locations || []).map((l) => ({ id: uid(), country_code: l.country_code, city_name: l.city_name || '' }))); setOpen(true); };
  const save = () => {
    const clean = locs.filter((l) => l.country_code);
    onChange(clean.length ? { action, locations: clean.map((l) => (l.city_name ? { country_code: l.country_code, city_name: l.city_name } : { country_code: l.country_code })) } : undefined);
    setOpen(false);
  };
  return (
    <>
      <CardRow meta={META.geo} active={value !== undefined} onOpen={reopen} onReset={() => onChange(undefined)} />
      {open && (
        <EditorModal meta={META.geo} size="lg" onClose={() => setOpen(false)} onSave={save}>
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0 flex-1"><Label>Allow or Block Location</Label><FieldHint>Choose whether to allow or block access from specific countries.</FieldHint></div>
              <AllowBlock value={action} onChange={setAction} />
            </div>
            {locs.map((loc) => (
              <LocationRow key={loc.id} loc={loc}
                onChange={(v) => setLocs((p) => p.map((x) => (x.id === loc.id ? v : x)))}
                onRemove={() => setLocs((p) => p.filter((x) => x.id !== loc.id))} />
            ))}
            <DottedAdd onClick={() => setLocs((p) => [...p, { id: uid(), country_code: '', city_name: '' }])}>Add Location</DottedAdd>
          </div>
        </EditorModal>
      )}
    </>
  );
}

function LocationRow({ loc, onChange, onRemove }: { loc: Loc; onChange: (v: Loc) => void; onRemove: () => void }) {
  const { data: countries } = useCountries();
  const { data: cities, isFetching } = useCities(loc.country_code || undefined);
  return (
    <div className="flex gap-2">
      <SelectMenu value={loc.country_code} onChange={(v) => onChange({ ...loc, country_code: v, city_name: '' })} className="flex-1" placeholder="Select country…"
        options={(countries || []).map((c) => ({ value: c.country_code, label: `${c.country_name} (${c.country_code})` }))} />
      <SelectMenu value={loc.city_name} onChange={(v) => onChange({ ...loc, city_name: v })} disabled={!loc.country_code} className="flex-1"
        options={[{ value: '', label: isFetching ? 'Loading…' : 'All Locations' }, ...(cities || []).map((ct) => ({ value: ct.city_name, label: ct.city_name }))]} />
      <Button variant="secondary" size="sm" className="h-[42px]! px-3!" onClick={onRemove}><MinusCircle size={15} /></Button>
    </div>
  );
}

function NetCard({ value, onChange }: { value?: PeerNetworkRangeCheck; onChange: (v?: PeerNetworkRangeCheck) => void }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<'allow' | 'deny'>(value?.action || 'allow');
  const [ranges, setRanges] = useState<{ id: string; value: string }[]>((value?.ranges || []).map((r) => ({ id: uid(), value: r })));
  const reopen = () => { setAction(value?.action || 'allow'); setRanges((value?.ranges || []).map((r) => ({ id: uid(), value: r }))); setOpen(true); };
  const save = () => {
    const r = ranges.map((x) => x.value.trim()).filter(Boolean);
    onChange(r.length ? { action, ranges: r } : undefined);
    setOpen(false);
  };
  return (
    <>
      <CardRow meta={META.net} active={value !== undefined} onOpen={reopen} onReset={() => onChange(undefined)} />
      {open && (
        <EditorModal meta={META.net} size="lg" onClose={() => setOpen(false)} onSave={save}>
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0 flex-1"><Label>Allow or Block Range</Label><FieldHint>Allow or block peers based on their local network ranges.</FieldHint></div>
              <AllowBlock value={action} onChange={setAction} />
            </div>
            {ranges.map((r) => (
              <div key={r.id} className="flex gap-2">
                <Input value={r.value} onChange={(e) => setRanges((p) => p.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))} placeholder="e.g. 192.168.1.0/24" />
                <Button variant="secondary" size="sm" className="h-[42px]! px-3!" onClick={() => setRanges((p) => p.filter((x) => x.id !== r.id))}><MinusCircle size={15} /></Button>
              </div>
            ))}
            <DottedAdd onClick={() => setRanges((p) => [...p, { id: uid(), value: '' }])}>Add Network Range</DottedAdd>
          </div>
        </EditorModal>
      )}
    </>
  );
}

type Proc = { id: string; linux_path: string; mac_path: string; windows_path: string };
function ProcCard({ value, onChange }: { value?: ProcessCheck; onChange: (v?: ProcessCheck) => void }) {
  const [open, setOpen] = useState(false);
  const init = (): Proc[] => (value?.processes || []).map((p) => ({ id: uid(), linux_path: p.linux_path || '', mac_path: p.mac_path || '', windows_path: p.windows_path || '' }));
  const [procs, setProcs] = useState<Proc[]>(init);
  const reopen = () => { setProcs(init().length ? init() : [{ id: uid(), linux_path: '', mac_path: '', windows_path: '' }]); setOpen(true); };
  const save = () => {
    const ps = procs
      .map((p) => ({ linux_path: p.linux_path.trim() || undefined, mac_path: p.mac_path.trim() || undefined, windows_path: p.windows_path.trim() || undefined }))
      .filter((p) => p.linux_path || p.mac_path || p.windows_path);
    onChange(ps.length ? { processes: ps } : undefined);
    setOpen(false);
  };
  return (
    <>
      <CardRow meta={META.proc} active={value !== undefined} onOpen={reopen} onReset={() => onChange(undefined)} />
      {open && (
        <EditorModal meta={META.proc} size="lg" onClose={() => setOpen(false)} onSave={save}>
          <div className="flex flex-col gap-3">
            {procs.map((p) => (
              <div key={p.id} className="rounded-md border border-nb-gray-200 dark:border-nb-gray-800 p-2.5 flex flex-col gap-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Input value={p.linux_path} onChange={(e) => setProcs((a) => a.map((x) => (x.id === p.id ? { ...x, linux_path: e.target.value } : x)))} placeholder="Linux path" />
                  <Input value={p.mac_path} onChange={(e) => setProcs((a) => a.map((x) => (x.id === p.id ? { ...x, mac_path: e.target.value } : x)))} placeholder="macOS path" />
                  <Input value={p.windows_path} onChange={(e) => setProcs((a) => a.map((x) => (x.id === p.id ? { ...x, windows_path: e.target.value } : x)))} placeholder="Windows path" />
                </div>
                <button onClick={() => setProcs((a) => a.filter((x) => x.id !== p.id))} className="self-end inline-flex items-center gap-1.5 text-[0.78rem] text-red-500 hover:text-red-400"><MinusCircle size={13} /> Remove</button>
              </div>
            ))}
            <DottedAdd onClick={() => setProcs((p) => [...p, { id: uid(), linux_path: '', mac_path: '', windows_path: '' }])}>Add Process</DottedAdd>
          </div>
        </EditorModal>
      )}
    </>
  );
}

type CertDraft = { id: string; pem: string };
function CertCard({ value, onChange }: { value?: { ca_certificates: string[] }; onChange: (v?: { ca_certificates: string[] }) => void }) {
  const [open, setOpen] = useState(false);
  const init = (): CertDraft[] => (value?.ca_certificates?.length ? value.ca_certificates : ['']).map((pem) => ({ id: uid(), pem }));
  const [certs, setCerts] = useState<CertDraft[]>(init);
  // Debounce a string: a fresh array every render would restart (and re-fire) the timer forever.
  const pemsKey = useDebounced(JSON.stringify(certs.map((x) => x.pem)), 300);
  const pems = useMemo(() => JSON.parse(pemsKey) as string[], [pemsKey]);
  const insp = useCaCertInspection(pems);
  // Results line up with the debounced list; only trust them while it matches what is on screen.
  const current = pems.length === certs.length && pems.every((p, i) => p === certs[i].pem);
  const infos = current ? insp.data : undefined;
  const ready = current && !insp.isFetching && !!infos && certs.every((x, i) => x.pem.trim() && infos[i]?.ok);
  const save = () => {
    const list = certs.map((x) => x.pem.replace(/\r\n?/g, '\n').trim()).filter(Boolean);
    onChange(list.length ? { ca_certificates: list } : undefined);
    setOpen(false);
  };
  return (
    <>
      <CardRow meta={META.cert} active={value !== undefined} onOpen={() => { setCerts(init()); setOpen(true); }} onReset={() => onChange(undefined)} />
      {open && (
        <EditorModal meta={META.cert} size="lg" onClose={() => setOpen(false)} onSave={save} saveDisabled={!ready}>
          <div className="flex flex-col gap-3">
            <div>
              <Label>CA Certificates</Label>
              <FieldHint>Paste the PEM encoded public certificate of the root or intermediate CA that issues your device certificates. Peers will only be allowed to connect if they hold a certificate issued by one of these CAs and prove possession of its private key. {CERT_VERSION_NOTE}</FieldHint>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[0.78rem] text-amber-700 dark:text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{CERT_MOBILE_NOTE}</span>
            </div>
            {certs.map((x, i) => (
              <div key={x.id} className="flex gap-2 items-start min-w-0">
                <div className="w-full flex flex-col gap-1.5 min-w-0">
                  <textarea value={x.pem} rows={x.pem.trim() ? Math.min(10, Math.max(4, x.pem.split('\n').length)) : 4}
                    onChange={(e) => setCerts((p) => p.map((y) => (y.id === x.id ? { ...y, pem: e.target.value } : y)))}
                    placeholder={'-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----'}
                    spellCheck={false}
                    className="w-full rounded-md border px-3 py-2 font-mono text-xs leading-5 outline-hidden resize-y bg-white border-nb-gray-200 text-nb-gray-900 placeholder:text-nb-gray-500 dark:bg-nb-gray-900 dark:border-nb-gray-700 dark:text-nb-gray-100 focus:ring-2 focus:ring-netbird-400/30 focus:border-netbird/60" />
                  {x.pem.trim() && <CertInfoLine info={infos?.[i]} />}
                </div>
                <Button variant="secondary" size="sm" className="h-[42px]! px-3!" onClick={() => setCerts((p) => p.filter((y) => y.id !== x.id))} title="Remove certificate"><MinusCircle size={15} /></Button>
              </div>
            ))}
            {insp.isError && <p className="text-xs text-red-500">Couldn't check the certificates - {(insp.error as Error).message}</p>}
            <DottedAdd onClick={() => setCerts((p) => [...p, { id: uid(), pem: '' }])}>Add CA Certificate</DottedAdd>
          </div>
        </EditorModal>
      )}
    </>
  );
}

// ─── Main modal (tabs: Checks / Name & Description) ───
function PostureCheckModal({ check, onClose }: { check: PostureCheck | null; onClose: () => void }) {
  const save = useSavePostureCheck();
  const c = check?.checks || {};
  const [tab, setTab] = useState<'checks' | 'general'>('checks');
  const [name, setName] = useState(check?.name || '');
  const [description, setDescription] = useState(check?.description || '');
  const [nb, setNb] = useState(c.nb_version_check);
  const [os, setOs] = useState(c.os_version_check);
  const [geo, setGeo] = useState(c.geo_location_check);
  const [net, setNet] = useState(c.peer_network_range_check);
  const [proc, setProc] = useState(c.process_check);
  const [cert, setCert] = useState(c.certificate_check);
  const [error, setError] = useState('');

  // Check types this editor doesn't model ride along unchanged, so saving never drops them.
  const extra = unknownChecks(c);
  const anyEnabled = !!(nb || os || geo || net || proc || cert) || Object.keys(extra).length > 0;
  const canSave = !!name.trim() && anyEnabled;

  const submit = async () => {
    const checks: Checks = { ...extra };
    if (nb) checks.nb_version_check = nb;
    if (os) checks.os_version_check = os;
    if (geo) checks.geo_location_check = geo;
    if (net) checks.peer_network_range_check = net;
    if (proc) checks.process_check = proc;
    if (cert) checks.certificate_check = cert;
    setError('');
    const payload: PostureCheckInput = { name: name.trim(), description: description.trim(), checks };
    try { await save.mutateAsync({ id: check?.id, payload }); onClose(); }
    catch (e) { setError('Failed: ' + (e as Error).message); }
  };

  const footer = (
    <>
      {tab === 'checks'
        ? <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        : <Button variant="secondary" size="sm" onClick={() => setTab('checks')}>Back</Button>}
      {!check && tab === 'checks' && (
        <Button variant="primary" size="sm" onClick={() => setTab('general')} disabled={!anyEnabled}>Continue</Button>
      )}
      {(check || tab === 'general') && (
        <Button variant="primary" size="sm" onClick={submit} disabled={!canSave || save.isPending}>
          {save.isPending ? '…' : check ? 'Save Changes' : 'Create Posture Check'}
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      icon={<ShieldCheck size={18} />}
      title={check ? 'Update Posture Check' : 'Create Posture Check'}
      subtitle="Use posture checks to further restrict access in your network."
      size="lg"
      tabs={
        <Tabs
          bordered={false}
          value={tab}
          onChange={(k) => { if (k === 'checks' || anyEnabled) setTab(k as 'checks' | 'general'); }}
          items={[
            { key: 'checks', label: <span className="inline-flex items-center gap-2"><LayoutList size={15} /> Checks</span> },
            { key: 'general', label: <span className="inline-flex items-center gap-2"><Text size={15} /> Name &amp; Description</span> },
          ]}
        />
      }
      footer={footer}
    >
      {tab === 'checks' ? (
        <div className="flex flex-col gap-1">
          <NbCard value={nb} onChange={setNb} />
          <GeoCard value={geo} onChange={setGeo} />
          <NetCard value={net} onChange={setNet} />
          <OsCard value={os} onChange={setOs} />
          <ProcCard value={proc} onChange={setProc} />
          <CertCard value={cert} onChange={setCert} />
          {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <Field label="Name Of The Posture Check" hint="Set an easily identifiable name for your posture check.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. NetBird Version > 0.30.0" autoFocus maxLength={60} />
          </Field>
          <Field label="Description (Optional)" hint="Add more context to this posture check.">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="e.g. Check that the NetBird version is at least 0.30.0"
              className="rounded-md border px-3 py-2 text-sm outline-hidden transition-colors resize-none bg-white border-nb-gray-200 text-nb-gray-900 placeholder:text-nb-gray-500 dark:bg-nb-gray-900 dark:border-nb-gray-700 dark:text-nb-gray-100 focus:ring-2 focus:ring-netbird-400/30 focus:border-netbird/60"
            />
          </Field>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
