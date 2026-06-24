/**
 * gitEssay — scroll trap for a scroll surface (side dock or compare overlay).
 *
 * Returns a callback ref. Attach it to the surface root. The element under the
 * cursor scrolls; at its boundary (or over a non-scrollable part of the surface,
 * like a header/bar/composer) the event is cancelled so it never chains to the
 * page / another surface / the editor; over a non-scroll area the surface's
 * primary scroll area is scrolled instead. Using a callback ref (rather than a
 * useLayoutEffect on a ref object) means it also attaches correctly to elements
 * that mount late (e.g. the compare surface, which only renders when active).
 */
import {useCallback, useRef} from 'react';

function isScrollable(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  return (
    (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
    el.scrollHeight > el.clientHeight
  );
}

function findPrimaryScroller(root: HTMLElement): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (isScrollable(el)) {
      return el;
    }
  }
  return null;
}

export function useScrollTrap(): (el: HTMLElement | null) => void {
  const cleanupRef = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!el) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      // Is there a scrollable element directly under the cursor (target → root)?
      let node = e.target as HTMLElement | null;
      let scroller: HTMLElement | null = null;
      while (node && node !== el) {
        if (isScrollable(node)) {
          scroller = node;
          break;
        }
        node = node.parentElement;
      }
      const direct = scroller !== null;
      if (!scroller) {
        scroller = findPrimaryScroller(el);
      }
      if (!scroller) {
        e.preventDefault();
        return;
      }
      const atTop = scroller.scrollTop <= 0;
      const atBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      const blocked =
        (e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom);
      if (direct) {
        if (blocked) {
          e.preventDefault();
        }
      } else {
        if (!blocked) {
          scroller.scrollTop += e.deltaY;
        }
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    cleanupRef.current = () => el.removeEventListener('wheel', onWheel);
  }, []);
}
