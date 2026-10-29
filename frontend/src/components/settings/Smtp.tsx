import { useEffect, useState } from 'react';
import { Eye, EyeOff, Send } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSmtpConfig } from '@/lib/queries';
import { useSaveSmtp, useTestSmtp } from '@/lib/mutations';
import type { SmtpConfigInput } from '@/lib/types';
import { Button, LoadingState, Input, Field } from '@/components/ui';

const SMTP_ENV_HINT = 'Managed by SMTP_* environment variables - edit them in your deployment config, not here.';

export function Smtp() {
  const { data, isLoading } = useSmtpConfig();
  const save = useSaveSmtp();
  const test = useTestSmtp();
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [from, setFrom] = useState('');
  const [complianceEmail, setComplianceEmail] = useState(true);
  const [testTo, setTestTo] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setHost(data.host || '');
      setPort(String(data.port || 587));
      setSecure(!!data.secure);
      setUser(data.user || '');
      setFrom(data.from || '');
      setComplianceEmail(data.complianceBlockedEmail !== false);
    }
  }, [data]);

  const envManaged = !!data?.envManaged;
  const payload = (): SmtpConfigInput => ({ enabled, host: host.trim(), port: Number(port) || 587, secure, user: user.trim(), from: from.trim(), pass: pass.trim() || undefined, complianceBlockedEmail: complianceEmail });
  const onSave = async () => {
    setError(''); setTestMsg('');
    try { await save.mutateAsync(payload()); setPass(''); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    catch (e) { setError((e as Error).message || 'Failed to save'); }
  };
  const onTest = async () => {
    setError(''); setTestMsg('');
    try {
      if (!envManaged) { await save.mutateAsync(payload()); setPass(''); } // save first so the test uses the latest values
      const r = await test.mutateAsync(testTo.trim() || undefined);
      setTestMsg(r.ok ? '✅ Test email sent.' : `❌ ${r.error || 'Failed to send'}`);
    } catch (e) { setError((e as Error).message || 'Test failed'); }
  };

  const lockCls = envManaged ? 'opacity-60 cursor-not-allowed' : undefined;
  if (isLoading) return <LoadingState />;
  return (
    <div className="max-w-xl">
      <p className="text-nb-gray-500 text-sm mb-5">
        Send email to users - so a requester learns when their access is <b>approved</b>, <b>denied</b>, or <b>ends</b>, and anyone
        given temporary access gets a heads-up. The password is stored on the server and never shown again.
      </p>
      {envManaged && (
        <p className="mb-4 text-[0.82rem] rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/40 px-3 py-2 text-nb-gray-600 dark:text-nb-gray-300">{SMTP_ENV_HINT}</p>
      )}
      <div className="flex flex-col gap-4">
        <label className={cn('flex items-center gap-3 p-3.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-nb-gray-50 dark:bg-nb-gray-900/30', envManaged ? 'cursor-not-allowed' : 'cursor-pointer')}>
          <input type="checkbox" className="h-4 w-4 accent-netbird" checked={enabled} disabled={envManaged} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="text-sm">
            <span className="font-medium text-nb-gray-800 dark:text-nb-gray-100">Enable email notifications</span>
            <span className="block text-nb-gray-500 text-[0.8rem]">Master switch - when off, no emails are sent.</span>
          </span>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2">
            <Field label="SMTP Host">
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" disabled={envManaged} className={lockCls} />
            </Field>
          </div>
          <Field label="Port">
            <Input value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} placeholder="587" disabled={envManaged} className={lockCls} />
          </Field>
        </div>

        <label className={cn('flex items-start gap-3', envManaged ? 'cursor-not-allowed' : 'cursor-pointer')}>
          <input type="checkbox" className="h-4 w-4 mt-0.5 accent-netbird" checked={secure} disabled={envManaged} onChange={(e) => setSecure(e.target.checked)} />
          <span className="text-sm">
            <span className="font-medium text-nb-gray-800 dark:text-nb-gray-100">Use implicit TLS (port 465)</span>
            <span className="block text-nb-gray-500 text-[0.8rem]">Leave off for STARTTLS on port 587 (the common case).</span>
          </span>
        </label>

        <Field label="Username" hint="Usually the full email address of the sending account. Leave blank for an unauthenticated relay.">
          <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="notifier@example.com" autoComplete="off" disabled={envManaged} className={lockCls} />
        </Field>

        <Field label="Password" hint={envManaged ? SMTP_ENV_HINT : data?.hasPass ? 'A password is configured. Leave blank to keep it, or enter a new one to replace it.' : 'The SMTP account password or app password.'}>
          <div className="relative">
            <Input type={showPass && !envManaged ? 'text' : 'password'} autoComplete="new-password" value={envManaged ? '' : pass} onChange={(e) => setPass(e.target.value)}
              placeholder={envManaged ? '•••••••••••• (from environment)' : data?.hasPass ? '•••••••••••• (configured)' : 'app password…'}
              disabled={envManaged} className={cn(pass && !envManaged && 'pr-10', lockCls)} />
            {pass && !envManaged && (
              <button type="button" onClick={() => setShowPass((s) => !s)} title={showPass ? 'Hide' : 'Show'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-nb-gray-400 hover:text-nb-gray-700 dark:hover:text-nb-gray-100">
                {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            )}
          </div>
        </Field>

        <Field label="From Address" hint="The sender shown to recipients. Defaults to the username. e.g. NetBird Control <notifier@example.com>">
          <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="NetBird Control <notifier@example.com>" disabled={envManaged} className={lockCls} />
        </Field>

        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="h-4 w-4 mt-0.5 accent-netbird" checked={complianceEmail} onChange={(e) => setComplianceEmail(e.target.checked)} />
          <span className="text-sm">
            <span className="font-medium text-nb-gray-800 dark:text-nb-gray-100">Email owners when a device is blocked by compliance</span>
            <span className="block text-nb-gray-500 text-[0.8rem]">Sent only when a login happens right now (a new login or a new device enrolling) and gets blocked - never for devices that were already blocked. Includes the reason and a Request Access link.</span>
          </span>
        </label>

        <div className="rounded-md border border-dashed border-nb-gray-200 dark:border-nb-gray-800 px-3.5 py-3 flex flex-col gap-2">
          <Field label="Send a Test Email" hint="Leave blank to send it to your own address.">
            <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
          </Field>
          <div>
            <Button variant="secondary" onClick={onTest} disabled={test.isPending || save.isPending || !host.trim()}>
              <Send size={14} /> {test.isPending ? 'Sending…' : 'Send test'}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {!envManaged && <Button variant="primary" onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>}
          {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
          {testMsg && <span className="text-sm text-nb-gray-600 dark:text-nb-gray-300">{testMsg}</span>}
          {error && <span className="text-sm text-red-500">{error}</span>}
          <span className="inline-flex items-center gap-1.5 text-sm text-nb-gray-500">
            <span className={cn('h-2 w-2 rounded-full', data?.enabled && data?.host ? 'bg-green-500' : 'bg-nb-gray-400 dark:bg-nb-gray-600')} />
            {data?.enabled && data?.host ? 'Configured' : 'Not configured'}
          </span>
        </div>
      </div>
    </div>
  );
}
