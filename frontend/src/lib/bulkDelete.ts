// The answer of a bulk delete carries only ids and errors: name the rows it couldn't delete.
// Erasable TypeScript only: backend/test reads this file with Node's type stripping.

export interface BulkDeleteFailure { id: string; error: string }

export function bulkDeleteMessage(sent: { id: string; name: string }[], failed: BulkDeleteFailure[]): string {
  if (!failed.length) return '';
  const name = (id: string) => sent.find((r) => r.id === id)?.name || id;
  return `${failed.length} resource${failed.length === 1 ? '' : 's'} couldn't be deleted: ${failed.map((f) => `${name(f.id)}: ${f.error}`).join('; ')}`;
}
