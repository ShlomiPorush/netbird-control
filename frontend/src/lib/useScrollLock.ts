import { useEffect } from 'react';

// Locks page scrolling while any overlay (modal, command palette, mobile drawer) is open -
// WITHOUT touching overflow on the scroll root.
//
// Why not overflow:hidden? Our global CSS makes <html> the page scroller (html{overflow-x:
// hidden} stops body propagation, so a body-only lock silently does nothing). Hiding the
// ROOT's overflow breaks position:sticky in Chromium - the sticky TopBar/Sidebar un-stick
// and visibly "escape" through the translucent backdrop (restoring scrollTop does not help;
// the offset survives, the stickiness does not). position:fixed compensation breaks the
// same chrome. So the scroller is left completely untouched - instead, scroll INPUT is
// cancelled while locked:
//  - wheel / touchmove are blocked unless they target an inner scrollable that can still
//    move (modal bodies, dropdown lists keep scrolling; at their edges the event is blocked
//    so the scroll never chains out to the page)
//  - scroll keys are blocked only when typed on the page itself (body/html target), never
//    inside overlay inputs and controls
//  - a scroll listener snaps the offset back as a last resort (e.g. scrollbar dragging)
// Nothing is repositioned or reflowed - the page behind stays pixel-identical. Counted so
// stacked overlays (a confirm over a modal) keep the lock until the LAST one closes.
let _count = 0;
let _savedY = 0;
let _restoring = false;

// True when some ancestor of `target` (below the page scroller) is a real scroll container
// that can still move in the wheel's direction - that inner scroll is allowed.
function innerScrollAllowed(target: EventTarget | null, deltaY?: number): boolean {
    let el = target instanceof Element ? target : null;
    while (el && el !== document.documentElement && el !== document.body) {
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
            if (deltaY === undefined) return true; // touch - direction unknown, allow the inner scroller
            if (deltaY < 0 && el.scrollTop > 0) return true;
            if (deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
            // at this scroller's edge - keep walking; an outer inner-scroller may still take it
        }
        el = el.parentElement;
    }
    return false;
}

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown']);

function onWheel(e: WheelEvent) {
    if (!innerScrollAllowed(e.target, e.deltaY)) e.preventDefault();
}
function onTouchMove(e: TouchEvent) {
    if (!innerScrollAllowed(e.target)) e.preventDefault();
}
function onKeyDown(e: KeyboardEvent) {
    if (!SCROLL_KEYS.has(e.key)) return;
    const t = e.target;
    // Only keys that would scroll the PAGE (typed with no overlay control focused) are
    // blocked; inputs, lists and buttons inside overlays keep full keyboard behavior.
    if (t === document.body || t === document.documentElement) e.preventDefault();
}
function onScroll() {
    if (_restoring) return;
    _restoring = true;
    document.documentElement.scrollTop = _savedY;
    _restoring = false;
}

export function lockBodyScroll() {
    if (_count === 0) {
        _savedY = document.documentElement.scrollTop;
        window.addEventListener('wheel', onWheel, { capture: true, passive: false });
        window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
        window.addEventListener('keydown', onKeyDown, { capture: true });
        window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    }
    _count++;
}

export function unlockBodyScroll() {
    _count = Math.max(0, _count - 1);
    if (_count === 0) {
        window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
        window.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions);
        window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
        window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
    }
}

/** Declarative form - lock while `active` is true. Use this in every full-screen overlay. */
export function useScrollLock(active: boolean) {
    useEffect(() => {
        if (!active) return;
        lockBodyScroll();
        return () => unlockBodyScroll();
    }, [active]);
}
