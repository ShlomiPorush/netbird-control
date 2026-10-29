import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppConfig, useProxyDomains } from '@/lib/queries';
import { useSaveAppConfig } from '@/lib/mutations';
import { formatTimeWith, DATE_FORMATS } from '@/lib/logfmt';
import { Button, LoadingState, Input, SelectMenu, Field } from '@/components/ui';

// Full IANA timezone list (modern browsers/Node 18+); falls back to a small curated
// list on older engines. '' = the browser's local zone.
const TIMEZONES: string[] = (() => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) return fn('timeZone');
  } catch { /* ignore */ }
  return ['UTC', 'Asia/Jerusalem', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
})();

const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
})();

// Example for each date-format preset (the date part only), in a fixed sample date.
const DATE_FORMAT_SAMPLES: Record<string, string> = {
  med: 'Jun 28, 2026', dmy_med: '28 Jun 2026', iso: '2026-06-28', dmy: '28/06/2026', mdy: '06/28/2026',
};

export function General() {
  const { data, isLoading } = useAppConfig();
  const save = useSaveAppConfig();
  const [name, setName] = useState('');
  const [tz, setTz] = useState('');
  const [dateFormat, setDateFormat] = useState('med');
  const [hour12, setHour12] = useState(true);
  const [showResourceGroups, setShowResourceGroups] = useState(true);
  const [policyTpl, setPolicyTpl] = useState('');
  const [sharedTpl, setSharedTpl] = useState('');
  const [proxyDomain, setProxyDomain] = useState('');
  const [saved, setSaved] = useState(false);
  const proxyDomains = useProxyDomains().data || [];

  // Sync inputs with the loaded values once they arrive.
  useEffect(() => {
    if (data) {
      setName(data.appName); setTz(data.timeZone); setDateFormat(data.dateFormat);
      setHour12(data.hour12); setShowResourceGroups(data.showResourceGroups);
      setPolicyTpl(data.policyNameTemplate);
      setSharedTpl(data.policyNameTemplateShared);
      setProxyDomain(data.proxyDefaultDomain);
    }
  }, [data]);

  // Live preview of the current time using the (unsaved) selected options.
  const preview = useMemo(
    () => formatTimeWith(new Date(), { timeZone: tz, dateFormat, hour12 }),
    [tz, dateFormat, hour12],
  );

  const trimmed = name.trim();
  const dirty = !!data && (trimmed !== data.appName || tz !== data.timeZone || dateFormat !== data.dateFormat || hour12 !== data.hour12 || showResourceGroups !== data.showResourceGroups || policyTpl.trim() !== data.policyNameTemplate || sharedTpl.trim() !== data.policyNameTemplateShared || proxyDomain !== data.proxyDefaultDomain);

  // Live example of the policy-name template, using a sample resource + protocol.
  const tplPreview = useMemo(() => {
    const tpl = policyTpl.trim() || '{resource} Policy';
    return tpl.replace(/\{resource\}/gi, 'DC').replace(/\{protocol\}/gi, 'TCP');
  }, [policyTpl]);

  // Clicking a placeholder chip inserts it at the cursor (replacing any selection).
  const tplRef = useRef<HTMLInputElement>(null);
  const insertPlaceholder = (token: string) => {
    const el = tplRef.current;
    const start = el?.selectionStart ?? policyTpl.length;
    const end = el?.selectionEnd ?? start;
    setPolicyTpl(policyTpl.slice(0, start) + token + policyTpl.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // Shared-resource template (resources holding 2+ policies keep per-policy identity).
  const sharedPreview = useMemo(() => {
    const tpl = sharedTpl.trim() || '{service}';
    return tpl.replace(/\{service\}/gi, 'Adgar Host1').replace(/\{resource\}/gi, 'Adgar Networks').replace(/\{protocol\}/gi, 'TCP');
  }, [sharedTpl]);
  const sharedRef = useRef<HTMLInputElement>(null);
  const insertSharedPlaceholder = (token: string) => {
    const el = sharedRef.current;
    const start = el?.selectionStart ?? sharedTpl.length;
    const end = el?.selectionEnd ?? start;
    setSharedTpl(sharedTpl.slice(0, start) + token + sharedTpl.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const onSave = async () => {
    if (!trimmed || !dirty) return;
    await save.mutateAsync({ appName: trimmed, timeZone: tz, dateFormat, hour12, showResourceGroups, policyNameTemplate: policyTpl.trim(), policyNameTemplateShared: sharedTpl.trim(), proxyDefaultDomain: proxyDomain });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="max-w-xl">
      <p className="text-nb-gray-500 text-sm mb-5">The application name and how log times are displayed across the app.</p>
      {isLoading ? <LoadingState /> : (
        <div className="flex flex-col gap-4">
          <Field label="Application Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSave(); }}
              placeholder="NetBird Control"
              maxLength={60}
            />
          </Field>

          <Field label="Time Zone" hint="All log timestamps across the app are shown in this zone.">
            <SelectMenu value={tz} onChange={(v) => setTz(v)}
              options={[
                { value: '', label: `Browser local time${BROWSER_TZ ? ` (${BROWSER_TZ})` : ''}` },
                ...TIMEZONES.map((z) => ({ value: z, label: z.replace(/_/g, ' ') })),
              ]} />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Date Format">
              <SelectMenu value={dateFormat} onChange={(v) => setDateFormat(v)} searchable={false}
                options={DATE_FORMATS.map((f) => ({ value: f, label: DATE_FORMAT_SAMPLES[f] || f }))} />
            </Field>
            <Field label="Clock">
              <SelectMenu value={hour12 ? '12' : '24'} onChange={(v) => setHour12(v === '12')} searchable={false}
                options={[
                  { value: '12', label: '12-hour (2:30 PM)' },
                  { value: '24', label: '24-hour (14:30)' },
                ]} />
            </Field>
          </div>

          <div className="text-sm text-nb-gray-500">
            Preview: <span className="font-medium text-nb-gray-700 dark:text-nb-gray-200">{preview}</span>
          </div>

          <Field label="Policy Name Template"
            hint={<>Default name suggested for a NEW resource policy - click a placeholder to insert it. The name updates live in the editor until you type your own; existing policies can be aligned with <b>Tidy Names</b> on the Policies page. Example with this template: <b className="text-nb-gray-700 dark:text-nb-gray-200">{tplPreview}</b></>}>
            <div className="flex flex-col gap-2">
              <Input ref={tplRef} value={policyTpl} onChange={(e) => setPolicyTpl(e.target.value)} placeholder="{resource} Policy" maxLength={80} />
              <div className="flex flex-wrap items-center gap-1.5">
                {([['{resource}', 'Resource Name'], ['{protocol}', 'TCP / UDP / ALL / ICMP']] as const).map(([token, desc]) => (
                  <button key={token} type="button" onClick={() => insertPlaceholder(token)} title={`${desc} - click to insert`}
                    className="inline-flex items-center rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 px-2 py-0.5 font-mono text-[0.74rem] text-nb-gray-700 dark:text-nb-gray-300 hover:border-netbird/40 hover:text-netbird transition-colors cursor-pointer">
                    {token}
                  </button>
                ))}
              </div>
            </div>
          </Field>

          <Field label="Shared-Resource Policy Template"
            hint={<>Used by <b>Tidy Names</b> for policies of a resource that holds <b>2+ policies</b> (a merged host with per-service port rules). <b>{'{service}'}</b> = the policy's current name minus generic words (Policy / Access / Rule) - the names keep their identity instead of collapsing into one. Example: <b className="text-nb-gray-700 dark:text-nb-gray-200">{sharedPreview}</b></>}>
            <div className="flex flex-col gap-2">
              <Input ref={sharedRef} value={sharedTpl} onChange={(e) => setSharedTpl(e.target.value)} placeholder="{service}" maxLength={80} />
              <div className="flex flex-wrap items-center gap-1.5">
                {([['{service}', 'Cleaned current name'], ['{resource}', 'Resource Name'], ['{protocol}', 'TCP / UDP / ALL / ICMP']] as const).map(([token, desc]) => (
                  <button key={token} type="button" onClick={() => insertSharedPlaceholder(token)} title={`${desc} - click to insert`}
                    className="inline-flex items-center rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-100 dark:bg-nb-gray-900 px-2 py-0.5 font-mono text-[0.74rem] text-nb-gray-700 dark:text-nb-gray-300 hover:border-netbird/40 hover:text-netbird transition-colors cursor-pointer">
                    {token}
                  </button>
                ))}
              </div>
            </div>
          </Field>

          {proxyDomains.length > 0 && (
            <Field label="Default Proxy Domain"
              hint="Preselected in the domain picker when adding a Reverse Proxy service (the proxy cluster always follows the chosen domain).">
              <SelectMenu value={proxyDomain} onChange={(v) => setProxyDomain(v)} searchable
                options={[
                  { value: '', label: 'First Available' },
                  ...proxyDomains.map((d) => ({ value: d.domain, label: `.${d.domain}` })),
                ]} />
            </Field>
          )}

          <label className="flex items-start gap-3 pt-1 cursor-pointer">
            <input type="checkbox" className="h-4 w-4 mt-0.5 accent-netbird" checked={showResourceGroups} onChange={(e) => setShowResourceGroups(e.target.checked)} />
            <span className="text-sm">
              <span className="font-medium text-nb-gray-800 dark:text-nb-gray-100">Show “Resource Groups” on resources</span>
              <span className="block text-nb-gray-500 text-[0.8rem]">Optional field to add a resource to groups (useful for reusing one policy across many resources). Hide it if you give each resource its own policy.</span>
            </span>
          </label>

          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={onSave} disabled={!trimmed || !dirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
            {save.isError && <span className="text-sm text-red-500">Failed to save</span>}
          </div>
        </div>
      )}
    </div>
  );
}
