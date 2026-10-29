import { useEffect, useState } from 'react';
import { useNetbirdSettings } from '@/lib/queries';
import { useSaveNetbirdSettings } from '@/lib/mutations';
import { getTenantMode } from '@/lib/api';
import type { NetbirdNbSettings } from '@/lib/types';
import { Button, LoadingState } from '@/components/ui';
import { NetbirdCategoryCards } from './NetbirdFields';

// ─── NetBird Settings (admin) - the LIVE editor for the CURRENT account's own NetBird settings.
// Works for the main account AND for a managed tenant (Settings runs in tenant context too), reading
// and writing the account's ACTUAL settings via the ALS-aware backend. Distinct from Tenant Defaults,
// which is the seed template for NEW tenants. No master toggle, no copy flags, no retention (retention
// has its own tab); a single Save writes the whole account settings object. ───
export function NetbirdSettings() {
  const { data, isLoading } = useNetbirdSettings();
  const save = useSaveNetbirdSettings();
  const [form, setForm] = useState<NetbirdNbSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const inTenantMode = !!getTenantMode();

  useEffect(() => {
    if (data && !form) setForm(data.nb);
  }, [data, form]);

  if (isLoading || !data || !form) return <LoadingState />;

  const setNb = (patch: Partial<NetbirdNbSettings>) => setForm({ ...form, ...patch });

  const onSave = async () => {
    setError('');
    try {
      const res = await save.mutateAsync(form);
      setForm(res.nb); // reflect the account's merged/normalized settings after the write
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed to save'); }
  };

  return (
    <div className="max-w-2xl">
      <p className="text-nb-gray-500 text-sm mb-4">
        {inTenantMode
          ? "Edit the managed tenant's own live NetBird account settings. Changes apply immediately to that tenant's account."
          : "Edit this account's live NetBird settings. Changes apply immediately to the whole account."}
        {' '}This is the account's actual configuration - separate from Tenant Defaults, which only seeds new tenants.
      </p>

      <div className="flex flex-col gap-4">
        <NetbirdCategoryCards nb={form} setNb={setNb} mfaSupported={data.mfaSupported} variant="live" />

        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="primary" onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save Settings'}</Button>
          {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
          {error && <span className="text-sm text-red-500">{error}</span>}
        </div>
      </div>
    </div>
  );
}
