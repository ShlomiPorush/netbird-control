import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  kbd?: boolean;
  className?: string;
}

/** NetBird-style search input: search icon left, optional ⌘K badge right. */
export function SearchInput({ value, onChange, placeholder = 'Search...', kbd = true, className }: Props) {
  return (
    <div className={cn('relative flex items-center h-[42px] w-full max-w-[360px]', className)}>
      <Search size={15} className="absolute left-3 text-nb-gray-500 dark:text-nb-gray-400 pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          'h-[42px] w-full rounded-md border text-sm outline-none transition-colors',
          'pl-10', kbd ? 'pr-16' : 'pr-3',
          'bg-white border-nb-gray-200 text-nb-gray-900 placeholder:text-nb-gray-500',
          'dark:bg-nb-gray-900 dark:border-nb-gray-700 dark:text-nb-gray-100 dark:placeholder:text-nb-gray-400/70',
          'focus:ring-2 focus:ring-netbird-400/30 focus:border-netbird/60',
        )}
      />
      {kbd && (
        <span className="absolute right-3 inline-flex items-center gap-0.5 rounded-[4px] border border-nb-gray-200 dark:border-nb-gray-700 bg-nb-gray-100 dark:bg-nb-gray-800 px-1.5 py-0.5 text-[0.7rem] text-nb-gray-500 dark:text-nb-gray-300 select-none pointer-events-none">
          ⌘ K
        </span>
      )}
    </div>
  );
}
