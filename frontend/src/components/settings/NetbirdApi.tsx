import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { useNetbirdApiConfig, useMspStatus } from '@/lib/queries';
import { useSaveNetbirdApi, useSetProvisioningToken } from '@/lib/mutations';
import { Button, LoadingState, Input, Field } from '@/components/ui';

export function NetbirdApi() {
  const { data, isLoading } = useNetbirdApiConfig();
  const save = useSaveNetbirdApi();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (data) setUrl(data.url); }, [data]);

  const onSave = async () => {
    setError('');
    try {
      await save.mutateAsync({ url: url.trim(), token: token.trim() || undefined });
      setToken('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message || 'Failed to save');
    }
  };

  const urlLocked = !!data?.urlFromEnv;
  const tokenLocked = !!data?.tokenFromEnv;
  const bothLocked = urlLocked && tokenLocked;
  // Something editable, and the editable required fields are valid.
  const canSave = !bothLocked
    && (urlLocked || !!url.trim())
    && (tokenLocked || !!data?.hasToken || !!token.trim());

  const ENV_HINT = 'Managed by an environment variable - edit it in your deployment config, not here.';

  return (
    <div className="max-w-xl">
      <p className="text-nb-gray-500 text-sm mb-5">
        Connect to your NetBird Management API to resolve users, peers and groups and to manage network resources.
        The token is stored on the server and never shown again.
      </p>
      {isLoading ? <LoadingState /> : (
        <div className="flex flex-col gap-4">
          <Field
            label="Management API URL"
            hint={urlLocked ? ENV_HINT : 'Your NetBird management URL, e.g. https://api.netbird.io or https://netbird.example.com'}
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.netbird.io"
              disabled={urlLocked}
              className={urlLocked ? 'opacity-60 cursor-not-allowed' : undefined}
            />
          </Field>
          <Field
            label="API Token (PAT)"
            hint={tokenLocked
              ? ENV_HINT
              : data?.hasToken
                ? 'A token is configured. Leave blank to keep it, or enter a new one to replace it.'
                : 'Create a Personal Access Token in NetBird (Settings → Service Users / Access Tokens) and paste it here.'}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={tokenLocked ? '' : token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={tokenLocked ? '•••••••••••• (from environment)' : data?.hasToken ? '•••••••••••• (configured)' : 'nbp_…'}
              disabled={tokenLocked}
              className={tokenLocked ? 'opacity-60 cursor-not-allowed' : undefined}
            />
          </Field>

          <div className="flex items-center gap-3">
            {!bothLocked && (
              <Button variant="primary" onClick={onSave} disabled={save.isPending || !canSave}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            )}
            {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
            {error && <span className="text-sm text-red-500">{error}</span>}
            {!save.isPending && !saved && !error && (
              <span className="inline-flex items-center gap-1.5 text-sm text-nb-gray-500">
                <span className={cn('h-2 w-2 rounded-full', data?.hasToken && data?.url ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
                {data?.hasToken && data?.url ? 'Connected' : 'Not configured'}
              </span>
            )}
          </div>

          <MspProvisioningSection />
        </div>
      )}
    </div>
  );
}

/* ─── MSP Provisioning Token - only shown on activated MSP accounts ───
 * A USER token (an MSP admin in the tenants' permission groups; service users can't join
 * groups). Used ONLY to create each tenant's managed service user + token - all routine
 * tenant calls then run with the tenant's own token. */
function MspProvisioningSection() {
  const msp = useMspStatus().data;
  const save = useSetProvisioningToken();
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  if (!msp?.available) return null;

  const onSave = async (clear = false) => {
    setError('');
    try {
      await save.mutateAsync(clear ? '' : token.trim());
      setToken('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed to save'); }
  };

  return (
    <div className="mt-2 border-t border-nb-gray-200 dark:border-nb-gray-800 pt-5 flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50">MSP Provisioning Token</h3>
        <p className="mt-1 text-sm text-nb-gray-500">
          A token of a REAL user (an MSP admin who is in the tenants' permission groups) - service-user tokens
          cannot access tenants. Used only to create a managed service user + token inside each tenant; day-to-day
          tenant calls use the tenant's own token. Rotation of tenant tokens is automatic.
        </p>
      </div>
      <Field label="User Token (PAT)"
        hint={msp.hasProvisioningToken ? 'A token is configured. Leave blank to keep it, or enter a new one to replace it.' : 'Create it under your OWN user in NetBird (Profile → Access Tokens).'}>
        <Input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)}
          placeholder={msp.hasProvisioningToken ? '•••••••••••• (configured)' : 'nbp_…'} />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => onSave(false)} disabled={save.isPending || !token.trim()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {msp.hasProvisioningToken && (
          <Button variant="secondary" onClick={() => onSave(true)} disabled={save.isPending}>Clear</Button>
        )}
        {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
        {error && <span className="text-sm text-red-500">{error}</span>}
        {!save.isPending && !saved && !error && (
          <span className="inline-flex items-center gap-1.5 text-sm text-nb-gray-500">
            <span className={cn('h-2 w-2 rounded-full', msp.hasProvisioningToken ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
            {msp.hasProvisioningToken ? 'Configured' : 'Not configured'}
          </span>
        )}
      </div>
    </div>
  );
}
