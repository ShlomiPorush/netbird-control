import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, TriangleAlert } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { apiKeysApi, type ApiKey } from '@/lib/remoteAccess';
import { formatTimestamp } from '@/lib/logfmt';
import { useConfirm } from '@/contexts/ConfirmContext';
import { Badge, Button, Checkbox, CopyButton, EmptyState, Field, Input, LoadingState, Modal, Textarea } from '@/components/ui';

// Settings -> API Keys: keys other systems use to call the public API (/api/v1). A key is shown
// once when it is created; only its first characters are kept for telling keys apart.

const SCOPE_NAMES: Record<string, string> = { 'remote-access:launch': 'Open Remote Sessions' };

// Replace = a new key with the old key's settings. keepExpiry: the old key's exact expiry, sent as
// it is unless the admin changes the date (the server refuses it if it has passed meanwhile).
type Draft = { name: string; scopes: string[]; allowedIps: string; expiresAt: string; replaces?: ApiKey; keepExpiry?: string; expiryTouched?: boolean };

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The expiry's day as the date field shows it (local). A past expiry is dropped: the form accepts
// only today or later.
function dateOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return '';
  return localDay(d);
}

function expiryToSend(d: Draft): string | null {
  if (d.keepExpiry && !d.expiryTouched) return d.keepExpiry;
  return d.expiresAt ? new Date(`${d.expiresAt}T23:59:59`).toISOString() : null;
}

function status(k: ApiKey): { label: string; tone: 'green' | 'gray' | 'red' } {
  if (k.revokedAt) return { label: 'Revoked', tone: 'gray' };
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) return { label: 'Expired', tone: 'red' };
  return { label: 'Active', tone: 'green' };
}

export function ApiKeys() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ key: string; name: string; replaces?: ApiKey } | null>(null);
  // A sign-in that ends while the new key is on screen takes the page to the sign-in like
  // anywhere else: the key is then lost (create another, and revoke the lost one in the list).
  const list = useQuery({ queryKey: ['api-keys'], queryFn: apiKeysApi.list });

  const create = useMutation({
    mutationFn: (d: Draft) => apiKeysApi.create({ name: d.name.trim(), scopes: d.scopes, allowedIps: d.allowedIps, expiresAt: expiryToSend(d) }),
    onSuccess: (out, d) => { setDraft(null); setCreated({ key: out.key, name: out.apiKey.name, replaces: d.replaces }); },
    onError: (e) => setError(e instanceof ApiError ? e.message : "The key couldn't be created. Try again."),
    onSettled: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => apiKeysApi.revoke(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  if (list.isLoading) return <LoadingState />;
  if (!list.data) return <p className="text-sm text-red-500">The API keys could not be loaded.</p>;
  const { keys, scopes, trustProxy } = list.data;

  const open = (d?: Partial<Draft>) => { setError(''); setDraft({ name: '', scopes: scopes.map((s) => s.id), allowedIps: '', expiresAt: '', ...d }); };
  // The expiry's day is worked out once, so the field and the exact value always agree.
  const replace = (k: ApiKey) => {
    const day = dateOf(k.expiresAt);
    open({ name: k.name, scopes: k.scopes, allowedIps: k.allowedIps.join('\n'), expiresAt: day, keepExpiry: day ? k.expiresAt || undefined : undefined, replaces: k });
  };
  const closeCreated = () => setCreated(null);
  const submit = (e: FormEvent) => { e.preventDefault(); if (draft) create.mutate(draft); };
  const askRevoke = async (k: ApiKey) => {
    const ok = await confirm({
      title: 'Revoke This Key?',
      message: `"${k.name}" stops working at once, including connection links it made that were not opened yet. Sessions already open stay open.`,
      confirmText: 'Revoke', danger: true,
    });
    if (ok) revoke.mutate(k.id, { onError: (e) => void confirm({ title: 'Failed To Revoke', message: e instanceof ApiError ? e.message : 'Try again.', confirmText: 'OK' }) });
  };

  return (
    <div className="max-w-3xl">
      <p className="text-nb-gray-500 text-sm mb-5">
        Keys let another system, such as the customer file, call the NetBird Control API. Each key can do only what its permissions allow.
        Creating and revoking a key, and every connection link a key makes or that is opened, are recorded in the audit log.
        The key is shown once when you create it, so store it in that system's secret store.
      </p>

      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-nb-gray-900 dark:text-nb-gray-50">Keys</h3>
        <Button variant="primary" size="sm" onClick={() => open()}><Plus size={15} /> Create Key</Button>
      </div>

      {keys.length === 0 ? (
        <EmptyState icon={<KeyRound size={22} />} title="No API Keys Yet" hint="Create a key for each system that calls the API." />
      ) : (
        <div className="flex flex-col gap-2">
          {keys.map((k) => {
            const st = status(k);
            return (
              <div key={k.id} className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-nb-gray-900 dark:text-nb-gray-50">{k.name}</span>
                  <code className="text-[0.75rem] text-nb-gray-500">{k.prefix}…</code>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {!k.revokedAt && (
                    <div className="ml-auto flex gap-2">
                      <Button size="sm" onClick={() => replace(k)}>Replace</Button>
                      <Button size="sm" variant="danger" onClick={() => void askRevoke(k)} disabled={revoke.isPending}>Revoke</Button>
                    </div>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-400">
                  <span>Permissions: {k.scopes.map((s) => SCOPE_NAMES[s] || s).join(', ')}</span>
                  <span>Allowed From: {k.allowedIps.length ? k.allowedIps.join(', ') : 'Any address'}</span>
                  <span>Created: {formatTimestamp(k.createdAt)}{k.createdBy ? ` by ${k.createdBy}` : ''}</span>
                  <span>Last Used: {k.lastUsedAt ? `${formatTimestamp(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}` : 'Never'}</span>
                  <span>Expires: {k.expiresAt ? formatTimestamp(k.expiresAt) : 'Never'}</span>
                  {k.revokedAt && <span>Revoked: {formatTimestamp(k.revokedAt)}{k.revokedBy ? ` by ${k.revokedBy}` : ''}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={!!draft} onClose={() => setDraft(null)} title={draft?.replaces ? 'Replace API Key' : 'Create API Key'}
        subtitle={draft?.replaces ? `A new key with the same settings. "${draft.replaces.name}" keeps working until you revoke it, so you can move the other system to the new key first.` : undefined}
        icon={<KeyRound size={18} />}
        footer={<>
          <Button onClick={() => setDraft(null)}>Cancel</Button>
          <Button variant="primary" type="submit" form="api-key-form" disabled={create.isPending || !draft?.name.trim() || !draft?.scopes.length}>
            {create.isPending ? 'Creating…' : draft?.replaces ? 'Create New Key' : 'Create Key'}
          </Button>
        </>}>
        {draft && (
          <form id="api-key-form" onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Name" hint="Which system uses this key, for example Customer File.">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} autoFocus required />
            </Field>
            <Field label="Permissions">
              <div className="flex flex-col gap-2">
                {scopes.map((s) => (
                  <label key={s.id} className="flex items-start gap-2 text-sm text-nb-gray-700 dark:text-nb-gray-200">
                    <Checkbox className="mt-0.5" checked={draft.scopes.includes(s.id)}
                      onChange={(e) => setDraft({ ...draft, scopes: e.target.checked ? [...draft.scopes, s.id] : draft.scopes.filter((x) => x !== s.id) })} />
                    <span><b>{SCOPE_NAMES[s.id] || s.id}</b><br /><span className="text-nb-gray-500">{s.label}</span></span>
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Allowed Addresses (Optional)"
              hint={<>IP addresses or ranges (CIDR) the key may be used from, one per line. Empty: any address.
                {!trustProxy && <> Behind a reverse proxy, set TRUST_PROXY first, or every call seems to come from the proxy.</>}</>}>
              <Textarea value={draft.allowedIps} onChange={(e) => setDraft({ ...draft, allowedIps: e.target.value })} rows={2} placeholder="203.0.113.10" spellCheck={false} />
            </Field>
            <Field label="Expires (Optional)" hint="The key stops working at the end of this day. Empty: it never expires.">
              <Input type="date" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value, expiryTouched: true })} min={localDay(new Date())} />
            </Field>
            {error && <p className="text-sm text-red-500">{error}</p>}
          </form>
        )}
      </Modal>

      <Modal open={!!created} onClose={closeCreated} title="Copy The New Key" icon={<KeyRound size={18} />}
        footer={<Button variant="primary" onClick={closeCreated}>Done</Button>}>
        {created && (
          <div className="flex flex-col gap-3">
            <p className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
              <TriangleAlert size={16} className="shrink-0 mt-0.5" />
              This is the only time the key for "{created.name}" is shown. Store it in the other system's secret store, not in its code or settings files.
            </p>
            {created.replaces && (
              <p className="text-sm text-nb-gray-600 dark:text-nb-gray-300">
                Put the new key in the other system, then revoke the old key "{created.replaces.name}" in the list.
              </p>
            )}
            <div className="flex items-center gap-2 rounded-md border border-nb-gray-200 dark:border-nb-gray-700 bg-nb-gray-50 dark:bg-nb-gray-900 px-3 py-2">
              <code className="flex-1 break-all text-[0.8rem] text-nb-gray-900 dark:text-nb-gray-100">{created.key}</code>
              <CopyButton value={created.key} title="Copy Key" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
