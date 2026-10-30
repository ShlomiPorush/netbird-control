import { useState } from 'react';
import { Mail, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button, IconButton } from '@/components/ui';
import { useResendInvite } from '@/lib/mutations';

// "Resend Invitation" - the dashboard's UserResendInviteButton. Only rendered while a user
// is still in the Invited state (the caller decides). Resending is harmless, so there is no
// confirmation: a green check flashes on success, the control turns red on failure.
// Shared by the Users table (icon row action) and the user detail header (labelled button).
export function ResendInviteButton({ userId, email, variant = 'icon', className }: {
  userId: string;
  /** Shown in the tooltip so the admin sees WHO gets the e-mail. */
  email?: string;
  variant?: 'icon' | 'button';
  className?: string;
}) {
  const resend = useResendInvite();
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState('');

  const click = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setFailed('');
    try {
      await resend.mutateAsync(userId);
      setDone(true); setTimeout(() => setDone(false), 2000);
    } catch (err) {
      setFailed((err as Error).message || 'Failed to resend the invitation.');
      setTimeout(() => setFailed(''), 4000);
    }
  };

  const title = failed || (done ? 'Invitation sent' : `Resend the invitation to ${email || 'this user'}`);
  const icon = done
    ? <Check size={15} className="text-green-500" />
    : <Mail size={15} className={cn(resend.isPending && 'animate-pulse')} />;

  if (variant === 'button') {
    return (
      <Button variant="secondary" size="sm" onClick={click} disabled={resend.isPending} title={title}
        className={cn(failed && 'border-red-500/50 text-red-500!', className)}>
        {icon} {done ? 'Invitation Sent' : resend.isPending ? 'Sending…' : 'Resend Invitation'}
      </Button>
    );
  }

  return (
    <IconButton onClick={click} disabled={resend.isPending} title={title} aria-label="Resend Invitation"
      className={cn(failed && 'border-red-500/50 text-red-500', className)}>
      {icon}
    </IconButton>
  );
}
