import { FilterX } from 'lucide-react';
import { Button, IconButton } from './Button';

/**
 * Toolbar "Clear" button that resets a page's search box + filters in one click.
 * Renders nothing while no search/filter is active, so it only appears when useful.
 * `compact` shows the icon alone (with a tooltip), for a toolbar that must fit on one row.
 */
export function ClearFiltersButton({ active, onClear, className, compact = false }: { active: boolean; onClear: () => void; className?: string; compact?: boolean }) {
  if (!active) return null;
  if (compact) {
    return (
      <IconButton onClick={onClear} title="Clear search & filters" aria-label="Clear search & filters" className={`h-[42px] w-[42px] ${className || ''}`}>
        <FilterX size={15} />
      </IconButton>
    );
  }
  return (
    <Button variant="secondary" onClick={onClear} title="Clear search & filters" className={className}>
      <FilterX size={15} /> Clear
    </Button>
  );
}
