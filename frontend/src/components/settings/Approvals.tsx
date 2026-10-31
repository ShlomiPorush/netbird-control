import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useApproverConfig, useAdGroups, useUsers } from '@/lib/queries';
import { useSaveApproverConfig } from '@/lib/mutations';
import type { ApproverDelegate, TelegramApprover } from '@/lib/types';
import { Badge, Button, LoadingState, Input, SelectMenu, Field, IconButton, GroupMultiSelect } from '@/components/ui';

export function Approvals() {
  const { data, isLoading } = useApproverConfig();
  const save = useSaveApproverConfig();
  const users = useUsers().data || [];
  const userOpts = useMemo(
    () => users.filter((u) => !u.is_service_user).map((u) => ({ id: u.id, name: u.name || u.email || u.id, email: u.email || '' })),
    [users],
  );
  const { data: adGroups } = useAdGroups();
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [tgChat, setTgChat] = useState('');
  // Each row maps a Telegram user id to a system user, so we can attribute a Telegram approval.
  const [approvers, setApprovers] = useState<{ telegramId: string; userId: string }[]>([]);
  // Time-boxed delegation rows: user + inclusive date window. A loaded row also keeps its stored user.
  const [delegates, setDelegates] = useState<{ userId: string; from: string; until: string; user?: ApproverDelegate['user'] }[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (data) {
      setGroupIds(data.groupIds || []);
      setTgChat(data.telegramChatId || '');
      setApprovers((data.telegramApprovers || []).map((a) => ({ telegramId: a.telegramId, userId: a.userId })));
      setDelegates((data.delegates || []).map((d) => ({ userId: d.user.id, from: d.from, until: d.until, user: d.user })));
    }
  }, [data]);

  const setRow = (i: number, patch: Partial<{ telegramId: string; userId: string }>) =>
    setApprovers((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setApprovers((p) => [...p, { telegramId: '', userId: '' }]);
  const removeRow = (i: number) => setApprovers((p) => p.filter((_, idx) => idx !== i));

  const setDeleg = (i: number, patch: Partial<{ userId: string; from: string; until: string }>) =>
    setDelegates((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addDeleg = () => setDelegates((p) => [...p, { userId: '', from: '', until: '' }]);
  const removeDeleg = (i: number) => setDelegates((p) => p.filter((_, idx) => idx !== i));
  // The user a row stands for. A row whose user was not changed keeps its stored identity as is (it
  // may hold only an email, or a user missing from the list), so saving never drops or alters it.
  const delegUser = (d: (typeof delegates)[number]): ApproverDelegate['user'] | null => {
    if (d.user && (d.userId ? d.user.id === d.userId : !d.user.id && !!d.user.email)) return d.user;
    if (!d.userId) return null;
    const u = userOpts.find((x) => x.id === d.userId);
    return { id: d.userId, email: u?.email || '', name: u?.name || '' };
  };
  const todayKey = new Date().toISOString().slice(0, 10);
  const delegActive = (d: { from: string; until: string }) => !!d.from && !!d.until && d.from <= todayKey && todayKey <= d.until;

  const onSave = async () => {
    setError('');
    const telegramApprovers: TelegramApprover[] = approvers
      .filter((a) => a.telegramId.trim() && a.userId)
      .map((a) => {
        const u = userOpts.find((x) => x.id === a.userId);
        return { telegramId: a.telegramId.trim(), userId: a.userId, name: u?.name || '', email: u?.email || '' };
      });
    const bad = delegates.find((d) => delegUser(d) && d.from && d.until && d.from > d.until);
    if (bad) { setError('A delegation ends before it starts - fix the dates.'); return; }
    const delegatesPayload = delegates
      .filter((d) => delegUser(d) && d.from && d.until && d.from <= d.until)
      .map((d) => ({ user: delegUser(d)!, from: d.from, until: d.until }));
    try {
      await save.mutateAsync({ groupIds, telegramChatId: tgChat.trim(), telegramApprovers, delegates: delegatesPayload });
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError((e as Error).message || 'Failed to save'); }
  };

  if (isLoading) return <LoadingState />;
  return (
    <div className="max-w-2xl">
      <p className="text-nb-gray-500 text-sm mb-5">
        Decide who can approve or deny <b>access requests</b> - without granting them full admin. Approvers see the
        <b> Access Requests</b> page and can act on the Telegram buttons.
      </p>

      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">In-App Approvers (Entra Group)</div>
          <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3">
            Members of these Entra (Azure AD) groups can approve/deny requests in the app - no admin rights needed.
          </p>
          <Field label="Approver Groups" hint="Members of these groups can approve/deny requests. Requires the app's Microsoft Graph group-read permission (see docs/permissions).">
            <GroupMultiSelect groups={adGroups || []} value={groupIds} onChange={setGroupIds} placeholder="Select groups…" />
          </Field>
        </div>

        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Telegram Approvals</div>
          <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3">
            Post Approve/Deny buttons to Telegram. Only the mapped Telegram users below may act on them, and each approval
            is attributed to the system user you map it to. The bot receives presses via a webhook (registered when
            Telegram is enabled with a public BASE_URL).
          </p>
          <Field label="Approvals Group Chat ID (Optional)" hint="Post buttons to a SEPARATE group (keep them out of the logs group). Empty = the main group's “Access requests” topic. Add the bot to this group too.">
            <Input value={tgChat} onChange={(e) => setTgChat(e.target.value)} placeholder="e.g. -1002233445566" />
          </Field>
          <div className="mt-3" />
          <Field label="Approver Telegram Users" hint="Map each approver's Telegram user ID (get it from @userinfobot) to their user in the system. Approvals are logged under the system user. No rows = nobody can approve from Telegram.">
            <div className="flex flex-col gap-2">
              {approvers.length > 0 && (
                <div className="hidden sm:flex items-center gap-2 px-0.5 text-[0.7rem] uppercase tracking-wide text-nb-gray-400">
                  <span className="flex-1">System User</span>
                  <span className="w-48">Telegram User ID</span>
                  <span className="w-8" />
                </div>
              )}
              {approvers.map((a, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <SelectMenu value={a.userId} onChange={(v) => setRow(i, { userId: v })}
                      placeholder="Select user…" searchPlaceholder="Search users…"
                      options={userOpts.map((u) => ({ value: u.id, label: u.name, subtitle: u.email || undefined }))} />
                  </div>
                  <Input value={a.telegramId} onChange={(e) => setRow(i, { telegramId: e.target.value })} placeholder="123456789" className="w-48 font-mono text-[0.82rem]" />
                  <IconButton onClick={() => removeRow(i)} title="Remove" className="shrink-0 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><X size={15} /></IconButton>
                </div>
              ))}
              <div><Button variant="secondary" size="sm" onClick={addRow}><Plus size={14} /> Add Approver</Button></div>
            </div>
          </Field>
          <div className="mt-2 text-[0.78rem] text-nb-gray-500">
            Webhook: {data?.webhookConfigured ? <span className="text-green-600 dark:text-green-500">registered</span> : <span className="text-nb-gray-400">not registered - enable Telegram (Telegram tab) and Save; requires a public BASE_URL.</span>}
          </div>
        </div>

        <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
          <div className="text-sm font-semibold text-nb-gray-800 dark:text-nb-gray-100">Approval Delegation</div>
          <p className="text-nb-gray-500 text-[0.82rem] mt-0.5 mb-3">
            Cover an approver's absence: give a user <b>time-boxed</b> approval rights (in-app - the Access Requests
            page and its actions). Active from the start date through the end date (inclusive), then expires by itself.
            Delegations appear in the weekly review digest while active.
          </p>
          <div className="flex flex-col gap-2">
            {delegates.length > 0 && (
              <div className="hidden sm:flex items-center gap-2 px-0.5 text-[0.7rem] uppercase tracking-wide text-nb-gray-400">
                <span className="flex-1">Delegate</span>
                <span className="w-36">From</span>
                <span className="w-36">Until</span>
                <span className="w-20" />
              </div>
            )}
            {delegates.map((d, i) => (
              <div key={i} className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                <div className="flex-1 min-w-[180px]">
                  <SelectMenu value={d.userId} onChange={(v) => setDeleg(i, { userId: v })}
                    placeholder="Select user…" searchPlaceholder="Search users…"
                    options={userOpts.map((u) => ({ value: u.id, label: u.name, subtitle: u.email || undefined }))} />
                </div>
                <Input type="date" value={d.from} onChange={(e) => setDeleg(i, { from: e.target.value })} className="w-36" />
                <Input type="date" value={d.until} onChange={(e) => setDeleg(i, { until: e.target.value })} className="w-36" />
                <span className="w-20 inline-flex items-center gap-1.5">
                  {delegActive(d) && <Badge tone="green">Active</Badge>}
                  <IconButton onClick={() => removeDeleg(i)} title="Remove" className="shrink-0 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10"><X size={15} /></IconButton>
                </span>
              </div>
            ))}
            <div><Button variant="secondary" size="sm" onClick={addDeleg}><Plus size={14} /> Add Delegation</Button></div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={onSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          {saved && <span className="text-sm text-green-600 dark:text-green-500">Saved</span>}
          {error && <span className="text-sm text-red-500">{error}</span>}
        </div>

        <p className="text-[0.82rem] text-nb-gray-500">
          Rules for <b>auto-approving</b> requests (trusted groups, self-service resources) live on the <b>Access Requests</b> page, under the <b>Auto-Approval</b> tab.
        </p>
      </div>
    </div>
  );
}
