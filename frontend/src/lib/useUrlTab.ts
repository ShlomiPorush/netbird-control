import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Deep-linkable page tabs (?tab=x), exactly like Settings: switching a tab updates the URL
 * (replace - Back doesn't walk through every tab visit), and opening a link with ?tab=
 * lands on that tab. Invalid/absent values fall back to the default.
 */
export function useUrlTab<T extends string>(valid: readonly T[], def: T): [T, (t: T) => void] {
  const [params, setParams] = useSearchParams();
  const ok = (v: string | null): v is T => !!v && (valid as readonly string[]).includes(v);
  const [tab, setTab] = useState<T>(() => (ok(params.get('tab')) ? (params.get('tab') as T) : def));
  // Follow external URL changes (⌘K navigation, Back/Forward).
  useEffect(() => {
    const t = params.get('tab');
    if (ok(t)) setTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const select = (t: T) => {
    setTab(t);
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  return [tab, select];
}
