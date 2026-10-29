import { FilterX } from 'lucide-react';
import { Button } from './Button';

/**
 * Toolbar "Clear" button that resets a page's search box + filters in one click.
 * Renders nothing while no search/filter is active, so it only appears when useful.
 */
export function ClearFiltersButton({ active, onClear, className }: { active: boolean; onClear: () => void; className?: string }) {
  if (!active) return null;
  return (
    <Button variant="secondary" onClick={onClear} title="Clear search & filters" className={className}>
      <FilterX size={15} /> Clear
    </Button>
  );
}
