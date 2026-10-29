import { useEffect, useMemo, useState } from 'react';

// Standard rows-per-page choices + label, shared by every client-paginated list page so the
// control looks identical everywhere (pair with <ToolbarMenu icon={<Rows3/>}> in the toolbar).
export const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100].map((n) => ({ value: String(n), label: `${n} rows per page` }));

// Client-side pagination for a fully-loaded, already-sorted+filtered list. Pass the current
// filter/sort values in `resetDeps` so paging jumps back to page 1 when they change.
export function useClientPagination<T>(rows: T[], defaultPerPage = 25, resetDeps: unknown[] = []) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(defaultPerPage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(1); }, [perPage, ...resetDeps]);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => rows.slice((safePage - 1) * perPage, safePage * perPage),
    [rows, safePage, perPage],
  );
  return { pageRows, page: safePage, setPage, perPage, setPerPage, totalPages, total };
}
