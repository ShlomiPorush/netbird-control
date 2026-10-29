import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Branded loading panel for the log tables (Traffic Events, Audit Log, Admin Events,
 * IP History, Outbound Messages, Proxy Access Logs).
 *
 * Two pieces make it up:
 *  - a small "network constellation" SVG: 7 nodes wired together, each one pulsing on its own
 *    beat, with two packets orbiting the closed path between them (SMIL animateMotion, which
 *    every current browser supports - no offset-path fallback needed);
 *  - a SIMULATED percentage. The browser cannot know how far along a query is, so the counter
 *    sprints to ~60% and then eases asymptotically toward 99% and waits there. `done` snaps it
 *    to 100%; see useSettledDelay for how that stays on screen long enough to be seen.
 *
 * Everything is hand-rolled CSS/SVG - no animation dependency.
 */

/** The closed loop a packet travels: 6 of the 7 nodes, back to the start (so the loop is seamless). */
const TRAIL = 'M22 88 L58 38 L110 30 L150 70 L176 106 L96 96 Z';

/** Decorative edges - drawn, but not part of the packet route. */
const EDGES = ['M58 38 L96 96', 'M150 70 L188 34', 'M96 96 L150 70'];

/** [x, y, pulse delay in seconds] - laid out asymmetrically on purpose. */
const NODES: [number, number, number][] = [
  [22, 88, 0], [58, 38, 0.42], [110, 30, 0.84], [150, 70, 1.26],
  [176, 106, 1.68], [96, 96, 2.1], [188, 34, 0.63],
];

/** Which nodes carry the netbird accent; the rest stay muted. */
const ACCENT = new Set([1, 3, 6]);

const CSS = `
@keyframes nbll-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.22); } }
@keyframes nbll-halo  { 0% { transform: scale(0.5); opacity: 0.5; } 65%, 100% { transform: scale(2.2); opacity: 0; } }
@keyframes nbll-dash  { to { stroke-dashoffset: -32; } }
@keyframes nbll-fade  { from { opacity: 0; } to { opacity: 1; } }
.nbll-node, .nbll-halo { transform-box: fill-box; transform-origin: center; }
.nbll-node { animation: nbll-pulse 2.6s ease-in-out infinite; }
.nbll-halo { animation: nbll-halo 2.6s ease-out infinite; }
.nbll-dash { stroke-dasharray: 5 27; animation: nbll-dash 1.9s linear infinite; }
.nbll-in   { animation: nbll-fade 220ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .nbll-node, .nbll-halo, .nbll-dash, .nbll-in { animation: none; }
  .nbll-halo { opacity: 0; }
}
`;

function Constellation() {
  return (
    <svg viewBox="0 0 210 132" width="210" height="132" role="presentation" aria-hidden="true" className="overflow-visible">
      <style>{CSS}</style>

      {/* Wiring: the packet route plus a few decorative edges, muted in both themes. */}
      <g fill="none" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round"
        className="stroke-nb-gray-300 dark:stroke-nb-gray-700">
        <path d={TRAIL} />
        {EDGES.map((d) => <path key={d} d={d} />)}
      </g>
      {/* A faint accent shimmer crawling along the decorative edges. */}
      <g fill="none" strokeWidth={1.5} strokeLinecap="round" className="stroke-netbird opacity-50">
        {EDGES.map((d) => <path key={d} d={d} className="nbll-dash" />)}
      </g>

      {/* Nodes: a soft expanding halo behind a gently breathing core. */}
      {NODES.map(([x, y, delay], i) => {
        const accent = ACCENT.has(i);
        return (
          <g key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
            <circle r={5} cx={0} cy={0} fill="none" strokeWidth={1.5}
              className={cn('nbll-halo', accent ? 'stroke-netbird' : 'stroke-nb-gray-400 dark:stroke-nb-gray-600')}
              style={{ animationDelay: `${delay}s` }} />
            <circle r={4.5} cx={0} cy={0} strokeWidth={1.5}
              className={cn('nbll-node',
                accent
                  ? 'fill-netbird-100 stroke-netbird dark:fill-netbird-950'
                  : 'fill-white stroke-nb-gray-300 dark:fill-nb-gray-930 dark:stroke-nb-gray-700')}
              style={{ animationDelay: `${delay}s` }} />
          </g>
        );
      })}

      {/* Two packets circling the loop. The second starts half a lap in (negative begin), so the
          motion reads as continuous traffic rather than a single dot. */}
      {[0, -2.15].map((begin) => (
        <g key={begin}>
          <circle r={7} className="fill-netbird opacity-20">
            <animateMotion path={TRAIL} dur="4.3s" begin={`${begin}s`} repeatCount="indefinite" />
          </circle>
          <circle r={3.25} className="fill-netbird">
            <animateMotion path={TRAIL} dur="4.3s" begin={`${begin}s`} repeatCount="indefinite" />
          </circle>
        </g>
      ))}
    </svg>
  );
}

/**
 * Keeps a loader on screen for a beat after the query settles, so the "100%" snap is actually
 * visible instead of being unmounted the same frame the data lands.
 *
 *   const { visible, done } = useSettledDelay(isLoading);
 *   if (visible) return <LogLoader done={done} label="Loading Events…" />;
 */
export function useSettledDelay(isLoading: boolean, ms = 250): { visible: boolean; done: boolean } {
  const [visible, setVisible] = useState(isLoading);
  useEffect(() => {
    if (isLoading) { setVisible(true); return; }
    if (!visible) return;
    const t = setTimeout(() => setVisible(false), ms);
    return () => clearTimeout(t);
  }, [isLoading, visible, ms]);
  return { visible, done: !isLoading };
}

export function LogLoader({ label = 'Loading Events…', done = false, className }: {
  label?: string;
  /** True once the query settled - snaps the counter to 100%. */
  done?: boolean;
  className?: string;
}) {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (done) { setPct(100); return; }
    // A fresh load starting inside the settle window rewinds the counter instead of parking on 99.
    setPct((p) => (p >= 99 ? 0 : p));
    // Fast off the line (~60% inside 350ms), then an ever-smaller step so it creeps toward 99%
    // and parks there. It can never overshoot, and it never stalls on an odd-looking number.
    const id = setInterval(() => setPct((p) => Math.min(99, p + Math.max((99 - p) * 0.11, 0.06))), 40);
    return () => clearInterval(id);
  }, [done]);

  return (
    <div className={cn('nbll-in flex min-h-[260px] flex-col items-center justify-center gap-1 py-8', className)}
      role="status" aria-live="polite" aria-busy={!done}>
      <Constellation />
      <div className="mt-3 font-mono text-2xl font-medium tabular-nums text-nb-gray-800 dark:text-nb-gray-100">
        {Math.floor(pct)}%
      </div>
      <p className="text-sm text-nb-gray-500 dark:text-nb-gray-400">{label}</p>
    </div>
  );
}
