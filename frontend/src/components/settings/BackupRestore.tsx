import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Download, Upload, ShieldCheck, KeyRound, HardDrive, Play, RefreshCw,
  Lock, RotateCcw, AlertTriangle, DatabaseBackup, Archive,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { formatTimestamp } from '@/lib/logfmt';
import { useConfirm } from '@/contexts/ConfirmContext';
import {
  Button, Input, Select, Field, FieldHint, Modal, IconButton, EmptyState,
  Table, THead, Th, TBody, Tr, Td,
} from '@/components/ui';
import { useInternalBackup } from '@/lib/queries';
import {
  useSetBackupPassphrase, useSaveInternalBackupConfig, useRunInternalBackup,
  useRestoreInternalBackup, useUploadInternalBackup,
} from '@/lib/mutations';

const CARD = 'rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4';

// A category header mirroring the settings tabs (see TenantDefaults): the section icon in a soft
// tile, its title, and a one-line muted description.
function CardHeader({ icon, title, description }: { icon: ReactNode; title: string; description: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-nb-gray-100 text-nb-gray-600 dark:bg-nb-gray-800/60 dark:text-nb-gray-300">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">{title}</div>
        <p className="text-[0.8rem] text-nb-gray-500 mt-0.5">{description}</p>
      </div>
    </div>
  );
}

// A non-toggle section header: medium-weight title + muted help line (the SettingRow anatomy from
// TenantDefaults, without the trailing control).
function SectionHead({ title, help }: { title: ReactNode; help?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">{title}</div>
      {help && <p className="text-[0.72rem] text-nb-gray-500 mt-0.5">{help}</p>}
    </div>
  );
}

// The app's toggle switch (matches TenantDefaults' Toggle / the dashboard's FancyToggleSwitch).
function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 rounded-full transition-colors shrink-0',
        checked ? 'bg-netbird' : 'bg-nb-gray-300 dark:bg-nb-gray-700',
        disabled && 'opacity-50 cursor-not-allowed')}
    >
      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

// The "attached" sub-panel: a bordered box that reads as a continuation of the row above it.
// Dims/locks when its parent toggle is off (matches TenantDefaults' SubPanel).
function SubPanel({ disabled, children, className }: { disabled?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50/70 dark:bg-nb-gray-900/40 px-4 py-4',
      disabled && 'opacity-50 pointer-events-none', className)}>
      {children}
    </div>
  );
}

// A status dot with three tones - green (ready), amber (needs attention), gray (off/unset).
function Dot({ tone }: { tone: 'green' | 'amber' | 'gray' }) {
  return (
    <span className={cn('h-2 w-2 rounded-full shrink-0',
      tone === 'green' ? 'bg-green-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
  );
}

// A compact readiness chip for the status strip: an icon, a label with a status dot, and a muted
// value line beneath it.
function StatusChip({ icon, label, tone, value }: { icon: ReactNode; label: string; tone: 'green' | 'amber' | 'gray'; value: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50/60 dark:bg-nb-gray-900/40 px-3 py-2.5">
      <span className="mt-0.5 text-nb-gray-400 dark:text-nb-gray-500 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium text-nb-gray-800 dark:text-nb-gray-200">
          <Dot tone={tone} /> {label}
        </div>
        <p className="text-xs text-nb-gray-500 mt-0.5 break-all">{value}</p>
      </div>
    </div>
  );
}

// A green success box / red error line, matching the established feedback style.
function Feedback({ msg, err }: { msg?: string; err?: string }) {
  if (!msg && !err) return null;
  if (err) return <p className="text-sm text-red-500">{err}</p>;
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2.5 text-[0.82rem] text-nb-gray-700 dark:text-nb-gray-200">
      <DatabaseBackup size={16} className="text-green-500 shrink-0 mt-0.5" />
      <span>{msg}</span>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Tier 1: plaintext settings export - SECRET-FREE, safe to share ───
// The export/import endpoints strip every secret by design; this file can be stored or handed to
// support without leaking credentials.
function PlaintextExportCard() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const onExport = async () => {
    setErr(''); setMsg('');
    try {
      const data = await api.get<{ settings: Record<string, string>; tables?: Record<string, unknown[]> }>('/api/settings-export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `netbird-companion-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      const tableRows = Object.values(data.tables || {}).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
      setMsg(`Exported ${Object.keys(data.settings || {}).length} settings plus ${tableRows} configuration rows.`);
    } catch (e) { setErr('Export failed: ' + (e as Error).message); }
  };

  const onImportFile = async (file: File) => {
    setErr(''); setMsg('');
    try {
      const parsed = JSON.parse(await file.text());
      const count = parsed && parsed.settings ? Object.keys(parsed.settings).length : 0;
      const hasTables = parsed && parsed.tables && typeof parsed.tables === 'object';
      const ok = await confirm({
        title: 'Restore Settings Backup',
        message: `Overwrite the current configuration with ${count} settings from "${file.name}"?`
          + (hasTables ? ' The configuration tables in the file (Event Filtering, Blocklist, Automations, Recurring Access, Access Profiles, Network Grants, Templates, Cleanup Ignores) are REPLACED - existing rows in these sections are deleted and replaced by the file\'s, across all tenants.' : '')
          + ' Secrets (API tokens, passwords, automation source credentials) are not part of backups and stay untouched.',
        confirmText: 'Restore',
      });
      if (!ok) return;
      const result = await api.post<{ imported: number; tables?: Record<string, number>; skipped?: Record<string, number> }>('/api/settings-import', parsed);
      qc.invalidateQueries();
      const tableRows = Object.values(result.tables || {}).reduce((n, v) => n + (v || 0), 0);
      const skipped = Object.values(result.skipped || {}).reduce((n, v) => n + (v || 0), 0);
      setMsg(`Restored ${result.imported} settings`
        + (result.tables && Object.keys(result.tables).length ? ` plus ${tableRows} configuration rows` : '')
        + (skipped ? ` (${skipped} malformed rows skipped)` : '')
        + ' - applied immediately.');
    } catch (e) { setErr('Import failed: ' + (e as Error).message); }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="max-w-2xl">
      <h3 className="text-base font-semibold text-nb-gray-900 dark:text-nb-gray-100 mb-1">Settings Export (Secret-Free)</h3>
      <p className="text-nb-gray-500 text-sm mb-3">
        Download the whole app configuration (all Settings tabs) as a JSON file, or restore one.
        Secrets - the NetBird API token, webhook token, Telegram bot token, SMTP password and
        automation source credentials - are <b>never included</b> in a backup and never overwritten
        by a restore. This tier is <b>safe to share</b>. Both actions are audited.
      </p>
      <p className="text-nb-gray-500 text-sm mb-5">
        The backup also includes app configuration stored in tables, across all tenants: Event
        Filtering rules, Blocklist, Automations (without source credentials), Recurring Access,
        Access Profiles and per-network defaults, Network Grants, Templates and Cleanup Ignores.
        Restoring <b>replaces</b> those sections with the file's rows. History and runtime state
        (events, audit log, access grants, automation run history) are never exported.
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={onExport}><Download size={15} /> Export Settings</Button>
        <Button variant="secondary" onClick={() => fileRef.current?.click()}><Upload size={15} /> Restore From File</Button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportFile(f); }} />
      </div>
      {msg && <p className="mt-3 text-sm text-green-600 dark:text-green-500">{msg}</p>}
      {err && <p className="mt-3 text-sm text-red-500">{err}</p>}
    </div>
  );
}

// A restore always prompts the human for the passphrase - the server never holds material that
// decrypts a backup. This modal carries the strong confirm text (a full restore replaces EVERYTHING).
function RestoreModal({ open, fileName, busy, error, onClose, onSubmit }: {
  open: boolean; fileName: string; busy: boolean; error: string;
  onClose: () => void; onSubmit: (passphrase: string) => void;
}) {
  const [pass, setPass] = useState('');
  useEffect(() => { if (open) setPass(''); }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Restore Encrypted Backup"
      subtitle={fileName}
      icon={<ShieldCheck size={18} />}
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={() => onSubmit(pass)} disabled={busy || pass.length < 1}>
            {busy ? 'Restoring...' : 'Restore Everything'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[0.8rem] leading-relaxed text-amber-700 dark:text-amber-400">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            This replaces <b>ALL settings</b> - including every API token, webhook token, Telegram bot
            token, SMTP password and automation source credential - and <b>ALL configuration sections
            across all tenants</b>. The app reloads immediately with the restored configuration. This
            cannot be undone.
          </span>
        </div>
        <Field label="Backup Passphrase"
          hint="Only this passphrase can open the file - the server itself cannot decrypt it.">
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)}
            placeholder="Enter the passphrase this backup was encrypted with"
            onKeyDown={(e) => { if (e.key === 'Enter' && pass) onSubmit(pass); }} />
        </Field>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

// ─── Tier 2: internal envelope-encrypted backup - COMPLETE incl. secrets, only the passphrase opens ───
function InternalBackupCard() {
  const { data: status } = useInternalBackup();
  const setPass = useSetBackupPassphrase();
  const saveCfg = useSaveInternalBackupConfig();
  const runBackup = useRunInternalBackup();
  const restore = useRestoreInternalBackup();
  const upload = useUploadInternalBackup();

  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  // Passphrase fields (never displayed back).
  const [curPass, setCurPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [pMsg, setPMsg] = useState('');
  const [pErr, setPErr] = useState('');
  // When configured, the passphrase fields live in a modal (Change) or their own confirmation
  // modal (Reset) rather than always-visible on the card.
  const [passModal, setPassModal] = useState<'change' | 'reset' | null>(null);
  // Schedule - seeded from the loaded config.
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(3);
  const [keep, setKeep] = useState(14);
  // Restore modal target: a folder file name, or an uploaded buffer.
  const [restoreTarget, setRestoreTarget] = useState<{ name: string } | { bytes: ArrayBuffer; fileName: string } | null>(null);
  const [restoreErr, setRestoreErr] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status?.config) { setEnabled(status.config.enabled); setHour(status.config.hour); setKeep(status.config.keep); }
  }, [status?.config]);

  const keyConfigured = !!status?.keyConfigured;
  const dirOk = !!status?.dirOk;

  // Returns true on success so the calling modal can close itself (the Reset modal's own danger
  // button is the confirmation - no separate confirm() dialog).
  const savePassphrase = async (reset: boolean): Promise<boolean> => {
    setPErr(''); setPMsg('');
    if (newPass.length < 12) { setPErr('Passphrase must be at least 12 characters.'); return false; }
    if (newPass !== confirmPass) { setPErr('Passphrases do not match.'); return false; }
    if (keyConfigured && !reset && !curPass) { setPErr('Enter your current passphrase.'); return false; }
    try {
      const r = await setPass.mutateAsync({
        passphrase: newPass,
        currentPassphrase: keyConfigured && !reset ? curPass : undefined,
        reset,
      });
      setPMsg(r.mode === 'set' ? 'Encryption passphrase set.'
        : r.mode === 'changed' ? 'Passphrase changed.'
          : 'Encryption key reset - existing backups now require the old passphrase.');
      setCurPass(''); setNewPass(''); setConfirmPass('');
      return true;
    } catch (e) { setPErr((e as Error).message); return false; }
  };

  // Open a passphrase modal with a clean slate (no stale fields or errors carried in).
  const openPassModal = (m: 'change' | 'reset') => {
    setCurPass(''); setNewPass(''); setConfirmPass(''); setPErr(''); setPMsg('');
    setPassModal(m);
  };
  const closePassModal = () => { if (!setPass.isPending) { setPErr(''); setPassModal(null); } };
  const submitChange = async () => { if (await savePassphrase(false)) setPassModal(null); };
  const submitReset = async () => { if (await savePassphrase(true)) setPassModal(null); };

  const onSaveSchedule = async () => {
    setErr(''); setMsg('');
    try { await saveCfg.mutateAsync({ enabled, hour, keep }); setMsg('Schedule saved.'); }
    catch (e) { setErr((e as Error).message); }
  };

  const onRunNow = async () => {
    setErr(''); setMsg('');
    try { const r = await runBackup.mutateAsync(); setMsg(`Backup created: ${r.file} (${fmtBytes(r.size)}).`); }
    catch (e) { setErr((e as Error).message); }
  };

  const onDownload = (name: string) => {
    const a = document.createElement('a');
    a.href = `/api/internal-backup/download/${encodeURIComponent(name)}`;
    a.download = name;
    a.click();
  };

  const onUploadFile = async (file: File) => {
    setErr(''); setMsg('');
    try { setRestoreTarget({ bytes: await file.arrayBuffer(), fileName: file.name }); setRestoreErr(''); }
    catch (e) { setErr('Could not read the file: ' + (e as Error).message); }
    if (uploadRef.current) uploadRef.current.value = '';
  };

  const doRestore = async (passphrase: string) => {
    if (!restoreTarget) return;
    setRestoreErr('');
    try {
      const result = 'name' in restoreTarget
        ? await restore.mutateAsync({ name: restoreTarget.name, passphrase })
        : await upload.mutateAsync({ bytes: restoreTarget.bytes, passphrase });
      const tableRows = Object.values(result.tables || {}).reduce((n, v) => n + (v || 0), 0);
      setRestoreTarget(null);
      setMsg(`Restored ${result.settings} settings plus ${tableRows} configuration rows - applied immediately.`);
    } catch (e) { setRestoreErr((e as Error).message); }
  };

  const restoreBusy = restore.isPending || upload.isPending;
  const restoreName = restoreTarget ? ('name' in restoreTarget ? restoreTarget.name : restoreTarget.fileName) : '';

  return (
    <div className={cn(CARD, 'max-w-4xl mt-8 flex flex-col gap-5')}>
      <CardHeader
        icon={<Lock size={16} />}
        title="Internal Encrypted Backup"
        description="Complete backups including every secret - envelope-encrypted so only your passphrase can open them; the server itself cannot."
      />

      {/* Status strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StatusChip
          icon={<HardDrive size={16} />}
          label="Backup Folder"
          tone={dirOk ? 'green' : 'amber'}
          value={<><code>{status?.dir || '/backup'}</code> - {dirOk ? 'Writable' : 'Not found or not writable'}</>}
        />
        <StatusChip
          icon={<KeyRound size={16} />}
          label="Encryption Key"
          tone={keyConfigured ? 'green' : 'amber'}
          value={keyConfigured ? 'Configured' : 'Not Set'}
        />
      </div>

      {(!dirOk || !keyConfigured) && (
        <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[0.8rem] text-amber-700 dark:text-amber-400">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            To enable scheduled backups: map <code>BACKUP_DIR</code> to persistent storage
            {!dirOk ? ' (the folder must exist and be writable)' : ''}
            {!keyConfigured ? ' and set an encryption passphrase below' : ''}.
          </span>
        </div>
      )}

      {/* Passphrase */}
      <section className="border-t border-nb-gray-100 dark:border-nb-gray-800 pt-5 flex flex-col gap-3">
        <SectionHead
          title="Encryption Passphrase"
          help="Never stored - it exists only in your head. Losing it makes existing backups unreadable."
        />
        {keyConfigured ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-4 flex-wrap">
              <Button variant="secondary" onClick={() => openPassModal('change')} disabled={setPass.isPending}>
                <KeyRound size={15} /> Change Passphrase
              </Button>
              <button
                type="button"
                onClick={() => openPassModal('reset')}
                disabled={setPass.isPending}
                className="inline-flex items-center gap-1.5 text-[0.8rem] text-red-500 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw size={14} /> Reset (Forgot Current)
              </button>
            </div>
            {pMsg && <Feedback msg={pMsg} />}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="New Passphrase">
                <Input type="password" placeholder="Min 12 characters" value={newPass}
                  onChange={(e) => setNewPass(e.target.value)} />
              </Field>
              <Field label="Confirm Passphrase">
                <Input type="password" placeholder="Re-enter passphrase" value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)} />
              </Field>
            </div>
            <div>
              <Button variant="primary" onClick={() => savePassphrase(false)} disabled={setPass.isPending}>
                <KeyRound size={15} /> Set Passphrase
              </Button>
            </div>
            <Feedback msg={pMsg} err={pErr} />
          </div>
        )}
      </section>

      {/* Schedule + Backup Now */}
      {keyConfigured && (
        <section className="border-t border-nb-gray-100 dark:border-nb-gray-800 pt-5 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <SectionHead
              title="Daily Backup"
              help="Writes an encrypted backup to the folder every day and prunes old files."
            />
            <div className="pt-0.5"><Toggle checked={enabled} onChange={setEnabled} /></div>
          </div>
          <SubPanel disabled={!enabled} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Hour">
                <Select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </Select>
              </Field>
              <Field label="Keep Last" hint="files">
                <Input type="number" min={1} max={90} value={keep}
                  onChange={(e) => setKeep(Number(e.target.value))} />
              </Field>
            </div>
            <div>
              <Button variant="primary" onClick={onSaveSchedule} disabled={saveCfg.isPending}>
                {saveCfg.isPending ? 'Saving...' : 'Save Schedule'}
              </Button>
            </div>
          </SubPanel>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <Button variant="secondary" onClick={onRunNow} disabled={runBackup.isPending || !dirOk}>
                <Play size={15} /> {runBackup.isPending ? 'Backing Up...' : 'Backup Now'}
              </Button>
              <FieldHint>Creates one encrypted backup immediately, outside the schedule.</FieldHint>
            </div>
          </div>
        </section>
      )}

      {/* Backup files */}
      {keyConfigured && (
        <section className="border-t border-nb-gray-100 dark:border-nb-gray-800 pt-5 flex flex-col gap-3">
          <SectionHead title="Backup Files" help="Encrypted .nbbackup files in the backup folder, newest first." />
          {status?.files?.length ? (
            <div className="-mx-4">
              <Table className="table-fixed">
                <THead>
                  <Th>Name</Th>
                  <Th className="w-[190px]">Created</Th>
                  <Th className="w-[110px]">Size</Th>
                  <Th className="w-[210px] text-right">Actions</Th>
                </THead>
                <TBody>
                  {status.files.map((f) => (
                    <Tr key={f.name}>
                      <Td>
                        <span className="block truncate font-mono text-xs text-nb-gray-700 dark:text-nb-gray-300" title={f.name}>{f.name}</span>
                      </Td>
                      <Td className="whitespace-nowrap text-nb-gray-600 dark:text-nb-gray-400">{formatTimestamp(f.at)}</Td>
                      <Td className="whitespace-nowrap text-nb-gray-600 dark:text-nb-gray-400">{fmtBytes(f.size)}</Td>
                      <Td>
                        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                          <IconButton title="Download" onClick={() => onDownload(f.name)}><Download size={15} /></IconButton>
                          <Button variant="secondary" size="sm" onClick={() => { setRestoreErr(''); setRestoreTarget({ name: f.name }); }}>
                            <RotateCcw size={14} /> Restore
                          </Button>
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-nb-gray-200 dark:border-nb-gray-800">
              <EmptyState title="No Backups Yet" hint="Run a backup or enable the daily schedule to create one." icon={<Archive size={26} />} />
            </div>
          )}
        </section>
      )}

      {/* Restore from an uploaded file */}
      <section className="border-t border-nb-gray-100 dark:border-nb-gray-800 pt-5 flex flex-col gap-3">
        <SectionHead
          title="Restore From an Uploaded File"
          help="Restore a .nbbackup file from another server - you will need the passphrase that encrypted it."
        />
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="secondary" onClick={() => uploadRef.current?.click()}>
            <Upload size={15} /> Choose File
          </Button>
          <FieldHint>Accepts a .nbbackup file. You will be asked for its passphrase next.</FieldHint>
          <input ref={uploadRef} type="file" accept=".nbbackup" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadFile(f); }} />
        </div>
      </section>

      {/* Backup Now / schedule / restore feedback (shared by all actions). */}
      {(msg || err) && <Feedback msg={msg} err={err} />}

      <RestoreModal
        open={!!restoreTarget}
        fileName={restoreName}
        busy={restoreBusy}
        error={restoreErr}
        onClose={() => { if (!restoreBusy) setRestoreTarget(null); }}
        onSubmit={doRestore}
      />

      {/* Change the passphrase - proves the current one, then rotates to a new one. */}
      <Modal
        open={passModal === 'change'}
        onClose={closePassModal}
        title="Change Passphrase"
        icon={<KeyRound size={18} />}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closePassModal} disabled={setPass.isPending}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={submitChange} disabled={setPass.isPending}>
              {setPass.isPending ? 'Changing...' : 'Change'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Current Passphrase">
            <Input type="password" placeholder="Current passphrase" value={curPass}
              onChange={(e) => setCurPass(e.target.value)} />
          </Field>
          <Field label="New Passphrase" hint="Minimum 12 characters.">
            <Input type="password" placeholder="Min 12 characters" value={newPass}
              onChange={(e) => setNewPass(e.target.value)} />
          </Field>
          <Field label="Confirm New Passphrase">
            <Input type="password" placeholder="Re-enter new passphrase" value={confirmPass}
              onChange={(e) => setConfirmPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitChange(); }} />
          </Field>
          {pErr && <p className="text-sm text-red-500">{pErr}</p>}
        </div>
      </Modal>

      {/* Reset (forgot current) - the danger button IS the confirmation; the warning replaces the
          old confirm() dialog. */}
      <Modal
        open={passModal === 'reset'}
        onClose={closePassModal}
        title="Reset Passphrase"
        icon={<RefreshCw size={18} />}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closePassModal} disabled={setPass.isPending}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={submitReset} disabled={setPass.isPending}>
              {setPass.isPending ? 'Resetting...' : 'Reset Passphrase'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[0.8rem] leading-relaxed text-amber-700 dark:text-amber-400">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>
              This generates a brand-new encryption keypair. Existing backup files stay readable
              <b> only</b> with their old passphrase - the new passphrase cannot open them. New
              backups will use the new key.
            </span>
          </div>
          <Field label="New Passphrase" hint="Minimum 12 characters.">
            <Input type="password" placeholder="Min 12 characters" value={newPass}
              onChange={(e) => setNewPass(e.target.value)} />
          </Field>
          <Field label="Confirm New Passphrase">
            <Input type="password" placeholder="Re-enter new passphrase" value={confirmPass}
              onChange={(e) => setConfirmPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitReset(); }} />
          </Field>
          {pErr && <p className="text-sm text-red-500">{pErr}</p>}
        </div>
      </Modal>
    </div>
  );
}

// ─── Settings tab: two backup tiers - the secret-free export, and the internal encrypted backup ───
export function BackupRestore() {
  return (
    <div>
      <PlaintextExportCard />
      <InternalBackupCard />
    </div>
  );
}
