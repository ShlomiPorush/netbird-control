import { Link2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Marks the network that holds the resources the Remote Access launch API creates (Settings > Remote Access). */
export function ManagedByApiBadge({ className }: { className?: string }) {
  return (
    <span title="The Remote Access API creates and removes resources in this network. You can read it here; its resources can't be changed."
      className={cn('inline-flex items-center gap-1 rounded-md border border-nb-blue-400/30 bg-nb-blue-400/10 px-1.5 py-0.5 text-[0.68rem] font-medium text-nb-blue-600 dark:text-nb-blue-400 whitespace-nowrap', className)}>
      <Link2 size={11} /> Managed By The Remote Access API
    </span>
  );
}
