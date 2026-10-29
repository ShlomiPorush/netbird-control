import { useMemo, useState } from 'react';
import { RotateCcw, CheckCircle2, ShieldOff, AlertTriangle, FileClock, ChevronRight } from 'lucide-react';
import { useRecertification, useRecertRounds, useRecertRound } from '@/lib/queries';
import { useStartRecert, useDecideRecertItem, useCancelRecert } from '@/lib/mutations';
import { useConfirm } from '@/contexts/ConfirmContext';
import { formatMaybeDate } from '@/lib/logfmt';
import { ucLabel } from '@/lib/str';
import type { RecertItem } from '@/lib/types';
import { Badge, Button, EmptyState, LoadingState, Modal, Spinner } from '@/components/ui';

// Section order on the page - security-heavy kinds first.
const KIND_ORDER = ['bypass', 'perm_user', 'perm_group', 'auto_trusted', 'auto_rule', 'recurring'];

// What "Revoke" actually does per kind, spelled out in the confirm dialog.
const REVOKE_EFFECT: Record<string, string> = {
  bypass: 'The compliance bypass is removed - the device is blocked until it passes the checks.',
  perm_user: 'The user loses this feature permission immediately.',
  perm_group: 'The group loses this feature permission immediately.',
  auto_trusted: 'Requests from these groups go back to human review.',
  auto_rule: 'This target stops being self-service - requests for it go to human review.',
  recurring: 'The recurring rule is disabled (an active window is torn down immediately).',
};

export default function AccessReview() {
  const { data, isLoading } = useRecertification();
  const start = useStartRecert();
  const cancel = useCancelRecert();
  const decide = useDecideRecertItem();
  const confirm = useConfirm();
  const [error, setError] = useState('');

  const grouped = useMemo(() => {
    const items = data?.open?.items || [];
    const g = new Map<string, RecertItem[]>();
    for (const k of KIND_ORDER) g.set(k, []);
    for (const it of items) {
      if (!g.has(it.kind)) g.set(it.kind, []);
      g.get(it.kind)!.push(it);
    }
    return [...g.entries()].filter(([, arr]) => arr.length);
  }, [data]);

  const onDecide = async (it: RecertItem, decision: 'keep' | 'revoke') => {
    setError('');
    if (decision === 'revoke') {
      const ok = await confirm({
        title: 'Revoke Standing Access',
        message: `Revoke "${it.label}"? ${REVOKE_EFFECT[it.kind] || ''}`,
        confirmText: 'Revoke',
      });
      if (!ok) return;
    }
    try { await decide.mutateAsync({ id: it.id, decision }); }
    catch (e) { setError((e as Error).message); }
  };

  const onStart = async () => {
    setError('');
    try { await start.mutateAsync(); }
    catch (e) { setError((e as Error).message); }
  };

  // Cancel discards the round (any decisions already made stay applied - a revoke
  // already removed the access); a fresh round can be started immediately after.
  const onCancel = async () => {
    setError('');
    const ok = await confirm({
      title: 'Cancel Review Round',
      message: 'Discard this round and its remaining items? Decisions already made stay in effect (revokes are not undone). You can start a fresh round right away.',
      confirmText: 'Cancel Round',
    });
    if (!ok) return;
    try { await cancel.mutateAsync(); }
    catch (e) { setError((e as Error).message); }
  };

  if (isLoading || !data) return <div><LoadingState /></div>;

  const open = data.open;
  const total = open?.items.length || 0;
  const decided = open ? open.items.filter((i) => i.status !== 'pending').length : 0;
  const overdue = open ? new Date(open.dueAt).getTime() < Date.now() : false;

  return (
    <div>
      <p className="text-nb-gray-500 text-sm mb-5">
        Every standing piece of access - unlimited bypasses, feature permissions, auto-approval rules and
        recurring access - must be explicitly kept or revoked, on a schedule.
      </p>

      {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

      {!open ? (
        <div className="max-w-2xl flex flex-col gap-4">
          <EmptyState
            title="No Review Round Open"
            hint={data.enabled
              ? `The next round opens automatically every ${data.intervalDays} days. You can also start one now.`
              : 'Scheduled reviews are disabled (Settings › Security & Alerts) - you can still run one manually.'}
            icon={<RotateCcw size={22} />}
          />
          <div>
            <Button variant="primary" onClick={onStart} disabled={start.isPending}>
              <RotateCcw size={15} /> {start.isPending ? 'Opening…' : 'Start Review Now'}
            </Button>
          </div>
          <PastReviews />
        </div>
      ) : (
        <div className="max-w-3xl flex flex-col gap-5">
          {/* Round header: progress + due date */}
          <div className="rounded-lg border border-nb-gray-200 dark:border-nb-gray-800 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <span className="font-semibold text-nb-gray-900 dark:text-nb-gray-50">Round #{open.id}</span>
                <span className="text-nb-gray-500"> · opened {formatMaybeDate(open.startedAt)} · </span>
                <span className={overdue ? 'text-red-500 font-medium' : 'text-nb-gray-500'}>
                  due {formatMaybeDate(open.dueAt)}{overdue ? ' (overdue)' : ''}
                </span>
              </div>
              <span className="inline-flex items-center gap-3">
                <span className="text-sm font-medium text-nb-gray-700 dark:text-nb-gray-200">{decided}/{total} decided</span>
                <Button variant="secondary" size="sm" onClick={onCancel} disabled={cancel.isPending}
                  title="Discard this round (already-made decisions stay in effect) and allow starting a fresh one">
                  Cancel Round
                </Button>
              </span>
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-nb-gray-100 dark:bg-nb-gray-900 overflow-hidden">
              <div className="h-full bg-netbird transition-all" style={{ width: `${total ? Math.round((decided / total) * 100) : 0}%` }} />
            </div>
          </div>

          {grouped.map(([kind, items]) => (
            <div key={kind}>
              <h3 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50 mb-2">
                {items[0].kindLabel} <span className="text-nb-gray-400 font-normal">({items.length})</span>
              </h3>
              <div className="flex flex-col gap-2">
                {items.map((it) => (
                  <div key={it.id} className="flex flex-wrap items-start gap-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 px-3.5 py-2.5">
                    {it.kind === 'bypass'
                      ? <AlertTriangle size={15} className="shrink-0 text-amber-500 mt-0.5" />
                      : <RotateCcw size={15} className="shrink-0 text-nb-gray-400 mt-0.5" />}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 break-words">{it.label}</span>
                      {it.info && <span className="block mt-0.5 text-[0.78rem] leading-relaxed text-nb-gray-500 break-words">{it.info}</span>}
                    </span>
                    {it.status === 'pending' ? (
                      <span className="inline-flex items-center gap-1.5 shrink-0">
                        <Button variant="secondary" size="sm" onClick={() => onDecide(it, 'keep')} disabled={decide.isPending}>
                          <CheckCircle2 size={14} /> Keep
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => onDecide(it, 'revoke')} disabled={decide.isPending}
                          className="hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10">
                          <ShieldOff size={14} /> Revoke
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2 shrink-0">
                        <Badge tone={it.status === 'kept' ? 'green' : 'red'}>{ucLabel(it.status)}</Badge>
                        <span className="text-[0.74rem] text-nb-gray-500">by {it.decidedBy}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <PastReviews />
        </div>
      )}
    </div>
  );
}

// ─── Completed-rounds history - click a round to open its full who-decided-what report ───
function PastReviews() {
  const { data: rounds } = useRecertRounds();
  const [openId, setOpenId] = useState<number | null>(null);
  if (!rounds?.length) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50 mb-2 inline-flex items-center gap-2">
        <FileClock size={15} className="text-nb-gray-400" /> Past Reviews
      </h3>
      <div className="flex flex-col gap-2">
        {rounds.map((r) => (
          <button key={r.id} onClick={() => setOpenId(r.id)}
            className="flex items-center justify-between gap-3 rounded-md border border-nb-gray-200 dark:border-nb-gray-800 bg-white dark:bg-nb-gray-950 px-3.5 py-2.5 text-left hover:bg-nb-gray-50 dark:hover:bg-nb-gray-900/40 transition-colors">
            <span className="min-w-0 text-sm">
              <span className="font-medium text-nb-gray-800 dark:text-nb-gray-100">Round #{r.id}</span>
              <span className="text-nb-gray-500"> · completed {formatMaybeDate(r.completedAt)}</span>
            </span>
            <span className="shrink-0 inline-flex items-center gap-2">
              <Badge tone="green">{r.kept} Kept</Badge>
              {r.revoked > 0 ? <Badge tone="red">{r.revoked} Revoked</Badge> : <Badge tone="gray">0 Revoked</Badge>}
              <ChevronRight size={15} className="text-nb-gray-400" />
            </span>
          </button>
        ))}
      </div>
      {openId != null && <RoundReportModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// The full report of one completed round: every item, its context, the decision,
// who made it and when - the evidence trail an audit asks for.
function RoundReportModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading } = useRecertRound(id);
  const grouped = useMemo(() => {
    const items = data?.items || [];
    const g = new Map<string, RecertItem[]>();
    for (const k of KIND_ORDER) g.set(k, []);
    for (const it of items) {
      if (!g.has(it.kind)) g.set(it.kind, []);
      g.get(it.kind)!.push(it);
    }
    return [...g.entries()].filter(([, arr]) => arr.length);
  }, [data]);

  return (
    <Modal open onClose={onClose} size="lg" icon={<FileClock size={18} />}
      title={`Review Round #${id}`}
      subtitle={data ? `Opened ${formatMaybeDate(data.startedAt)}${data.completedAt ? ` · completed ${formatMaybeDate(data.completedAt)}` : ''}` : undefined}
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      {isLoading || !data ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map(([kind, items]) => (
            <div key={kind}>
              <h4 className="text-sm font-semibold text-nb-gray-900 dark:text-nb-gray-50 mb-2">
                {items[0].kindLabel} <span className="text-nb-gray-400 font-normal">({items.length})</span>
              </h4>
              <div className="flex flex-col gap-2">
                {items.map((it) => (
                  <div key={it.id} className="flex flex-wrap items-start gap-3 rounded-md border border-nb-gray-100 dark:border-nb-gray-900 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-nb-gray-800 dark:text-nb-gray-100 break-words">{it.label}</span>
                      {it.info && <span className="block mt-0.5 text-[0.76rem] leading-relaxed text-nb-gray-500 break-words">{it.info}</span>}
                    </span>
                    <span className="shrink-0 text-right">
                      <Badge tone={it.status === 'kept' ? 'green' : it.status === 'revoked' ? 'red' : 'gray'}>{ucLabel(it.status)}</Badge>
                      {it.decidedBy && (
                        <span className="block mt-0.5 text-[0.72rem] text-nb-gray-500">
                          by {it.decidedBy}{it.decidedAt ? ` · ${formatMaybeDate(it.decidedAt)}` : ''}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
