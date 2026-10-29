import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTenantDefaults } from '@/lib/queries';
import { useSaveTenantDefaults } from '@/lib/mutations';
import type { TenantDefaultsProfile } from '@/lib/types';
import { Button, Field, FieldHint, Input, LoadingState } from '@/components/ui';
import { CategoryHeader, SettingRow, Toggle, NetbirdCategoryCards, CARD, ROWS } from './NetbirdFields';

// ─── Tenant Defaults (admin, main only, MSP) - the profile new tenants are seeded with and that
// "Apply Defaults" on the Tenants page applies. Independent of this account's own live settings.
// The full NetBird field UI is shared with the live NetBird Settings editor (NetbirdCategoryCards);
// only Tenant Defaults adds the master toggle, App Defaults (retention + copy flags) and the
// "Load Current Main Values" prefill. ───
export function TenantDefaults() {
  const { data, isLoading } = useTenantDefaults();
  const save = useSaveTenantDefaults();
  const [form, setForm] = useState<TenantDefaultsProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Prefill: the saved profile when configured, otherwise main's current live settings.
  useEffect(() => {
    if (data && !form) setForm(data.configured && data.profile ? data.profile : data.mainCurrent);
  }, [data, form]);

  if (isLoading || !data || !form) return <LoadingState />;

  const nb = form.nb;
  const setNb = (patch: Partial<TenantDefaultsProfile['nb']>) => setForm({ ...form, nb: { ...form.nb, ...patch } });
  const off = !nb.enabled;

  const onSave = async () => {
    setError('');
    try {
      await save.mutateAsync(form);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed to save'); }
  };
  // Fill the form from main's current live settings (does NOT save).
  const loadFromMain = () => { setForm(data.mainCurrent); setSaved(false); setError(''); };

  return (
    <div className="max-w-2xl">
      <p className="text-nb-gray-500 text-sm mb-4">
        These defaults are applied to every <b>new</b> tenant on creation, and by <b>Apply Defaults</b> on the
        Tenants page. They are independent of your own account's settings - editing them here never changes
        this main account.
      </p>

      {!data.configured && (
        <p className="mb-5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800/70 bg-nb-gray-100/60 dark:bg-nb-gray-900/70 px-3.5 py-2.5 text-[0.8rem] text-nb-gray-600 dark:text-nb-gray-300">
          No defaults profile is saved yet - new tenants currently inherit this main account's live settings.
          The form below is prefilled from those. Save to lock in an explicit profile.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {/* Master toggle: gates every NetBird category below. */}
        <div className={CARD}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Apply NetBird Settings To New Tenants</div>
              <p className="text-[0.82rem] text-nb-gray-500 mt-0.5">
                Applied to each new tenant's NetBird account. Turn off to leave a new tenant's account settings untouched.
              </p>
            </div>
            <div className="pt-0.5"><Toggle checked={nb.enabled} onChange={(v) => setNb({ enabled: v })} /></div>
          </div>
        </div>

        {/* NetBird categories - mirror the official Settings tabs. Dimmed and locked when the master toggle is off. */}
        <div className={cn('flex flex-col gap-4', off && 'opacity-50 pointer-events-none')}>
          <NetbirdCategoryCards nb={nb} setNb={setNb} off={off} mfaSupported={data.mfaSupported} variant="defaults" />
        </div>

        {/* App Defaults - this app's own per-tenant settings, independent of the master toggle. */}
        <div className={CARD}>
          <CategoryHeader icon={SlidersHorizontal} title="App Defaults"
            description="This app's own per-tenant settings for new tenants." />
          <div className="border-t border-nb-gray-100 dark:border-nb-gray-800 pt-4 flex flex-col gap-4">
            <Field label="Data Retention (Days)" hint="How long a new tenant keeps events. Leave empty to use this main account's retention.">
              <Input type="number" min={1} max={3650} className="w-32"
                value={form.retentionDays ?? ''}
                onChange={(e) => setForm({ ...form, retentionDays: e.target.value.trim() === '' ? null : (parseInt(e.target.value, 10) || 0) })} />
            </Field>
            <div className={ROWS}>
              <SettingRow title="Copy Event Filtering Rules From Main"
                checked={form.copyFilterRules} onChange={(v) => setForm({ ...form, copyFilterRules: v })} />
              <SettingRow title="Copy Blocklist From Main" help="Network-scoped entries are never copied."
                checked={form.copyBlocklist} onChange={(v) => setForm({ ...form, copyBlocklist: v })} />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="primary" onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save Defaults'}</Button>
          <Button variant="secondary" onClick={loadFromMain} disabled={save.isPending}>Load Current Main Values</Button>
          {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
          {error && <span className="text-sm text-red-500">{error}</span>}
          <FieldHint>Load Current Main Values fills the form from this account's live settings - it does not save.</FieldHint>
        </div>
      </div>
    </div>
  );
}
