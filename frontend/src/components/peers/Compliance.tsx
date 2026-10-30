import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatMaybeDate } from '@/lib/logfmt';
import { HoverCard } from '@/components/ui';

// Only the fields compliance depends on - so both the list `Peer` and the `PeerDetail`
// type satisfy it structurally.
interface ComplianceFields {
  force_approved?: boolean;
  bypass_expires_at?: string | null;
  bypass_temp_device?: boolean;
  login_expired?: boolean;
  approval_required?: boolean;
  disapproval_reason?: string;
}

export interface Compliance { tone: 'amber' | 'red'; message: string; reason?: string; expiresAt?: string; tempDevice?: boolean }

// Compliance state of a peer, in NetBird's priority order: an admin bypass (amber) wins over
// an expired login (red) which wins over a pending/non-compliant approval (red). The
// disapproval reason is attached to EVERY state that has one - a non-compliant device is
// usually also offline/login-expired, and that message must not hide WHY it's blocked.
export function complianceInfo(p: ComplianceFields): Compliance | null {
  const reason = (p.approval_required && p.disapproval_reason) || undefined;
  if (p.force_approved) return { tone: 'amber', message: 'This peer has compliance bypassed by an administrator. The bypass will be automatically removed when the device becomes compliant.', reason: p.disapproval_reason || undefined, expiresAt: p.bypass_expires_at || undefined, tempDevice: !!p.bypass_temp_device };
  if (p.login_expired) {
    return p.approval_required
      ? { tone: 'red', message: 'This peer is not compliant and cannot connect until compliance is restored or bypassed (its login has also expired).', reason }
      : { tone: 'red', message: 'This peer’s login has expired. Re-authenticate from the NetBird client on the device to bring it back online.' };
  }
  if (p.approval_required) return { tone: 'red', message: 'This peer is not compliant and cannot connect until compliance is restored or bypassed.', reason };
  return null;
}

// Boxed "Reason: <code>" line - its own bordered sub-section, like NetBird's tooltip.
function ReasonBox({ reason }: { reason: string }) {
  return (
    <div className="mt-2.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-700 bg-nb-gray-50 dark:bg-nb-gray-900/60 px-2.5 py-1.5 text-[0.78rem]">
      <span className="text-nb-gray-500 dark:text-nb-gray-400">Reason: </span>
      <span className="font-mono font-medium text-nb-gray-800 dark:text-nb-gray-100">{reason}</span>
    </div>
  );
}

// Warning triangle for peer lists, with the styled hover tooltip (NetBird-faithful). The
// tooltip is rendered in a fixed-position PORTAL (via HoverCard) so the table's
// `overflow-x-auto` wrapper can't clip it - which pushed the old absolute card under the row.
export function ComplianceIcon({ peer }: { peer: ComplianceFields }) {
  const c = complianceInfo(peer);
  if (!c) return null;
  return (
    <HoverCard
      width={300}
      className="text-left normal-case font-normal"
      trigger={<AlertTriangle size={16} className={cn('shrink-0 align-middle', c.tone === 'amber' ? 'text-amber-500' : 'text-red-500')} />}
    >
      <p className="text-[0.82rem] leading-relaxed text-nb-gray-700 dark:text-nb-gray-200">{c.message}</p>
      {c.expiresAt && (
        <p className="mt-1.5 text-[0.78rem] text-amber-600 dark:text-amber-400">
          {c.tempDevice ? 'Temporary device - deleted automatically on ' : 'Bypass expires: '}{formatMaybeDate(c.expiresAt)}
        </p>
      )}
      {c.reason && <ReasonBox reason={c.reason} />}
    </HoverCard>
  );
}

// A visible alert banner (peer detail page) - same wording + boxed reason, tinted by tone.
export function ComplianceBanner({ info, className }: { info: Compliance; className?: string }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border p-3.5',
      info.tone === 'amber' ? 'border-amber-500/30 bg-amber-500/6' : 'border-red-500/30 bg-red-500/6', className)}>
      <AlertTriangle size={18} className={cn('mt-0.5 shrink-0', info.tone === 'amber' ? 'text-amber-500' : 'text-red-500')} />
      <div className="min-w-0">
        <p className="text-sm leading-relaxed text-nb-gray-700 dark:text-nb-gray-200">{info.message}</p>
        {info.expiresAt && (
          <p className="mt-1 text-[0.82rem] text-amber-600 dark:text-amber-400">
            {info.tempDevice ? 'Temporary device - deleted automatically on ' : 'Bypass expires: '}{formatMaybeDate(info.expiresAt)}
          </p>
        )}
        {info.reason && (
          <div className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-md border border-nb-gray-200 dark:border-nb-gray-700 bg-white/70 dark:bg-nb-gray-900/60 px-2.5 py-1 text-[0.78rem]">
            <span className="text-nb-gray-500 dark:text-nb-gray-400">Reason:</span>
            <span className="font-mono font-medium text-nb-gray-800 dark:text-nb-gray-100 break-all">{info.reason}</span>
          </div>
        )}
      </div>
    </div>
  );
}
