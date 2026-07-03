/**
 * gitEssay — Gemini-style overflow toolbar (also reused by the top app bar).
 *
 * Wraps a row of items as DIRECT flex children (no wrappers), so the layout is
 * identical to a plain flex row. A layout effect measures each child's right
 * edge against the content width; children that don't fit get `display:none`
 * and a **⋮** button appears. Clicking ⋮ toggles `is-expanded` → the row
 * switches to `flex-wrap` so every item wraps onto further lines (Google-Docs
 * / Gemini behaviour).
 *
 * `buttonClassName` styles the ⋮ button (the formatting toolbar passes its
 * toolbar-item class; the app bar passes `app-bar-btn`). `dividerClassName`,
 * when given, also hides a trailing divider at the cut so no dangling separator
 * remains next to the ⋮ button.
 *
 * Measurement is imperative (inline styles), and only re-runs when the row is
 * resized, the child set changes, or expand is toggled — not on every state
 * update (e.g. active bold), so it is cheap during typing.
 */
import {type JSX, type ReactNode, useLayoutEffect, useRef, useState} from 'react';

const OVERFLOW_BTN_W = 40;

export default function OverflowToolbar({
  className,
  buttonClassName = 'toolbar-item spaced tb-overflow',
  moreLabel = 'More',
  lessLabel = 'Collapse',
  dividerClassName,
  children,
}: {
  className?: string;
  buttonClassName?: string;
  moreLabel?: string;
  lessLabel?: string;
  /** Class that marks a divider child (so a trailing one can be hidden at the cut). */
  dividerClassName?: string;
  children: ReactNode;
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [, setTick] = useState(0);

  const isDivider = (el: HTMLElement): boolean =>
    !!dividerClassName && el.classList.contains(dividerClassName);

  // Re-measure whenever the row is resized (e.g. a sidebar opens/closes).
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    const ro = new ResizeObserver(() => setTick(t => t + 1));
    ro.observe(row);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    const btn = btnRef.current;
    const kids = Array.from(row.children).filter(
      n => n !== btn,
    ) as HTMLElement[];

    if (expanded) {
      kids.forEach(k => {
        k.style.display = '';
      });
      if (btn) {
        btn.style.display = '';
      }
      return;
    }

    // Measure with everything visible and the ⋮ button hidden.
    kids.forEach(k => {
      k.style.display = '';
    });
    if (btn) {
      btn.style.display = 'none';
    }
    const cs = getComputedStyle(row);
    const avail =
      row.clientWidth -
      parseFloat(cs.paddingLeft || '0') -
      parseFloat(cs.paddingRight || '0');
    const rights = kids.map(k => k.offsetLeft + k.offsetWidth);
    const total = rights.length ? rights[rights.length - 1] : 0;

    let cut = kids.length;
    let overflow = false;
    if (total > avail) {
      overflow = true;
      cut = 0;
      for (let i = 0; i < rights.length; i++) {
        if (rights[i] + OVERFLOW_BTN_W <= avail) {
          cut = i + 1;
        } else {
          break;
        }
      }
    }

    for (let i = cut; i < kids.length; i++) {
      kids[i].style.display = 'none';
    }
    // Hide a trailing divider at the cut so it doesn't dangle beside the ⋮.
    for (let i = cut - 1; i >= 0 && isDivider(kids[i]); i--) {
      kids[i].style.display = 'none';
    }
    if (btn) {
      btn.style.display = overflow ? '' : 'none';
    }
  });

  return (
    <div
      ref={rowRef}
      className={`${className ?? ''}${expanded ? ' is-expanded' : ''}`}>
      {children}
      <button
        ref={btnRef}
        type="button"
        className={buttonClassName}
        title={expanded ? lessLabel : moreLabel}
        aria-label={expanded ? lessLabel : moreLabel}
        onClick={() => setExpanded(e => !e)}>
        <span className="tb-overflow-glyph">{expanded ? '▴' : '⋮'}</span>
      </button>
    </div>
  );
}

