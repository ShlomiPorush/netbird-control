import { useEffect, useState } from 'react';
import { useIsFetching } from '@tanstack/react-query';

/**
 * Slim NProgress-style bar pinned to the very top of the window, above the sticky TopBar.
 *
 * It tracks ONLY the heavy log queries (the ones that can take a couple of seconds) - every
 * other query in the app is fast enough that a global bar would just flicker. Like NProgress
 * the motion is faked: it eases toward 90% while fetching and snaps to 100% on arrival, since
 * the browser has no way to know how far along a request actually is.
 *
 * Renders nothing while idle. Mounted once, in Layout.
 */

/** First segment of the query keys that get a progress bar (see lib/queries.ts). */
const LOG_KEYS = new Set([
  'logs',
  'logs-summary',
  'admin-logs',
  'audit',
  'ip-history',
  'outbound-log',
  'reverse-proxy-logs',
  'reverse-proxy-logs-summary',
]);

export function TopProgress() {
  const active = useIsFetching({ predicate: (q) => LOG_KEYS.has(String(q.queryKey[0])) }) > 0;
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (active) {
      setVisible(true);
      setFading(false);
      // Restart from a visible sliver unless a run is already in flight.
      setProgress((p) => (p > 0 && p < 90 ? p : 8));
      // Decreasing step: quick to ~50%, then a slow crawl that stops dead at 90%.
      const id = setInterval(() => setProgress((p) => (p >= 90 ? p : p + Math.max((90 - p) * 0.09, 0.35))), 180);
      return () => clearInterval(id);
    }
    if (!visible) return;
    // Arrived: fill the bar and fade it out, then unmount and reset.
    setProgress(100);
    setFading(true);
    const t = setTimeout(() => { setVisible(false); setFading(false); setProgress(0); }, 340);
    return () => clearTimeout(t);
  }, [active, visible]);

  if (!visible) return null;

  return (
    <div aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[2000] h-[3px]"
      style={{ opacity: fading ? 0 : 1, transition: 'opacity 260ms ease 60ms' }}>
      <div
        className="relative h-full bg-gradient-to-r from-netbird-600 via-netbird to-netbird-300"
        style={{
          width: `${progress}%`,
          transition: 'width 220ms cubic-bezier(0.22, 0.61, 0.36, 1)',
          boxShadow: '0 0 8px 1px rgba(246, 131, 48, 0.55), 0 1px 4px rgba(246, 131, 48, 0.4)',
        }}>
        {/* The "peg": a short bright, blurred tail trailing the leading edge. */}
        <div className="absolute right-0 top-0 h-full w-24 bg-gradient-to-r from-transparent to-netbird-300 opacity-80 blur-[2px]" />
      </div>
    </div>
  );
}
