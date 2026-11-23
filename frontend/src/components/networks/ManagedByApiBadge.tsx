import { Link2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export function ManagedByApiBadge({ className }: { className?: string }) {
  return (
    <span title="Remote Access adds and removes servers in this network for launch links. Only admins can delete them."
      className={cn('inline-flex items-center gap-1 rounded-md border border-nb-blue-400/30 bg-nb-blue-400/10 px-1.5 py-0.5 text-[0.68rem] font-medium text-nb-blue-600 dark:text-nb-blue-400 whitespace-nowrap', className)}>
      <Link2 size={11} /> Managed By Remote Access
    </span>
  );
}
