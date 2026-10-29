import { useMemo, useRef, useState } from 'react';

export type SortDir = 'asc' | 'desc';
export type Accessor<T> = (row: T) => unknown;
export interface SortState { sortKey: string | null; sortDir: SortDir; onSort: (k: string) => void }

function compare(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an && bn) return 0;
  if (an) return 1; // empties last
  if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? -1 : 1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Client-side column sorting for tables. `accessors` maps a column key to the value
 * to sort by. Returns the sorted rows and a `state` to pass to <SortTh>.
 */
export function useTableSort<T>(rows: T[], accessors: Record<string, Accessor<T>>, initial?: { key: string; dir?: SortDir }) {
  const [sortKey, setSortKey] = useState<string | null>(initial?.key ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(initial?.dir ?? 'asc');
  const accRef = useRef(accessors);
  accRef.current = accessors;

  const onSort = (k: string) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const acc = accRef.current[sortKey];
    if (!acc) return rows;
    return [...rows].sort((a, b) => {
      const c = compare(acc(a), acc(b));
      return sortDir === 'asc' ? c : -c;
    });
  }, [rows, sortKey, sortDir]);

  return { sorted, state: { sortKey, sortDir, onSort } as SortState };
}

// Server-side column sort (the tabs paginate on the server, so client-side sort would only
// reorder the visible page). Returns a <SortTh> state + the {sort,dir} query params. null =
// the endpoint's default order.
export function useServerSort() {
  const [sort, setSort] = useState<string | null>(null);
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const onSort = (k: string) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(k); setDir('asc'); }
  };
  const state: SortState = { sortKey: sort, sortDir: dir, onSort };
  return { sort, dir, state, params: { sort: sort || undefined, dir: sort ? dir : undefined } };
}
