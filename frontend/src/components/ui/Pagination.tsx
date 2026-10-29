import { ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight } from 'lucide-react';
import { IconButton } from './Button';

interface Props {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
  total?: number;
  /** The server stopped counting at its cap - render the total as "50,000+" instead of an exact number. */
  totalCapped?: boolean;
  label?: string;
}

export function Pagination({ page, totalPages, onPage, total, totalCapped, label = 'items' }: Props) {
  const tp = Math.max(1, totalPages || 1);
  return (
    <div className="flex items-center justify-between gap-4 mt-4 text-sm text-nb-gray-500 dark:text-nb-gray-400">
      <div>{total != null ? `${total.toLocaleString()}${totalCapped ? '+' : ''} ${label}` : ''}</div>
      <div className="flex items-center gap-1.5">
        <IconButton disabled={page <= 1} onClick={() => onPage(1)} title="First"><ChevronsLeft size={16} /></IconButton>
        <IconButton disabled={page <= 1} onClick={() => onPage(page - 1)} title="Previous"><ChevronLeft size={16} /></IconButton>
        <span className="px-2 tabular-nums">Page {page} of {tp}</span>
        <IconButton disabled={page >= tp} onClick={() => onPage(page + 1)} title="Next"><ChevronRight size={16} /></IconButton>
        <IconButton disabled={page >= tp} onClick={() => onPage(tp)} title="Last"><ChevronsRight size={16} /></IconButton>
      </div>
    </div>
  );
}
