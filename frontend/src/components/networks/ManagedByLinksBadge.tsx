import { Link2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Marks the network that holds the servers Remote Access launch links add (Settings > Remote Access). */
export function ManagedByLinksBadge({ className }: { className?: string }) {
  return (
    <span title="Remote Access links add and remove servers in this network. You can read it here; its resources can't be changed."
      className={cn('inline-flex items-center gap-1 rounded-md border border-nb-blue-400/30 bg-nb-blue-400/10 px-1.5 py-0.5 text-[0.68rem] font-medium text-nb-blue-600 dark:text-nb-blue-400 whitespace-nowrap', className)}>
      <Link2 size={11} /> Managed By Remote Access Links
    </span>
  );
}
